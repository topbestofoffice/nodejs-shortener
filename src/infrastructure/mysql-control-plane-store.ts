import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { decodeCountryQualityPolicy } from "../modules/redirect/policy.js";
import type {
  AdminControlPlaneStore,
  AdminDeleteUserResult,
  AdminDomainState,
  AdminUserSummary,
} from "../modules/admin/store.js";
import type { GeoQualityCandidate } from "../modules/admin/geo-quality-policy.js";
import type { SkimSettingsCandidate } from "../modules/admin/skim-settings-policy.js";

const qualityPolicySetting = "skim_quality_policy_v1";
const skimSettingKeys = [
  "skim_enabled",
  "skim_destination_url",
  "skim_default_percent",
  qualityPolicySetting,
] as const;

interface DomainSettingRow extends RowDataPacket {
  skey: string;
  svalue: string | null;
}

interface GeoRuleRow extends RowDataPacket {
  country_code: string;
  percent: string | number;
}

interface AdminUserRow extends RowDataPacket {
  id: number;
  username: string;
  role: string;
  created_at: Date | string;
  link_count: string | number;
  click_count: string | number;
}

interface LockedUserRow extends RowDataPacket {
  id: number;
  role: string;
}

interface UserLinkRow extends RowDataPacket {
  domain_id: number;
  code: string;
}

/**
 * Admin/control-plane adapter over the already-owned application pool. This
 * class never creates or closes connections, so later reporting/session-reset
 * methods can live here without introducing a second pool or shutdown path.
 */
export class MysqlControlPlaneStore implements AdminControlPlaneStore {
  public constructor(public readonly pool: Pool) {}

  public async loadDomainState(domainId: number): Promise<AdminDomainState> {
    assertDomainId(domainId);
    const [settingRows] = await this.pool.execute<DomainSettingRow[]>(
      `SELECT skey, svalue FROM domain_settings
        WHERE domain_id = ? AND skey IN (?, ?, ?, ?)`,
      [domainId, ...skimSettingKeys],
    );
    const [geoRows] = await this.pool.execute<GeoRuleRow[]>(
      `SELECT country_code, percent FROM geo_rules
        WHERE domain_id = ? ORDER BY country_code`,
      [domainId],
    );
    const settings = new Map(settingRows.map((row) => [row.skey, row.svalue ?? ""]));
    return {
      skim: {
        enabled: settings.get("skim_enabled") === "1",
        destinationUrl: settings.get("skim_destination_url") ?? "",
        defaultPercent: boundedStoredPercent(settings.get("skim_default_percent")),
      },
      geoRules: geoRows.map((row) => ({
        countryCode: row.country_code,
        percent: boundedStoredPercent(row.percent),
      })),
      qualityPolicy: decodeCountryQualityPolicy(settings.get(qualityPolicySetting)),
    };
  }

  public async saveSkimSettings(
    domainId: number,
    candidate: SkimSettingsCandidate,
  ): Promise<void> {
    assertDomainId(domainId);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await upsertDomainSetting(connection, domainId, "skim_enabled", candidate.enabled ? "1" : "0");
      await upsertDomainSetting(connection, domainId, "skim_destination_url", candidate.destinationUrl);
      await upsertDomainSetting(connection, domainId, "skim_default_percent", String(candidate.defaultPercent));
      await connection.commit();
    } catch (error) {
      await rollbackBestEffort(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async saveGeoQuality(domainId: number, candidate: GeoQualityCandidate): Promise<void> {
    assertDomainId(domainId);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute<ResultSetHeader>("DELETE FROM geo_rules WHERE domain_id = ?", [domainId]);
      for (const rule of candidate.rules) {
        await connection.execute<ResultSetHeader>(
          "INSERT INTO geo_rules (domain_id, country_code, percent) VALUES (?, ?, ?)",
          [domainId, rule.countryCode, rule.percent],
        );
      }
      await upsertDomainSetting(
        connection,
        domainId,
        qualityPolicySetting,
        JSON.stringify({
          active: candidate.qualityPolicy.active,
          scope: candidate.qualityPolicy.scope,
          countries: candidate.qualityPolicy.countries,
        }),
      );
      await connection.commit();
    } catch (error) {
      await rollbackBestEffort(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async listUsers(): Promise<readonly AdminUserSummary[]> {
    const [rows] = await this.pool.query<AdminUserRow[]>(
      `SELECT u.id, u.username, u.role, u.created_at,
              (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id) AS link_count,
              (SELECT COALESCE(SUM(l.clicks), 0) FROM links l WHERE l.user_id = u.id) AS click_count
         FROM users u ORDER BY u.role DESC, u.id ASC`,
    );
    return rows.map((row) => ({
      id: requiredPositiveInteger(row.id, "Admin user ID"),
      username: row.username,
      role: row.role,
      createdAt: requiredDate(row.created_at, "Admin user creation date"),
      linkCount: requiredUnsignedCounter(row.link_count, "Admin user link count"),
      clickCount: requiredUnsignedCounter(row.click_count, "Admin user click count"),
    }));
  }

  public async setRegistrationEnabled(enabled: boolean): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO settings (skey, svalue) VALUES ('registration_enabled', ?)
       ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)`,
      [enabled ? "1" : "0"],
    );
  }

  public async deleteRegularUser(userId: number): Promise<AdminDeleteUserResult> {
    assertUserId(userId);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute<LockedUserRow[]>(
        "SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
        [userId],
      );
      const user = users[0];
      if (user === undefined) {
        await connection.rollback();
        return { status: "not_found" };
      }
      if (user.role === "admin") {
        await connection.rollback();
        return { status: "admin" };
      }
      if (user.role !== "user") {
        await connection.rollback();
        return { status: "protected_role" };
      }

      // The locked parent row serializes concurrent FK-bound upload/link
      // inserts until this decision commits or rolls back.
      const [uploads] = await connection.execute<RowDataPacket[]>(
        "SELECT 1 FROM uploaded_images WHERE user_id = ? LIMIT 1 FOR UPDATE",
        [userId],
      );
      if (uploads[0] !== undefined) {
        await connection.rollback();
        return { status: "uploads_present" };
      }
      const [links] = await connection.execute<UserLinkRow[]>(
        "SELECT domain_id, code FROM links WHERE user_id = ? FOR UPDATE",
        [userId],
      );
      const [deleted] = await connection.execute<ResultSetHeader>(
        "DELETE FROM users WHERE id = ? AND role = 'user'",
        [userId],
      );
      if (deleted.affectedRows !== 1) {
        throw new Error("Regular user deletion lost its locked precondition.");
      }
      await connection.commit();
      return {
        status: "deleted",
        userId,
        links: links.map((link) => ({ domainId: link.domain_id, code: link.code })),
      };
    } catch (error) {
      await rollbackBestEffort(connection);
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function upsertDomainSetting(
  connection: PoolConnection,
  domainId: number,
  key: string,
  value: string,
): Promise<void> {
  await connection.execute<ResultSetHeader>(
    `INSERT INTO domain_settings (domain_id, skey, svalue) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)`,
    [domainId, key, value],
  );
}

async function rollbackBestEffort(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Preserve the mutation error. The connection is released/disposed by mysql2.
  }
}

function assertDomainId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("Admin domain ID is invalid.");
  }
}

function assertUserId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Admin user ID is invalid.");
  }
}

function boundedStoredPercent(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,2})$/.test(text)) return 0;
  const parsed = Number(text);
  return parsed <= 100 ? parsed : 0;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function requiredUnsignedCounter(value: unknown, label: string): bigint {
  const text = typeof value === "bigint" || typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new Error(`${label} is invalid.`);
  return BigInt(text);
}

function requiredDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}
