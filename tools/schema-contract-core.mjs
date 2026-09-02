import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

export const READ_ONLY_SCHEMA_QUERIES = Object.freeze({
  runtime: `SELECT VERSION() AS version, @@SESSION.sql_mode AS sql_mode,
                   @@SESSION.time_zone AS time_zone, DATABASE() AS database_name`,
  columns: `SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE,
                   IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (__TABLE_PLACEHOLDERS__)
             ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  indexes: `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
                   SUB_PART, COLLATION, INDEX_TYPE
              FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (__TABLE_PLACEHOLDERS__)
             ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
  tableOptions: `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
                   FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (__TABLE_PLACEHOLDERS__)
                  ORDER BY TABLE_NAME`,
  checks: `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
             FROM information_schema.TABLE_CONSTRAINTS AS tc
             JOIN information_schema.CHECK_CONSTRAINTS AS cc
               ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
              AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              AND cc.TABLE_NAME = tc.TABLE_NAME
            WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
              AND tc.CONSTRAINT_TYPE = 'CHECK'
              AND tc.TABLE_NAME IN (__TABLE_PLACEHOLDERS__)
            ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
  foreignKeys: `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
                       k.ORDINAL_POSITION, k.REFERENCED_TABLE_NAME,
                       k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
                  FROM information_schema.KEY_COLUMN_USAGE AS k
                  JOIN information_schema.REFERENTIAL_CONSTRAINTS AS r
                    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
                   AND r.TABLE_NAME = k.TABLE_NAME
                   AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.CONSTRAINT_SCHEMA = DATABASE()
                   AND k.REFERENCED_TABLE_NAME IS NOT NULL
                   AND k.TABLE_NAME IN (__TABLE_PLACEHOLDERS__)
                 ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
});

export async function loadRequiredSchemaContract(projectRoot) {
  const contractPath = resolve(projectRoot, "config/required-schema-contract.json");
  const contractBytes = await readBoundProjectFile(projectRoot, contractPath);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  if (contract?.schemaVersion !== 1 || typeof contract?.contractId !== "string") {
    throw new Error("SCHEMA_CONTRACT_INVALID");
  }

  const baselinePath = resolveProjectChild(projectRoot, contract.legacyBaseline?.file);
  const baselineBytes = await readBoundProjectFile(projectRoot, baselinePath);
  assertDigest(baselineBytes, contract.legacyBaseline?.sha256, "SCHEMA_BASELINE_DIGEST_MISMATCH");
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  const tables = buildBaselineTables(baseline);

  for (const [tableName, addition] of Object.entries(contract.additions ?? {})) {
    const table = tables[tableName] ?? { columns: {}, indexes: {}, checks: {} };
    for (const [columnName, shape] of Object.entries(addition.columns ?? {})) {
      table.columns[columnName] = normalizeRequiredColumnShape(shape);
    }
    for (const [indexName, shape] of Object.entries(addition.indexes ?? {})) {
      table.indexes[indexName] = normalizeRequiredIndexShape(shape);
    }
    tables[tableName] = table;
  }

  for (const source of contract.sources ?? []) {
    if (typeof source.file !== "string") continue;
    const bytes = await readBoundProjectFile(projectRoot, resolveProjectChild(projectRoot, source.file));
    assertDigest(bytes, source.sha256, "SCHEMA_SOURCE_DIGEST_MISMATCH");
    if (typeof source.proves === "string" && Object.hasOwn(tables, source.proves)) {
      const createContract = extractCreateTableContract(bytes.toString("utf8"), source.proves);
      if (createContract !== null) {
        tables[source.proves].engine = createContract.engine;
        tables[source.proves].checks = createContract.checks;
      }
    }
  }

  for (const [tableName, engine] of Object.entries(contract.requiredTableEngines ?? {})) {
    const table = tables[tableName];
    if (table === undefined || typeof engine !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(engine)) {
      throw new Error("SCHEMA_REQUIRED_ENGINE_RULE_INVALID");
    }
    if (typeof table.engine === "string" && table.engine.toLowerCase() !== engine.toLowerCase()) {
      throw new Error("SCHEMA_REQUIRED_ENGINE_SOURCE_CONFLICT");
    }
    table.engine = engine;
  }

  return {
    contractId: contract.contractId,
    contractSha256: sha256(contractBytes),
    runtimeVersionPattern: contract.runtimeVersionPattern,
    requiredSqlModes: [...(contract.requiredSqlModes ?? [])],
    allowAdditionalTables: contract.allowAdditionalTables === true,
    tables,
    foreignKeys: (contract.foreignKeys ?? []).map(normalizeRequiredForeignKey),
    knownBoundaries: [...(contract.knownBoundaries ?? [])],
  };
}

export function validateSchemaSnapshot({ snapshot, required, targetId, source }) {
  if (!TARGET_ID_PATTERN.test(targetId)) throw new Error("SCHEMA_TARGET_ID_INVALID");
  const findings = [];
  const warnings = [];

  if (snapshot?._meta?.secrets_included !== false
      || snapshot?._meta?.private_setting_values_included !== false) {
    addFinding(findings, "SANITIZATION_ATTESTATION_MISSING", "snapshot._meta",
      "secrets_included=false and private_setting_values_included=false", "missing or not false");
  }
  if (source.kind === "sanitized-information-schema-snapshot"
      && source.targetBinding !== "snapshot-metadata") {
    addFinding(findings, "TARGET_BINDING_NOT_PROVEN", "snapshot._meta.target_id",
      targetId, "missing");
  }

  const runtimeVersion = String(snapshot?.runtime?.version ?? "");
  let runtimePattern;
  try {
    runtimePattern = new RegExp(required.runtimeVersionPattern);
  } catch {
    throw new Error("SCHEMA_RUNTIME_PATTERN_INVALID");
  }
  if (!runtimePattern.test(runtimeVersion)) {
    addFinding(findings, "RUNTIME_VERSION_MISMATCH", "runtime.version",
      required.runtimeVersionPattern, runtimeVersion || "missing");
  }
  const sqlModes = new Set(String(snapshot?.runtime?.sql_mode ?? "")
    .split(",").map((mode) => mode.trim()).filter(Boolean));
  for (const requiredMode of required.requiredSqlModes) {
    if (!sqlModes.has(requiredMode)) {
      addFinding(findings, "RUNTIME_SQL_MODE_MISSING", "runtime.sql_mode",
        requiredMode, [...sqlModes].join(",") || "missing");
    }
  }
  if (typeof snapshot?.runtime?.time_zone !== "string" || snapshot.runtime.time_zone.trim() === "") {
    addFinding(findings, "RUNTIME_TIME_ZONE_MISSING", "runtime.time_zone",
      "captured non-empty session time zone", "missing");
  }

  const actualColumns = groupColumns(Array.isArray(snapshot?.columns) ? snapshot.columns : []);
  const actualIndexes = groupIndexes(Array.isArray(snapshot?.indexes) ? snapshot.indexes : []);
  const actualTableOptions = groupTableOptions(
    Array.isArray(snapshot?.tableOptions) ? snapshot.tableOptions : [],
  );
  const actualChecks = groupChecks(Array.isArray(snapshot?.checks) ? snapshot.checks : []);
  const actualForeignKeys = groupForeignKeys(
    Array.isArray(snapshot?.foreignKeys) ? snapshot.foreignKeys
      : Array.isArray(snapshot?.foreign_keys) ? snapshot.foreign_keys : [],
  );

  for (const [tableName, requiredTable] of Object.entries(required.tables)) {
    const tableColumns = actualColumns.get(tableName);
    if (!tableColumns) {
      addFinding(findings, "REQUIRED_TABLE_MISSING", tableName, "table present", "missing");
      continue;
    }
    for (const [columnName, expected] of Object.entries(requiredTable.columns)) {
      const subject = `${tableName}.${columnName}`;
      const actual = tableColumns.get(columnName);
      if (!actual) {
        addFinding(findings, "REQUIRED_COLUMN_MISSING", subject, formatColumn(expected), "missing");
        continue;
      }
      const actualShape = normalizeActualColumnShape(actual);
      if (!sameColumnShape(actualShape, expected)) {
        addFinding(findings, "COLUMN_SHAPE_MISMATCH", subject,
          formatColumn(expected), formatColumn(actualShape));
      }
    }

    const tableIndexes = actualIndexes.get(tableName) ?? new Map();
    for (const [indexName, expected] of Object.entries(requiredTable.indexes)) {
      const actual = tableIndexes.get(indexName);
      if (!actual) {
        addFinding(findings, "REQUIRED_INDEX_MISSING", `${tableName}.${indexName}`,
          formatIndex(expected), "missing");
      } else if (!sameIndexShape(actual, expected)) {
        addFinding(findings, "INDEX_SHAPE_MISMATCH", `${tableName}.${indexName}`,
          formatIndex(expected), formatIndex(actual));
      }
    }
    if (typeof requiredTable.engine === "string") {
      const actualEngine = actualTableOptions.get(tableName)?.engine ?? "missing";
      if (actualEngine.toLowerCase() !== requiredTable.engine.toLowerCase()) {
        addFinding(findings, "TABLE_ENGINE_MISMATCH", tableName, requiredTable.engine, actualEngine);
      }
    }
    const tableChecks = actualChecks.get(tableName) ?? new Map();
    for (const [checkName, expectedClause] of Object.entries(requiredTable.checks ?? {})) {
      const actualClause = tableChecks.get(checkName);
      if (actualClause === undefined) {
        addFinding(findings, "REQUIRED_CHECK_MISSING", `${tableName}.${checkName}`,
          expectedClause, "missing");
      } else if (normalizeCheckClause(actualClause) !== expectedClause) {
        addFinding(findings, "CHECK_CLAUSE_MISMATCH", `${tableName}.${checkName}`,
          expectedClause, normalizeCheckClause(actualClause));
      }
    }
  }

  for (const expected of required.foreignKeys) {
    const key = `${expected.table}.${expected.name}`;
    const actual = actualForeignKeys.get(key);
    if (!actual) {
      addFinding(findings, "REQUIRED_FOREIGN_KEY_MISSING", key, formatForeignKey(expected), "missing");
    } else if (!sameForeignKeyShape(actual, expected)) {
      addFinding(findings, "FOREIGN_KEY_SHAPE_MISMATCH", key,
        formatForeignKey(expected), formatForeignKey(actual));
    }
  }

  if (!required.allowAdditionalTables) {
    const requiredNames = new Set(Object.keys(required.tables));
    for (const tableName of actualColumns.keys()) {
      if (!requiredNames.has(tableName)) warnings.push(`Additional table not covered by contract: ${tableName}`);
    }
  }

  const result = findings.length === 0 ? "VERIFIED" : "NOT VERIFIED";
  return {
    schemaVersion: 1,
    operation: "read-only-schema-compatibility",
    checkedAtUtc: new Date().toISOString(),
    contract: {
      id: required.contractId,
      sha256: required.contractSha256,
    },
    target: {
      id: targetId,
      binding: source.targetBinding,
      ...(source.hostSha256 ? { hostSha256: source.hostSha256 } : {}),
      ...(source.databaseSha256 ? { databaseSha256: source.databaseSha256 } : {}),
    },
    source: {
      kind: source.kind,
      sha256: source.sha256,
      ...(source.snapshotPath ? { path: source.snapshotPath } : {}),
    },
    result,
    summary: {
      requiredTables: Object.keys(required.tables).length,
      requiredColumns: Object.values(required.tables)
        .reduce((total, table) => total + Object.keys(table.columns).length, 0),
      requiredIndexes: Object.values(required.tables)
        .reduce((total, table) => total + Object.keys(table.indexes).length, 0),
      requiredForeignKeys: required.foreignKeys.length,
      requiredChecks: Object.values(required.tables)
        .reduce((total, table) => total + Object.keys(table.checks ?? {}).length, 0),
      blockers: findings.length,
      warnings: warnings.length,
    },
    findings,
    warnings,
    boundaries: [...required.knownBoundaries],
  };
}

export async function collectMariaDbSnapshot(connection, requiredTableNames) {
  const tableNames = [...requiredTableNames].sort();
  if (tableNames.length === 0) throw new Error("SCHEMA_TABLE_SET_EMPTY");
  const placeholders = tableNames.map(() => "?").join(",");
  const query = (template) => template.replace("__TABLE_PLACEHOLDERS__", placeholders);

  const [runtimeRows] = await connection.execute(READ_ONLY_SCHEMA_QUERIES.runtime);
  const [columns] = await connection.execute(query(READ_ONLY_SCHEMA_QUERIES.columns), tableNames);
  const [indexes] = await connection.execute(query(READ_ONLY_SCHEMA_QUERIES.indexes), tableNames);
  const [tableOptions] = await connection.execute(query(READ_ONLY_SCHEMA_QUERIES.tableOptions), tableNames);
  const [checks] = await connection.execute(query(READ_ONLY_SCHEMA_QUERIES.checks), tableNames);
  const [foreignKeys] = await connection.execute(query(READ_ONLY_SCHEMA_QUERIES.foreignKeys), tableNames);
  const runtime = Array.isArray(runtimeRows) ? runtimeRows[0] : undefined;
  if (!runtime || typeof runtime !== "object") throw new Error("SCHEMA_RUNTIME_READ_FAILED");

  return {
    _meta: {
      source: "explicit read-only MariaDB information_schema inspection",
      secrets_included: false,
      private_setting_values_included: false,
    },
    runtime: {
      version: runtime.version,
      sql_mode: runtime.sql_mode,
      time_zone: runtime.time_zone,
      database_name: runtime.database_name,
    },
    columns,
    indexes,
    tableOptions,
    checks,
    foreignKeys,
  };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function withSchemaQueryDeadline(operation, timeoutMs, onTimeout) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return Promise.reject(new Error("SCHEMA_DATABASE_QUERY_TIMEOUT_INVALID"));
  }
  return new Promise((resolveQuery, rejectQuery) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      rejectQuery(new Error("SCHEMA_DATABASE_QUERY_TIMEOUT"));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveQuery(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectQuery(error instanceof Error ? error : new Error("SCHEMA_DATABASE_QUERY_FAILED"));
      },
    );
  });
}

function buildBaselineTables(baseline) {
  const tables = {};
  for (const row of Array.isArray(baseline?.columns) ? baseline.columns : []) {
    const tableName = String(row.TABLE_NAME ?? "");
    const columnName = String(row.COLUMN_NAME ?? "");
    if (!tableName || !columnName) continue;
    const table = tables[tableName] ?? { columns: {}, indexes: {}, checks: {} };
    table.columns[columnName] = normalizeActualColumnShape(row);
    tables[tableName] = table;
  }
  for (const [tableName, indexes] of groupIndexes(Array.isArray(baseline?.indexes) ? baseline.indexes : [])) {
    const table = tables[tableName] ?? { columns: {}, indexes: {}, checks: {} };
    for (const [indexName, shape] of indexes) table.indexes[indexName] = shape;
    tables[tableName] = table;
  }
  if (Object.keys(tables).length === 0) throw new Error("SCHEMA_BASELINE_EMPTY");
  return tables;
}

function groupColumns(rows) {
  const result = new Map();
  for (const row of rows) {
    const tableName = String(row?.TABLE_NAME ?? row?.tableName ?? "");
    const columnName = String(row?.COLUMN_NAME ?? row?.columnName ?? "");
    if (!tableName || !columnName) continue;
    const table = result.get(tableName) ?? new Map();
    table.set(columnName, row);
    result.set(tableName, table);
  }
  return result;
}

function groupIndexes(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const tableName = String(row?.TABLE_NAME ?? row?.tableName ?? "");
    const indexName = String(row?.INDEX_NAME ?? row?.indexName ?? "");
    const columnName = String(row?.COLUMN_NAME ?? row?.columnName ?? "");
    if (!tableName || !indexName || !columnName) continue;
    const table = grouped.get(tableName) ?? new Map();
    const index = table.get(indexName) ?? {
      unique: Number(row?.NON_UNIQUE ?? row?.nonUnique) === 0,
      parts: [],
    };
    index.parts.push({
      position: Number(row?.SEQ_IN_INDEX ?? row?.seqInIndex),
      column: columnName,
      subPart: normalizeOptionalNumber(row?.SUB_PART ?? row?.subPart),
    });
    table.set(indexName, index);
    grouped.set(tableName, table);
  }
  for (const table of grouped.values()) {
    for (const [name, index] of table) {
      index.parts.sort((left, right) => left.position - right.position);
      table.set(name, {
        unique: index.unique,
        columns: index.parts.map((part) => part.subPart === null
          ? part.column : [part.column, part.subPart]),
      });
    }
  }
  return grouped;
}

function groupTableOptions(rows) {
  const result = new Map();
  for (const row of rows) {
    const tableName = String(row?.TABLE_NAME ?? row?.tableName ?? "");
    const engine = String(row?.ENGINE ?? row?.engine ?? "");
    if (!tableName || !engine) continue;
    result.set(tableName, {
      engine,
      collation: String(row?.TABLE_COLLATION ?? row?.tableCollation ?? ""),
    });
  }
  return result;
}

function groupChecks(rows) {
  const result = new Map();
  for (const row of rows) {
    const tableName = String(row?.TABLE_NAME ?? row?.tableName ?? "");
    const name = String(row?.CONSTRAINT_NAME ?? row?.name ?? "").toLowerCase();
    const clause = String(row?.CHECK_CLAUSE ?? row?.checkClause ?? "");
    if (!tableName || !name || !clause) continue;
    const table = result.get(tableName) ?? new Map();
    table.set(name, clause);
    result.set(tableName, table);
  }
  return result;
}

function extractCreateTableContract(sql, tableName) {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const createPattern = "CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+" + escaped + "\\s*\\(";
  if (!new RegExp(createPattern, "i").test(sql)) {
    return null;
  }
  const engine = /\)\s*ENGINE\s*=\s*([A-Za-z0-9_]+)/i.exec(sql)?.[1];
  if (!engine) throw new Error("SCHEMA_SOURCE_TABLE_ENGINE_MISSING");
  const checks = {};
  const pattern = /CONSTRAINT\s+`?([A-Za-z0-9_]+)`?\s+CHECK\s*\(/gi;
  for (let match = pattern.exec(sql); match !== null; match = pattern.exec(sql)) {
    const name = match[1].toLowerCase();
    let depth = 1;
    let quoted = false;
    let end = -1;
    for (let index = pattern.lastIndex; index < sql.length; index += 1) {
      const character = sql[index];
      if (character === "'") {
        if (quoted && sql[index + 1] === "'") {
          index += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0 || Object.hasOwn(checks, name)) throw new Error("SCHEMA_SOURCE_CHECK_INVALID");
    checks[name] = normalizeCheckClause(sql.slice(pattern.lastIndex, end));
    pattern.lastIndex = end + 1;
  }
  if (Object.keys(checks).length === 0) throw new Error("SCHEMA_SOURCE_CHECK_MISSING");
  return { engine, checks };
}

function normalizeCheckClause(value) {
  let clause = "";
  let quoted = false;
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      clause += character;
      if (quoted && source[index + 1] === "'") {
        clause += source[index + 1];
        index += 1;
        continue;
      }
      quoted = !quoted;
    } else if (quoted) {
      // CHECK literals are data under ascii_bin semantics. Never lowercase or
      // collapse them while normalizing SQL tokens around them.
      clause += character;
    } else if (character === "`" || /\s/.test(character)) {
      continue;
    } else {
      clause += character.toLowerCase();
    }
  }
  if (quoted) throw new Error("SCHEMA_CHECK_CLAUSE_INVALID");
  while (clause.startsWith("(") && clause.endsWith(")") && outerParenthesesWrapAll(clause)) {
    clause = clause.slice(1, -1);
  }
  return clause;
}

function outerParenthesesWrapAll(value) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0 && !quoted;
}

function groupForeignKeys(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const table = String(row?.TABLE_NAME ?? row?.table ?? "");
    const name = String(row?.CONSTRAINT_NAME ?? row?.name ?? "");
    if (!table || !name) continue;
    const key = `${table}.${name}`;
    const item = grouped.get(key) ?? {
      name,
      table,
      referencedTable: String(row?.REFERENCED_TABLE_NAME ?? row?.referencedTable ?? ""),
      deleteRule: String(row?.DELETE_RULE ?? row?.deleteRule ?? "").toUpperCase(),
      updateRule: String(row?.UPDATE_RULE ?? row?.updateRule ?? "").toUpperCase(),
      parts: [],
    };
    item.parts.push({
      position: Number(row?.ORDINAL_POSITION ?? row?.ordinalPosition),
      column: String(row?.COLUMN_NAME ?? row?.column ?? ""),
      referencedColumn: String(row?.REFERENCED_COLUMN_NAME ?? row?.referencedColumn ?? ""),
    });
    grouped.set(key, item);
  }
  for (const [key, item] of grouped) {
    item.parts.sort((left, right) => left.position - right.position);
    grouped.set(key, {
      name: item.name,
      table: item.table,
      columns: item.parts.map((part) => part.column),
      referencedTable: item.referencedTable,
      referencedColumns: item.parts.map((part) => part.referencedColumn),
      deleteRule: item.deleteRule,
      updateRule: item.updateRule,
    });
  }
  return grouped;
}

function normalizeActualColumnShape(row) {
  return [
    normalizeSqlType(row?.COLUMN_TYPE ?? row?.columnType),
    String(row?.IS_NULLABLE ?? row?.isNullable).toUpperCase() === "YES"
      || row?.nullable === true,
    normalizeCollation(row?.COLLATION_NAME ?? row?.collation),
    normalizeDefault(row?.COLUMN_DEFAULT ?? row?.columnDefault),
    normalizeExtra(row?.EXTRA ?? row?.extra),
  ];
}

function normalizeRequiredColumnShape(shape) {
  if (!Array.isArray(shape) || shape.length !== 5) throw new Error("SCHEMA_COLUMN_RULE_INVALID");
  return [normalizeSqlType(shape[0]), shape[1] === true, normalizeCollation(shape[2]),
    normalizeDefault(shape[3]), normalizeExtra(shape[4])];
}

function normalizeRequiredIndexShape(shape) {
  if (!shape || typeof shape !== "object" || !Array.isArray(shape.columns)) {
    throw new Error("SCHEMA_INDEX_RULE_INVALID");
  }
  return {
    unique: shape.unique === true,
    columns: shape.columns.map((part) => Array.isArray(part)
      ? [String(part[0]), Number(part[1])] : String(part)),
  };
}

function normalizeRequiredForeignKey(item) {
  return {
    name: String(item.name),
    table: String(item.table),
    columns: item.columns.map(String),
    referencedTable: String(item.referencedTable),
    referencedColumns: item.referencedColumns.map(String),
    deleteRule: String(item.deleteRule).toUpperCase(),
    updateRule: String(item.updateRule).toUpperCase(),
  };
}

function sameColumnShape(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameIndexShape(left, right) {
  return left.unique === right.unique && JSON.stringify(left.columns) === JSON.stringify(right.columns);
}

function sameForeignKeyShape(left, right) {
  return left.table === right.table
    && left.name === right.name
    && JSON.stringify(left.columns) === JSON.stringify(right.columns)
    && left.referencedTable === right.referencedTable
    && JSON.stringify(left.referencedColumns) === JSON.stringify(right.referencedColumns)
    && left.deleteRule === right.deleteRule
    && left.updateRule === right.updateRule;
}

function formatColumn(shape) {
  return JSON.stringify({
    type: shape[0], nullable: shape[1], collation: shape[2], default: shape[3], extra: shape[4],
  });
}

function formatIndex(shape) {
  return JSON.stringify({ unique: shape.unique, columns: shape.columns });
}

function formatForeignKey(shape) {
  return JSON.stringify({
    columns: shape.columns,
    referencedTable: shape.referencedTable,
    referencedColumns: shape.referencedColumns,
    deleteRule: shape.deleteRule,
    updateRule: shape.updateRule,
  });
}

function addFinding(findings, code, subject, expected, actual) {
  findings.push({ severity: "BLOCKER", code, subject, expected, actual });
}

function normalizeSqlType(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCollation(value) {
  return value === null || value === undefined || value === "" ? null : String(value).toLowerCase();
}

function normalizeDefault(value) {
  if (value === null || value === undefined || String(value).toUpperCase() === "NULL") return null;
  const text = String(value);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

function normalizeExtra(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionalNumber(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

async function readBoundProjectFile(projectRoot, path) {
  const bounded = resolveProjectChild(projectRoot, relative(projectRoot, path));
  const stats = await lstat(bounded);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("SCHEMA_SOURCE_FILE_UNSAFE");
  return readFile(bounded);
}

function resolveProjectChild(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("SCHEMA_SOURCE_PATH_INVALID");
  }
  const root = resolve(projectRoot);
  const child = resolve(root, relativePath);
  const relation = relative(root, child);
  if (relation === "" || relation.startsWith("..") || resolve(root, relation) !== child) {
    throw new Error("SCHEMA_SOURCE_PATH_OUTSIDE_PROJECT");
  }
  return child;
}

function assertDigest(bytes, expected, code) {
  if (!/^[0-9a-f]{64}$/.test(String(expected)) || sha256(bytes) !== expected) throw new Error(code);
}
