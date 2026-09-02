# MariaDB schema compatibility gate

This gate answers one narrow question: does an exact MariaDB 10.11 target expose
the SQL-mode/session observations, columns, types, collations, table engines,
indexes, CHECK constraints and foreign keys required by the Node shortener hot
path, authentication, uploads and reporting?

It is read-only. The verifier contains only `SELECT` statements. It never runs a
migration, creates a table or changes data.

## Current result

- **VERIFIED locally:** the source hashes, contract expansion, fail-closed
  validation and 13 focused schema-verifier tests.
- **NOT VERIFIED for the historical Cloudways snapshot:** the current receipt
  has 23 blockers. Its metadata does not prove the declared target binding or
  eight required InnoDB engine observations; it predates
  `links.recent_activity_epochs` and the Node `image_job_ledger_v1` table; and it
  did not capture foreign-key metadata, so all 12 required foreign keys are
  missing evidence. Missing observations do not prove that the legacy live
  tables use the wrong engine or lack those foreign keys.
- **NOT VERIFIED on real or disposable MariaDB:** no explicit database connection
  was supplied during this local pass. MariaDB execution, optimizer behavior,
  migration locking and target data remain unclaimed.

Run the historical evidence check:

```powershell
npm run verify:schema:snapshot
```

Its non-zero exit is expected until a fresh, target-specific sanitized snapshot
contains the complete Node candidate schema. A receipt is still printed. It
binds the declared target ID to the exact snapshot and contract SHA-256 values.

For a new snapshot, include `_meta.target_id`, `_meta.secrets_included=false`,
`_meta.private_setting_values_included=false`, the required runtime/session
observations, columns (including table engine), indexes, CHECK constraints and
foreign keys. Then run:

```powershell
node tools/verify-schema-contract.mjs `
  --snapshot=path/to/sanitized-information-schema.json `
  --target-id=exact-pilot-application-id
```

When `_meta.target_id` is absent, the receipt remains `NOT VERIFIED` with
`TARGET_BINDING_NOT_PROVEN`. When it matches the command, the receipt says
`snapshot-metadata`. A mismatch is rejected.

## Explicit database inspection

Use a disposable database first and credentials restricted to read-only access.
Connection values are required explicitly and are never printed:

```powershell
$env:SCHEMA_VERIFY_DB_HOST = 'database-host'
$env:SCHEMA_VERIFY_DB_PORT = '3306'
$env:SCHEMA_VERIFY_DB_USER = 'read-only-user'
$env:SCHEMA_VERIFY_DB_PASSWORD = 'set-outside-shell-history'
$env:SCHEMA_VERIFY_DB_NAME = 'exact-database-name'
npm run verify:schema:database -- --target-id=exact-pilot-application-id
```

`SCHEMA_VERIFY_DB_SSL_CA_FILE` is optional. Database mode verifies the selected
database name and emits only hashes for the host and database identity. A
connection error is reduced to a generic code so credentials or endpoints do
not leak through the receipt.

`VERIFIED` means only that the inspected schema matches this contract.
`NOT VERIFIED` means at least one required shape was missing, different or could
not be proven. Neither result authorizes a production change.

Schema compatibility does not prove row-data compatibility. Before the cloned
database is used for the dashboard or redirect shadow gate, run a separate
bounded, read-only Node scan over the disposable clone and record counts only
(never destination values) for: destinations that fail WHATWG parsing,
non-HTTP(S) schemes, credentials in URLs, ASCII controls/oversize values, and
zero/invalid `created_at` values. The current Node read path keeps malformed
dashboard rows non-fatal and suppresses unsafe redirect/preview output, but the
exact inventory remains `NOT VERIFIED` until that aggregate receipt exists.

## Manual forward-only SQL

- `database/001_image_job_ledger.sql` defines the Node-owned durable image ledger.
- `database/002_links_recent_activity_epochs.sql` adds the exact nullable
  `LONGTEXT CHARACTER SET ascii COLLATE ascii_bin` compact activity column proven
  by the clean PHP portable schema.
- `database/003_runtime_schema_contract_marker.sql` records the exact contract
  id that runtime readiness requires after the complete schema gate is green.

All three files are manual inputs. Nothing in the verifier applies them. The second
statement deliberately fails when the column already exists, because silently
accepting an existing column with the wrong type or collation would be unsafe.
Run DDL only on an isolated pilot under its resource/rollback gate, then rerun
the read-only verifier against that exact target.

Before any large-table production DDL, record the exact `links` row/data/index
size and test the effective MariaDB 10.11 ALTER algorithm on the isolated clone.
Require a provider-approved fail-fast no-copy/no-lock plan where supported, with
a resource stop condition and backup. Forward-only SQL is not automatically
low-impact.

The Node-owned image ledger currently has no foreign keys in its `001` source.
The gate therefore does not claim database-enforced user/domain lifecycle
cleanup for that table; reconciliation remains an application-level boundary.
