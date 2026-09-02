import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_SCHEMA_QUERIES,
  collectMariaDbSnapshot,
  loadRequiredSchemaContract,
  validateSchemaSnapshot,
  withSchemaQueryDeadline,
  type ForeignKeyShape,
  type RequiredSchemaContract,
} from "../tools/schema-contract-core.mjs";
import { runtimeSchemaContractId } from "../src/infrastructure/mysql-runtime-readiness-store.js";

const projectRoot = resolve(import.meta.dirname, "..");

interface ColumnRow {
  TABLE_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
  COLLATION_NAME: string | null;
}

interface IndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: 0 | 1;
  SEQ_IN_INDEX: number;
  COLUMN_NAME: string;
  SUB_PART: number | null;
}

interface TableOptionRow {
  TABLE_NAME: string;
  ENGINE: string;
  TABLE_COLLATION: string;
}

interface CheckRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  CHECK_CLAUSE: string;
}

describe("read-only MariaDB schema contract", () => {
  it("bounds a live information-schema query and invokes connection teardown", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const pending = withSchemaQueryDeadline(new Promise<never>(() => undefined), 100, destroy);
    const assertion = expect(pending).rejects.toThrow("SCHEMA_DATABASE_QUERY_TIMEOUT");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("expands the hash-bound legacy evidence and Node additions", async () => {
    const required = await loadRequiredSchemaContract(projectRoot);
    expect(Object.keys(required.tables)).toHaveLength(18);
    expect(required.tables.links?.columns.recent_activity_epochs)
      .toEqual(["longtext", true, "ascii_bin", null, ""]);
    expect(required.tables.domains?.columns).toMatchObject({
      domain_key: ["varchar(32)", false, "ascii_bin", null, ""],
      report_timezone: ["varchar(64)", false, "ascii_bin", null, ""],
      diversion_campaign: ["varchar(32)", false, "ascii_bin", null, ""],
    });
    expect(required.tables.image_job_ledger_v1?.indexes.uq_image_job_ledger_output)
      .toEqual({ unique: true, columns: ["output_storage_key"] });
    expect(required.tables.image_job_ledger_v1?.engine).toBe("InnoDB");
    for (const tableName of [
      "links",
      "uploaded_images",
      "users",
      "remember_tokens",
      "settings",
      "domain_settings",
      "geo_rules",
      "diversion_history_10m",
    ]) {
      expect(required.tables[tableName]?.engine, tableName).toBe("InnoDB");
    }
    expect(Object.keys(required.tables.image_job_ledger_v1?.checks ?? {})).toHaveLength(18);
    expect(required.foreignKeys.find((key) => key.name === "fk_uploaded_images_user"))
      .toMatchObject({ deleteRule: "RESTRICT", referencedTable: "users" });
    expect(required.requiredSqlModes).toEqual(["STRICT_TRANS_TABLES", "NO_ENGINE_SUBSTITUTION"]);
  });

  it("accepts a complete synthetic information_schema capture", async () => {
    const required = await loadRequiredSchemaContract(projectRoot);
    const receipt = validate(required, compatibleSnapshot(required));
    expect(receipt.result).toBe("VERIFIED");
    expect(receipt.summary).toMatchObject({
      blockers: 0,
      requiredTables: 18,
      requiredForeignKeys: 12,
      requiredChecks: 18,
    });
  });

  it("keeps the historical snapshot NOT VERIFIED instead of inferring the Node schema", async () => {
    const required = await loadRequiredSchemaContract(projectRoot);
    const snapshot = JSON.parse(await readFile(
      resolve(projectRoot, "evidence/current-schema-sanitized.json"), "utf8",
    )) as Record<string, unknown>;
    const receipt = validate(required, snapshot);
    expect(receipt.result).toBe("NOT VERIFIED");
    expect(receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REQUIRED_COLUMN_MISSING", subject: "links.recent_activity_epochs" }),
      expect.objectContaining({ code: "REQUIRED_TABLE_MISSING", subject: "image_job_ledger_v1" }),
      expect.objectContaining({ code: "REQUIRED_FOREIGN_KEY_MISSING", subject: "uploaded_images.fk_uploaded_images_user" }),
    ]));
  });

  it("rejects wrong compact-history, Delivered-state, ledger-index and FK shapes", async () => {
    const required = await loadRequiredSchemaContract(projectRoot);
    const snapshot = compatibleSnapshot(required);
    const columns = snapshot.columns;
    const recent = columns.find((row) => row.TABLE_NAME === "links" && row.COLUMN_NAME === "recent_activity_epochs");
    const delivered = columns.find((row) => row.TABLE_NAME === "delivered_country_10m_state" && row.COLUMN_NAME === "status");
    if (!recent || !delivered) throw new Error("fixture incomplete");
    recent.COLLATION_NAME = "utf8mb4_general_ci";
    delivered.COLUMN_TYPE = "varchar(32)";
    snapshot.indexes = snapshot.indexes.filter((row) => !(
      row.TABLE_NAME === "image_job_ledger_v1" && row.INDEX_NAME === "uq_image_job_ledger_output"
    ));
    snapshot.foreignKeys = snapshot.foreignKeys.filter((row) => row.CONSTRAINT_NAME !== "fk_uploaded_images_user");
    const ledgerOptions = snapshot.tableOptions.find((row) => row.TABLE_NAME === "image_job_ledger_v1");
    if (!ledgerOptions) throw new Error("fixture table options incomplete");
    ledgerOptions.ENGINE = "MyISAM";
    snapshot.checks = snapshot.checks
      .filter((row) => row.CONSTRAINT_NAME !== "chk_image_job_state_shape")
      .map((row) => row.CONSTRAINT_NAME === "chk_image_job_attempts"
        ? { ...row, CHECK_CLAUSE: "attempt_count <= 65535" }
        : row.CONSTRAINT_NAME === "chk_image_job_error_code"
          ? { ...row, CHECK_CLAUSE: row.CHECK_CLAUSE.replace("[A-Z]", "[a-z]") }
        : row);

    const receipt = validate(required, snapshot);
    expect(receipt.result).toBe("NOT VERIFIED");
    expect(receipt.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COLUMN_SHAPE_MISMATCH", subject: "links.recent_activity_epochs" }),
      expect.objectContaining({ code: "COLUMN_SHAPE_MISMATCH", subject: "delivered_country_10m_state.status" }),
      expect.objectContaining({ code: "REQUIRED_INDEX_MISSING", subject: "image_job_ledger_v1.uq_image_job_ledger_output" }),
      expect.objectContaining({ code: "REQUIRED_FOREIGN_KEY_MISSING", subject: "uploaded_images.fk_uploaded_images_user" }),
      expect.objectContaining({ code: "TABLE_ENGINE_MISMATCH", subject: "image_job_ledger_v1" }),
      expect.objectContaining({ code: "REQUIRED_CHECK_MISSING", subject: "image_job_ledger_v1.chk_image_job_state_shape" }),
      expect.objectContaining({ code: "CHECK_CLAUSE_MISMATCH", subject: "image_job_ledger_v1.chk_image_job_attempts" }),
      expect.objectContaining({ code: "CHECK_CLAUSE_MISMATCH", subject: "image_job_ledger_v1.chk_image_job_error_code" }),
    ]));
  });

  it("rejects a non-transactional legacy table used inside Node transactions", async () => {
    const required = await loadRequiredSchemaContract(projectRoot);
    const snapshot = compatibleSnapshot(required);
    const uploads = snapshot.tableOptions.find((row) => row.TABLE_NAME === "uploaded_images");
    if (!uploads) throw new Error("fixture table options incomplete");
    uploads.ENGINE = "MyISAM";

    const receipt = validate(required, snapshot);
    expect(receipt.result).toBe("NOT VERIFIED");
    expect(receipt.findings).toContainEqual(expect.objectContaining({
      code: "TABLE_ENGINE_MISMATCH",
      subject: "uploaded_images",
      expected: "InnoDB",
      actual: "MyISAM",
    }));
  });

  it("contains SELECT-only live inspection statements", () => {
    const forbidden = /\b(?:INSERT|ALTER|DROP|CREATE|REPLACE|TRUNCATE|SET)\b/i;
    for (const sql of Object.values(READ_ONLY_SCHEMA_QUERIES)) {
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(forbidden);
    }
  });

  it("retains live table-engine and CHECK rows in the sanitized adapter snapshot", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        version: "10.11.18-MariaDB",
        sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
        time_zone: "UTC",
        database_name: "private_name",
      }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{
        TABLE_NAME: "image_job_ledger_v1",
        ENGINE: "InnoDB",
        TABLE_COLLATION: "utf8mb4_unicode_ci",
      }], []])
      .mockResolvedValueOnce([[{
        TABLE_NAME: "image_job_ledger_v1",
        CONSTRAINT_NAME: "chk_image_job_id",
        CHECK_CLAUSE: "job_id regexp '^[0-9a-f]{32}$'",
      }], []])
      .mockResolvedValueOnce([[], []]);
    const snapshot = await collectMariaDbSnapshot({ execute }, ["image_job_ledger_v1"]);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(snapshot).toMatchObject({
      tableOptions: [expect.objectContaining({ ENGINE: "InnoDB" })],
      checks: [expect.objectContaining({ CONSTRAINT_NAME: "chk_image_job_id" })],
    });
  });

  it("requires a target id and explicit connection environment before database access", () => {
    const tool = resolve(projectRoot, "tools/verify-schema-contract.mjs");
    const noTarget = spawnSync(process.execPath, [tool, "--snapshot=evidence/current-schema-sanitized.json"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(noTarget.status).toBe(2);
    expect(noTarget.stdout).toContain("SCHEMA_TARGET_ID_REQUIRED");

    const genericTarget = spawnSync(process.execPath, [
      tool,
      "--snapshot=evidence/current-schema-sanitized.json",
      "--target-id=default",
    ], { cwd: projectRoot, encoding: "utf8" });
    expect(genericTarget.status).toBe(2);
    expect(genericTarget.stdout).toContain("SCHEMA_TARGET_ID_INVALID");

    const missingOutput = spawnSync(process.execPath, [tool, "--database", "--target-id=disposable-test-1"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: withoutSchemaDatabaseEnvironment(process.env),
    });
    expect(missingOutput.status).toBe(2);
    expect(missingOutput.stdout).toContain("SCHEMA_SNAPSHOT_OUTPUT_REQUIRED");

    const noConnection = spawnSync(process.execPath, [
      tool,
      "--database",
      "--target-id=disposable-test-1",
      "--snapshot-output=private/schema-evidence/disposable-no-connection.json",
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: withoutSchemaDatabaseEnvironment(process.env),
    });
    expect(noConnection.status).toBe(2);
    expect(noConnection.stdout).toContain("SCHEMA_DATABASE_ENV_INCOMPLETE");
    expect(noConnection.stdout).not.toMatch(/password|@|3306/i);
  });

  it("accepts only unique private schema-evidence paths for live snapshots", () => {
    const tool = resolve(projectRoot, "tools/verify-schema-contract.mjs");
    for (const unsafe of [
      "evidence/live.json",
      "private/schema-evidence/../live.json",
      "private\\schema-evidence\\live.json",
      "private/schema-evidence/live.txt",
    ]) {
      const result = spawnSync(process.execPath, [
        tool,
        "--database",
        "--target-id=disposable-test-1",
        `--snapshot-output=${unsafe}`,
      ], {
        cwd: projectRoot,
        encoding: "utf8",
        env: withoutSchemaDatabaseEnvironment(process.env),
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("SCHEMA_SNAPSHOT_OUTPUT_INVALID");
    }
  });

  it("keeps an otherwise-compatible unbound snapshot NOT VERIFIED", async () => {
    const tool = resolve(projectRoot, "tools/verify-schema-contract.mjs");
    const required = await loadRequiredSchemaContract(projectRoot);
    const snapshot = compatibleSnapshot(required);
    const root = resolve(projectRoot, ".local-evidence", "schema-target-binding-test.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(root, JSON.stringify(snapshot), "utf8"));
    try {
      const result = spawnSync(process.execPath, [tool, `--snapshot=${root}`, "--target-id=exact-test-target-1"], {
        cwd: projectRoot,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("TARGET_BINDING_NOT_PROVEN");
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(root, { force: true }));
    }
  });

  it("ships only the proven forward ADD COLUMN delta", async () => {
    const sql = await readFile(resolve(projectRoot, "database/002_links_recent_activity_epochs.sql"), "utf8");
    const executable = sql.replace(/^\s*--.*$/gm, "");
    expect(executable).toMatch(/ALTER TABLE `links`[\s\S]+ADD COLUMN `recent_activity_epochs` LONGTEXT[\s\S]+CHARACTER SET ascii COLLATE ascii_bin NULL/i);
    expect(executable).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE|INSERT|REPLACE)\b/i);
  });

  it("keeps the contract, runtime readiness and manual marker migration on one exact id", async () => {
    const contract = JSON.parse(await readFile(
      resolve(projectRoot, "config/required-schema-contract.json"), "utf8",
    )) as { contractId?: unknown };
    const markerSql = await readFile(
      resolve(projectRoot, "database/003_runtime_schema_contract_marker.sql"), "utf8",
    );
    expect(contract.contractId).toBe(runtimeSchemaContractId);
    expect(markerSql).toContain(`'${runtimeSchemaContractId}'`);
  });
});

function validate(required: RequiredSchemaContract, snapshot: Record<string, unknown>) {
  return validateSchemaSnapshot({
    snapshot,
    required,
    targetId: "local-disposable-fixture",
    source: {
      kind: "sanitized-information-schema-snapshot",
      sha256: "a".repeat(64),
      targetBinding: "snapshot-metadata",
    },
  });
}

function compatibleSnapshot(required: RequiredSchemaContract): Record<string, unknown> & {
  columns: ColumnRow[];
  indexes: IndexRow[];
  tableOptions: TableOptionRow[];
  checks: CheckRow[];
  foreignKeys: ReturnType<typeof foreignKeyRows>;
} {
  const columns: ColumnRow[] = [];
  const indexes: IndexRow[] = [];
  const tableOptions: TableOptionRow[] = [];
  const checks: CheckRow[] = [];
  for (const [tableName, table] of Object.entries(required.tables)) {
    tableOptions.push({
      TABLE_NAME: tableName,
      ENGINE: table.engine ?? "InnoDB",
      TABLE_COLLATION: "utf8mb4_unicode_ci",
    });
    for (const [name, clause] of Object.entries(table.checks ?? {})) {
      checks.push({ TABLE_NAME: tableName, CONSTRAINT_NAME: name, CHECK_CLAUSE: clause });
    }
    let ordinal = 0;
    for (const [columnName, shape] of Object.entries(table.columns)) {
      ordinal += 1;
      columns.push({
        TABLE_NAME: tableName,
        ORDINAL_POSITION: ordinal,
        COLUMN_NAME: columnName,
        COLUMN_TYPE: shape[0],
        IS_NULLABLE: shape[1] ? "YES" : "NO",
        COLLATION_NAME: shape[2],
        COLUMN_DEFAULT: shape[3],
        EXTRA: shape[4],
      });
    }
    for (const [indexName, shape] of Object.entries(table.indexes)) {
      shape.columns.forEach((part, index) => {
        const [name, subPart] = Array.isArray(part) ? part : [part, null];
        indexes.push({
          TABLE_NAME: tableName,
          INDEX_NAME: indexName,
          NON_UNIQUE: shape.unique ? 0 : 1,
          SEQ_IN_INDEX: index + 1,
          COLUMN_NAME: name,
          SUB_PART: subPart,
        });
      });
    }
  }
  return {
    _meta: { secrets_included: false, private_setting_values_included: false },
    runtime: {
      version: "10.11.18-MariaDB",
      sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
      time_zone: "UTC",
    },
    columns,
    indexes,
    tableOptions,
    checks,
    foreignKeys: foreignKeyRows(required.foreignKeys),
  };
}

function foreignKeyRows(keys: ForeignKeyShape[]) {
  return keys.flatMap((key) => key.columns.map((column, index) => ({
    TABLE_NAME: key.table,
    CONSTRAINT_NAME: key.name,
    COLUMN_NAME: column,
    ORDINAL_POSITION: index + 1,
    REFERENCED_TABLE_NAME: key.referencedTable,
    REFERENCED_COLUMN_NAME: key.referencedColumns[index] ?? "",
    DELETE_RULE: key.deleteRule,
    UPDATE_RULE: key.updateRule,
  })));
}

function withoutSchemaDatabaseEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("SCHEMA_VERIFY_DB_")));
}
