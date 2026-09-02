#!/usr/bin/env node

import { createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  collectMariaDbSnapshot,
  loadRequiredSchemaContract,
  sha256,
  validateSchemaSnapshot,
  withSchemaQueryDeadline,
} from "./schema-contract-core.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const targetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    process.exit(0);
  }

  const required = await loadRequiredSchemaContract(projectRoot);
  const receipt = options.database
    ? await inspectDatabase(options, required)
    : await inspectSnapshot(options, required);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = receipt.result === "VERIFIED" ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "SCHEMA_VERIFICATION_FAILED";
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    operation: "read-only-schema-compatibility",
    result: "NOT VERIFIED",
    error: code,
  }, null, 2)}\n`);
  process.exitCode = 2;
}

async function inspectSnapshot(options, required) {
  if (!options.snapshot) throw new Error("SCHEMA_SNAPSHOT_REQUIRED");
  const path = isAbsolute(options.snapshot) ? options.snapshot : resolve(projectRoot, options.snapshot);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 10 * 1024 * 1024) {
    throw new Error("SCHEMA_SNAPSHOT_FILE_UNSAFE");
  }
  const bytes = await readFile(path);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  const metadataTarget = snapshot?._meta?.target_id;
  if (metadataTarget !== undefined && metadataTarget !== options.targetId) {
    throw new Error("SCHEMA_SNAPSHOT_TARGET_MISMATCH");
  }
  return validateSchemaSnapshot({
    snapshot,
    required,
    targetId: options.targetId,
    source: {
      kind: "sanitized-information-schema-snapshot",
      sha256: sha256(bytes),
      targetBinding: metadataTarget === options.targetId ? "snapshot-metadata" : "operator-declared",
    },
  });
}

async function inspectDatabase(options, required) {
  if (!options.snapshotOutput) throw new Error("SCHEMA_SNAPSHOT_OUTPUT_REQUIRED");
  const names = {
    host: "SCHEMA_VERIFY_DB_HOST",
    user: "SCHEMA_VERIFY_DB_USER",
    password: "SCHEMA_VERIFY_DB_PASSWORD",
    database: "SCHEMA_VERIFY_DB_NAME",
  };
  for (const envName of Object.values(names)) {
    if (!Object.hasOwn(process.env, envName)) throw new Error("SCHEMA_DATABASE_ENV_INCOMPLETE");
  }
  const portText = process.env.SCHEMA_VERIFY_DB_PORT ?? "3306";
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error("SCHEMA_DATABASE_PORT_INVALID");
  }

  const ssl = await loadOptionalSsl();
  let connection;
  try {
    connection = await createConnection({
      host: process.env[names.host],
      port: Number(portText),
      user: process.env[names.user],
      password: process.env[names.password],
      database: process.env[names.database],
      connectTimeout: 5_000,
      multipleStatements: false,
      ...(ssl ? { ssl } : {}),
    });
    const queryDeadline = Date.now() + 15_000;
    const rawSnapshot = await collectMariaDbSnapshot({
      execute: (sql, values) => executeDatabaseQueryBefore(connection, sql, values, queryDeadline),
    }, Object.keys(required.tables));
    const selectedDatabase = String(rawSnapshot?.runtime?.database_name ?? "");
    if (selectedDatabase !== process.env[names.database]) throw new Error("SCHEMA_DATABASE_SELECTION_MISMATCH");
    const runtime = { ...rawSnapshot.runtime };
    delete runtime.database_name;
    const snapshot = {
      _meta: {
        target_id: options.targetId,
        captured_at_utc: new Date().toISOString(),
        schema_contract_id: required.contractId,
        secrets_included: false,
        private_setting_values_included: false,
      },
      runtime,
      columns: rawSnapshot.columns,
      indexes: rawSnapshot.indexes,
      tableOptions: rawSnapshot.tableOptions,
      checks: rawSnapshot.checks,
      foreignKeys: rawSnapshot.foreignKeys,
    };
    const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const snapshotPath = await writePrivateSnapshot(options.snapshotOutput, snapshotBytes);
    const receipt = validateSchemaSnapshot({
      snapshot,
      required,
      targetId: options.targetId,
      source: {
        kind: "explicit-mariadb-information-schema",
        sha256: sha256(snapshotBytes),
        targetBinding: "snapshot-metadata-and-explicit-connection",
        hostSha256: sha256(String(process.env[names.host])),
        databaseSha256: sha256(selectedDatabase),
        snapshotPath: relative(projectRoot, snapshotPath).replaceAll("\\", "/"),
      },
    });
    return receipt;
  } catch (error) {
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("SCHEMA_DATABASE_INSPECTION_FAILED");
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        // The compatibility result is already unavailable or captured. Never
        // expose connection details through a close error.
      }
    }
  }
}

function executeDatabaseQueryBefore(connection, sql, values, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    connection.destroy();
    return Promise.reject(new Error("SCHEMA_DATABASE_QUERY_TIMEOUT"));
  }
  return withSchemaQueryDeadline(
    connection.execute(sql, values),
    remaining,
    () => connection.destroy(),
  );
}

async function writePrivateSnapshot(relativeOutput, bytes) {
  if (!validPrivateSnapshotOutput(relativeOutput)) {
    throw new Error("SCHEMA_SNAPSHOT_OUTPUT_INVALID");
  }
  const privateRoot = resolve(projectRoot, "private");
  const evidenceRoot = resolve(privateRoot, "schema-evidence");
  const output = resolve(projectRoot, relativeOutput);
  if (dirname(output) !== evidenceRoot) throw new Error("SCHEMA_SNAPSHOT_OUTPUT_INVALID");
  await ensureRealPrivateDirectory(privateRoot);
  await ensureRealPrivateDirectory(evidenceRoot);
  await assertMissing(output, "SCHEMA_SNAPSHOT_OUTPUT_EXISTS");

  const temporary = resolve(evidenceRoot, `.schema-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A hard link publishes the complete bytes only if the target is absent;
    // unlike rename, it cannot silently replace an operator's prior evidence.
    await link(temporary, output);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("SCHEMA_SNAPSHOT_OUTPUT_EXISTS");
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("SCHEMA_SNAPSHOT_WRITE_FAILED");
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return output;
}

async function assertRealPrivateDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("SCHEMA_SNAPSHOT_DIRECTORY_UNSAFE");
  }
}

async function ensureRealPrivateDirectory(path) {
  try {
    await assertRealPrivateDirectory(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw new Error("SCHEMA_SNAPSHOT_DIRECTORY_UNSAFE");
    }
    await assertRealPrivateDirectory(path);
  }
}

async function assertMissing(path, code) {
  try {
    await lstat(path);
    throw new Error(code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    if (error?.code !== "ENOENT") throw new Error("SCHEMA_SNAPSHOT_OUTPUT_UNSAFE");
  }
}

async function loadOptionalSsl() {
  const caPath = process.env.SCHEMA_VERIFY_DB_SSL_CA_FILE;
  if (!caPath) return undefined;
  const resolved = isAbsolute(caPath) ? caPath : resolve(projectRoot, caPath);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) {
    throw new Error("SCHEMA_DATABASE_CA_FILE_UNSAFE");
  }
  return { ca: await readFile(resolved), rejectUnauthorized: true };
}

function parseArguments(args) {
  const options = {
    snapshot: undefined,
    snapshotOutput: undefined,
    database: false,
    targetId: undefined,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--help" || item === "-h") {
      options.help = true;
    } else if (item === "--database") {
      options.database = true;
    } else if (item === "--snapshot") {
      options.snapshot = args[index + 1];
      index += 1;
    } else if (item?.startsWith("--snapshot=")) {
      options.snapshot = item.slice("--snapshot=".length);
    } else if (item === "--snapshot-output") {
      options.snapshotOutput = args[index + 1];
      index += 1;
    } else if (item?.startsWith("--snapshot-output=")) {
      options.snapshotOutput = item.slice("--snapshot-output=".length);
    } else if (item === "--target-id") {
      options.targetId = args[index + 1];
      index += 1;
    } else if (item?.startsWith("--target-id=")) {
      options.targetId = item.slice("--target-id=".length);
    } else {
      throw new Error("SCHEMA_ARGUMENT_INVALID");
    }
  }
  if (options.help) return options;
  if (!options.targetId) throw new Error("SCHEMA_TARGET_ID_REQUIRED");
  if (!isSpecificTargetId(options.targetId)) throw new Error("SCHEMA_TARGET_ID_INVALID");
  if (options.database === Boolean(options.snapshot)) throw new Error("SCHEMA_SOURCE_MODE_INVALID");
  if (options.database && !options.snapshotOutput) throw new Error("SCHEMA_SNAPSHOT_OUTPUT_REQUIRED");
  if (!options.database && options.snapshotOutput) throw new Error("SCHEMA_SNAPSHOT_OUTPUT_MODE_INVALID");
  if (options.snapshotOutput && !validPrivateSnapshotOutput(options.snapshotOutput)) {
    throw new Error("SCHEMA_SNAPSHOT_OUTPUT_INVALID");
  }
  return options;
}

function isSpecificTargetId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 160
    && targetIdPattern.test(value)
    && /[0-9]/.test(value)
    && !/(?:^|[._:/-])(?:all|any|default|global|localhost|pending|tbd|unknown|unset|wildcard)(?:$|[._:/-])/i.test(value);
}

function validPrivateSnapshotOutput(value) {
  return typeof value === "string"
    && !value.includes("\\")
    && !isAbsolute(value)
    && /^private\/schema-evidence\/[A-Za-z0-9][A-Za-z0-9._-]{2,127}\.json$/.test(value);
}

function helpText() {
  return `Read-only Node shortener MariaDB schema compatibility gate\n\n`
    + `Snapshot: node tools/verify-schema-contract.mjs --snapshot=<sanitized.json> --target-id=<target>\n`
    + `Database: node tools/verify-schema-contract.mjs --database --target-id=<target> `
    + `--snapshot-output=private/schema-evidence/<unique>.json\n\n`
    + `Database mode requires SCHEMA_VERIFY_DB_HOST, SCHEMA_VERIFY_DB_PORT (optional),\n`
    + `SCHEMA_VERIFY_DB_USER, SCHEMA_VERIFY_DB_PASSWORD and SCHEMA_VERIFY_DB_NAME.\n`
    + `SCHEMA_VERIFY_DB_SSL_CA_FILE is optional. The tool issues SELECT statements only.\n`
    + `Database mode writes one non-overwriting, sanitized, target-bound private snapshot.\n`;
  /* Historical malformed help text retained only inside this comment so the
   * patch remains reviewable across newline-escape renderers.
  return `Read-only Node shortener MariaDB schema compatibility gate\n\n`
    + `Snapshot: node tools/verify-schema-contract.mjs --snapshot=<sanitized.json> --target-id=<target>\n`
    + `Database: node tools/verify-schema-contract.mjs --database --target-id=<target> \\\n+  --snapshot-output=private/schema-evidence/<unique>.json\n\n`
    + `Database mode requires SCHEMA_VERIFY_DB_HOST, SCHEMA_VERIFY_DB_PORT (optional),\n`
    + `SCHEMA_VERIFY_DB_USER, SCHEMA_VERIFY_DB_PASSWORD and SCHEMA_VERIFY_DB_NAME.\n`
    + `SCHEMA_VERIFY_DB_SSL_CA_FILE is optional. The tool issues SELECT statements only.\n`
    + `Database mode writes one non-overwriting, sanitized, target-bound private snapshot.\n`;
  */
}
