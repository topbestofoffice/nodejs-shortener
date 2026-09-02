import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { DomainPolicy } from "../core/types.js";

export const runtimeSchemaContractId = "nodejs-shortener-mariadb-10.11-v1";

interface MarkerRow extends RowDataPacket {
  svalue: string | null;
}

interface RuntimeDomainRow extends RowDataPacket {
  id: number;
  domain_key: string;
  hostname: string;
  label: string;
  role: "dashboard" | "redirect";
  active: number;
  allow_create: number;
  diversion_campaign: string;
  report_timezone: "UTC" | "Asia/Kolkata";
}

export interface MysqlRuntimeReadinessSnapshot {
  readonly schemaContractId: string | null;
  readonly domains: readonly DomainPolicy[];
}

/**
 * A readiness-only connection is destroyed on deadline. This makes a timed-out
 * MariaDB probe settle instead of pinning CachedRuntimeReadinessProbe forever.
 */
export class MysqlRuntimeReadinessStore {
  #acquisitionPending = false;

  public constructor(private readonly pool: Pool) {}

  public async load(timeoutMs: number): Promise<MysqlRuntimeReadinessSnapshot> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5_000) {
      throw new RangeError("MariaDB readiness timeout is outside the bounded range.");
    }
    if (this.#acquisitionPending) {
      throw new Error("MariaDB readiness connection acquisition is still pending.");
    }
    const deadline = Date.now() + timeoutMs;
    this.#acquisitionPending = true;
    const connection = await acquireBefore(this.pool, deadline, () => {
      this.#acquisitionPending = false;
    });
    try {
      const [markerRows] = await executeBefore<MarkerRow[]>(connection, deadline,
        "SELECT svalue FROM settings WHERE skey = 'node_schema_contract_id' LIMIT 1");
      const [domainRows] = await executeBefore<RuntimeDomainRow[]>(connection, deadline,
        `SELECT id, domain_key, hostname, label, role, active, allow_create,
                diversion_campaign, report_timezone
           FROM domains ORDER BY id`);
      return {
        schemaContractId: markerRows[0]?.svalue ?? null,
        domains: domainRows.map(mapDomain),
      };
    } finally {
      connection.release();
    }
  }
}

function acquireBefore(
  pool: Pool,
  deadline: number,
  acquisitionSettled: () => void,
): Promise<PoolConnection> {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    acquisitionSettled();
    return Promise.reject(new Error("MariaDB readiness deadline expired."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("MariaDB readiness connection timed out."));
    }, remaining);
    timer.unref();
    pool.getConnection().then(
      (connection) => {
        if (settled) {
          connection.destroy();
          acquisitionSettled();
          return;
        }
        settled = true;
        clearTimeout(timer);
        acquisitionSettled();
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) {
          acquisitionSettled();
          return;
        }
        settled = true;
        clearTimeout(timer);
        acquisitionSettled();
        reject(error instanceof Error ? error : new Error("MariaDB readiness connection failed."));
      },
    );
  });
}

function executeBefore<Rows extends RowDataPacket[]>(
  connection: PoolConnection,
  deadline: number,
  sql: string,
): Promise<[Rows, unknown]> {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    connection.destroy();
    return Promise.reject(new Error("MariaDB readiness query deadline expired."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.destroy();
      reject(new Error("MariaDB readiness query timed out."));
    }, remaining);
    timer.unref();
    connection.execute<Rows>(sql).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("MariaDB readiness query failed."));
      },
    );
  });
}

function mapDomain(row: RuntimeDomainRow): DomainPolicy {
  if (!Number.isSafeInteger(row.id) || row.id < 1
    || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(row.domain_key)
    || !/^[a-z0-9.-]+$/.test(row.hostname)
    || (row.role !== "dashboard" && row.role !== "redirect")
    || (row.active !== 0 && row.active !== 1)
    || (row.allow_create !== 0 && row.allow_create !== 1)
    || (row.report_timezone !== "UTC" && row.report_timezone !== "Asia/Kolkata")) {
    throw new Error("MariaDB readiness domain identity is malformed.");
  }
  return {
    id: row.id,
    domainKey: row.domain_key,
    hostname: row.hostname,
    label: row.label,
    surface: row.role,
    active: row.active === 1,
    allowCreate: row.allow_create === 1,
    diversionCampaign: row.diversion_campaign,
    reportTimezone: row.report_timezone,
  };
}
