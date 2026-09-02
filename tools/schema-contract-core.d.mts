export type ColumnShape = [string, boolean, string | null, string | null, string];
export interface IndexShape { unique: boolean; columns: Array<string | [string, number]>; }
export interface ForeignKeyShape {
  name: string;
  table: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  deleteRule: string;
  updateRule: string;
}
export interface RequiredSchemaContract {
  contractId: string;
  contractSha256: string;
  runtimeVersionPattern: string;
  requiredSqlModes: string[];
  allowAdditionalTables: boolean;
  tables: Record<string, {
    columns: Record<string, ColumnShape>;
    indexes: Record<string, IndexShape>;
    engine?: string;
    checks?: Record<string, string>;
  }>;
  foreignKeys: ForeignKeyShape[];
  knownBoundaries: string[];
}
export interface SchemaReceipt {
  result: "VERIFIED" | "NOT VERIFIED";
  summary: {requiredTables: number; requiredColumns: number; requiredIndexes: number; requiredForeignKeys: number; requiredChecks: number; blockers: number; warnings: number};
  findings: Array<{severity: string; code: string; subject: string; expected: string; actual: string}>;
  [key: string]: unknown;
}
export const READ_ONLY_SCHEMA_QUERIES: Readonly<Record<string, string>>;
export function loadRequiredSchemaContract(projectRoot: string): Promise<RequiredSchemaContract>;
export function validateSchemaSnapshot(input: {
  snapshot: Record<string, unknown>;
  required: RequiredSchemaContract;
  targetId: string;
  source: {kind: string; sha256: string; targetBinding: string; hostSha256?: string; databaseSha256?: string; snapshotPath?: string};
}): SchemaReceipt;
export function collectMariaDbSnapshot(connection: {execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>}, requiredTableNames: string[]): Promise<Record<string, unknown>>;
export function sha256(value: string | Uint8Array): string;
export function withSchemaQueryDeadline<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T>;
