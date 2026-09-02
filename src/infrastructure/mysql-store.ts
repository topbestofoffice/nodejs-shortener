import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../core/errors.js";
import type {
  AccountingStore,
  AuthStore,
  DeliveredCountryReportStore,
  DomainStore,
  LinkStore,
  PublicRegistrationStore,
  UploadCapacity,
  UploadStore,
} from "../ports.js";
import type { CreateRegisteredUserInput } from "../ports.js";
import type {
  CreateLinkInput,
  DeliveredCountryHistoryRow,
  DeliveredCountryProvenance,
  DeliveredCountryStateRow,
  DeliveredCountryBucketStatus,
  DeliveredCountryWindowRows,
  DomainPolicy,
  LinkAccountingEvent,
  LinkRecord,
  RememberTokenRecord,
  RegisterUploadInput,
  UserRecord,
} from "../core/types.js";
import { isManagedImagePath } from "../modules/uploads/managed-image-path.js";
import {
  DELIVERED_COUNTRY_BUCKET_SECONDS,
  DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS,
} from "../modules/reporting/completeness.js";
import {
  type DashboardCommunityStats,
  type DashboardHistoryLink,
  type DashboardHistoryStore,
  type DashboardOwnStats,
} from "../modules/dashboard/history-service.js";
import { escapeDashboardLikeLiteral } from "../modules/dashboard/history-policy.js";
import {
  trafficShieldSlot,
  trafficShieldSlotForDate,
  type TrafficShieldAggregate,
  type TrafficShieldDateSlot,
} from "../modules/dashboard/shield-service.js";

export interface MysqlStoreOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly connectionLimit?: number;
  readonly queueLimit?: number;
}

interface DomainRow extends RowDataPacket {
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

interface LinkRow extends RowDataPacket {
  id: string;
  domain_id: number;
  code: string;
  user_id: number;
  destination: string;
  title: string | null;
  description: string | null;
  image: string | null;
  compact_activity_tracked?: number;
  author_role: string | null;
  domain_hostname: string;
  domain_label: string;
  diversion_campaign: string;
  created_at: Date;
}

interface DashboardHistorySqlRow extends LinkRow {
  clicks: string | number;
  diverted_clicks: string | number;
  filtered_meta_clicks: string | number;
  filtered_bot_clicks: string | number;
  filtered_other_clicks: string | number;
  today_clicks: string | number;
  today_click_date: string | null;
  last_activity_at: Date | string | null;
}

interface DashboardOwnStatsRow extends RowDataPacket {
  total_links: string | number;
  total_clicks: string | number;
  today_clicks: string | number;
}

interface DashboardCommunityStatsRow extends RowDataPacket {
  total_clicks: string | number;
  today_clicks: string | number;
}

interface TrafficShieldSqlRow extends RowDataPacket {
  activation_started_at_utc: string | null;
  lifetime_total: string | number;
  d0: string | number;
  d1: string | number;
  d2: string | number;
  d3: string | number;
  d4: string | number;
  d5: string | number;
  d6: string | number;
}

interface UserRow extends RowDataPacket {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  default_domain_id: number | null;
  created_at: Date;
}

interface CreatedUserReadbackRow extends RowDataPacket {
  id: string | number;
  username: string;
  password_hash: string;
  role: string;
  created_at_utc: string;
}

interface RememberRow extends RowDataPacket {
  id: string;
  user_id: number;
  selector: string;
  validator_hash: string;
  expires_at: Date;
}

interface CountRow extends RowDataPacket {
  total: string | number;
}

interface UploadStateRow extends RowDataPacket {
  path: string;
  state: 1 | 2;
  ledger_job_id: string | null;
  ledger_user_id: number | null;
  ledger_state: string | null;
  ledger_publication_state: string | null;
  ledger_compensation_state: string | null;
}

interface CapacityLockRow extends RowDataPacket {
  acquired: number | null;
  released: number | null;
}

interface DeliveredCountryStateSqlRow extends RowDataPacket {
  domain_id: number;
  bucket_start_utc: Date | string;
  status: DeliveredCountryBucketStatus;
  delivered_total: string | number | null;
  provenance: DeliveredCountryProvenance;
  source_sha256: string;
  redis_run_id_sha256: string | null;
  reason_code: string | null;
  recorded_at_utc: Date | string;
}

interface DeliveredCountryHistorySqlRow extends RowDataPacket {
  domain_id: number;
  bucket_start_utc: Date | string;
  country: string;
  delivered: string | number | null;
}

interface AuthEpochRow extends RowDataPacket {
  svalue: string | null;
}

export class MysqlApplicationStore
implements DomainStore, LinkStore, DashboardHistoryStore, AccountingStore, AuthStore, PublicRegistrationStore, UploadStore, DeliveredCountryReportStore {
  public readonly pool: Pool;

  public constructor(options: MysqlStoreOptions) {
    this.pool = mysql.createPool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      charset: "utf8mb4",
      connectionLimit: options.connectionLimit ?? 8,
      queueLimit: options.queueLimit ?? 64,
      waitForConnections: true,
      bigNumberStrings: true,
      supportBigNumbers: true,
      dateStrings: false,
      decimalNumbers: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      timezone: "Z",
    });
  }

  public async getDomain(domainId: number): Promise<DomainPolicy | null> {
    const [rows] = await this.pool.execute<DomainRow[]>(
      `SELECT id, domain_key, hostname, label, role, active, allow_create,
              diversion_campaign, report_timezone
         FROM domains WHERE id = ? LIMIT 1`,
      [domainId],
    );
    return rows[0] === undefined ? null : mapDomain(rows[0]);
  }

  public async listManageableDomains(): Promise<readonly DomainPolicy[]> {
    const [rows] = await this.pool.query<DomainRow[]>(
      `SELECT id, domain_key, hostname, label, role, active, allow_create,
              diversion_campaign, report_timezone
         FROM domains ORDER BY id`,
    );
    return rows.map(mapDomain);
  }

  public async listSelectableDomains(): Promise<readonly DomainPolicy[]> {
    const [rows] = await this.pool.query<DomainRow[]>(
      `SELECT id, domain_key, hostname, label, role, active, allow_create,
              diversion_campaign, report_timezone
         FROM domains WHERE active = 1 AND allow_create = 1 ORDER BY id`,
    );
    return rows.map(mapDomain);
  }

  public async findLink(domainId: number, code: string, canonicalHost: string, surface: string): Promise<LinkRecord | null> {
    const [rows] = await this.pool.execute<LinkRow[]>(
      `SELECT l.id, l.domain_id, l.code, l.user_id, l.destination,
              l.title, l.description, l.image,
              (l.recent_activity_epochs IS NOT NULL) AS compact_activity_tracked,
              u.role AS author_role,
              d.hostname AS domain_hostname, d.label AS domain_label,
              d.diversion_campaign, l.created_at
         FROM links l
         LEFT JOIN users u ON u.id = l.user_id
         JOIN domains d ON d.id = l.domain_id
        WHERE l.domain_id = ? AND l.code = ?
          AND d.active = 1 AND d.hostname = ? AND d.role = ?
        LIMIT 1`,
      [domainId, code, canonicalHost, surface],
    );
    return rows[0] === undefined ? null : mapLink(rows[0]);
  }

  public async createLink(input: CreateLinkInput): Promise<LinkRecord> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    let commitAttempted = false;
    let connectionDisposed = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const uploadPath = managedUploadPath(input.image);
      if (uploadPath !== null) {
        if (input.imageSessionScopeHash === null) {
          throw new AppError(
            "One or more uploaded images are unavailable. Re-upload them.",
            422,
            "UPLOAD_UNAVAILABLE",
          );
        }
        if (input.imageOwnershipExpiresAt === null || input.imageOwnershipExpiresAt <= input.createdAt) {
          throw new AppError(
            "One or more uploaded images are unavailable. Re-upload them.",
            422,
            "UPLOAD_UNAVAILABLE",
          );
        }
        const [uploads] = await connection.execute<UploadStateRow[]>(
          `SELECT u.path, u.state, j.job_id AS ledger_job_id, j.user_id AS ledger_user_id,
                  j.state AS ledger_state, j.publication_state AS ledger_publication_state,
                  j.compensation_state AS ledger_compensation_state
             FROM uploaded_images u
             LEFT JOIN image_job_ledger_v1 j ON j.output_storage_key = u.path
            WHERE u.path = ? AND u.user_id = ? AND u.session_scope_hash = ?
              AND u.state IN (1, 2) AND u.expires_at > ?
            FOR UPDATE`,
          [
            uploadPath,
            input.userId,
            Buffer.from(input.imageSessionScopeHash, "hex"),
            formatUtc(input.createdAt),
          ],
        );
        if (uploads.length !== 1 || !isUploadLedgerReady(uploads[0], input.userId)) {
          throw new AppError(
            "One or more uploaded images are unavailable. Re-upload them.",
            422,
            "UPLOAD_UNAVAILABLE",
          );
        }
      }

      const [insert] = await connection.execute<ResultSetHeader>(
        `INSERT INTO links
          (domain_id, code, user_id, destination, title, description, image,
           clicks, recent_activity_epochs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          input.domainId,
          input.code,
          input.userId,
          input.destination,
          input.title,
          input.description,
          input.image,
          uploadPath === null ? null : "[]",
          formatUtc(input.createdAt),
        ],
      );
      if (insert.affectedRows !== 1) {
        throw new Error("Link row was not inserted.");
      }

      if (uploadPath !== null) {
        if (input.imageSessionScopeHash === null || input.imageOwnershipExpiresAt === null) {
          throw new Error("Managed link image is missing its upload session scope.");
        }
        const [attached] = await connection.execute<ResultSetHeader>(
          `UPDATE uploaded_images
              SET state = 2, attached_at = COALESCE(attached_at, ?), expires_at = ?
            WHERE path = ? AND user_id = ? AND session_scope_hash = ? AND state IN (1, 2)`,
          [
            formatUtc(input.createdAt),
            formatUtc(input.imageOwnershipExpiresAt),
            uploadPath,
            input.userId,
            Buffer.from(input.imageSessionScopeHash, "hex"),
          ],
        );
        if (attached.affectedRows !== 1) {
          throw new Error("Link image was not attached.");
        }
      }

      const [rows] = await connection.execute<LinkRow[]>(
        `SELECT l.id, l.domain_id, l.code, l.user_id, l.destination,
                l.title, l.description, l.image,
                (l.recent_activity_epochs IS NOT NULL) AS compact_activity_tracked,
                u.role AS author_role,
                d.hostname AS domain_hostname, d.label AS domain_label,
                d.diversion_campaign, l.created_at
           FROM links l
           LEFT JOIN users u ON u.id = l.user_id
           JOIN domains d ON d.id = l.domain_id
          WHERE l.domain_id = ? AND l.code = ? LIMIT 1`,
        [input.domainId, input.code],
      );
      if (rows[0] === undefined) {
        throw new Error("Created link could not be reloaded.");
      }
      commitAttempted = true;
      await connection.commit();
      transactionStarted = false;
      return mapLink(rows[0]);
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original mutation error. A broken connection cannot
          // be reused by mysql2 after it is released below.
        }
      }
      if (commitAttempted) {
        // Never blind-retry a link INSERT after a dropped COMMIT response. The
        // transaction may already be durable, including its image attachment.
        connection.destroy();
        connectionDisposed = true;
        try {
          const committed = await observeCommittedLinkCreate(this.pool, input);
          if (committed !== null) return committed;
        } catch {
          // Preserve the original ambiguous commit error when readback fails.
        }
      }
      if (isMysqlDuplicate(error)) {
        const duplicate = new Error("Duplicate code") as Error & { code: string };
        duplicate.code = "DUPLICATE_CODE";
        throw duplicate;
      }
      throw error;
    } finally {
      if (!connectionDisposed) connection.release();
    }
  }

  public async deleteOwnedLink(domainId: number, code: string, userId: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM links WHERE domain_id = ? AND code = ? AND user_id = ?",
      [domainId, code, userId],
    );
    return result.affectedRows === 1;
  }

  public async loadDashboardOwnStats(userId: number, businessDate: string): Promise<DashboardOwnStats> {
    assertDashboardUserAndDate(userId, businessDate);
    const [rows] = await this.pool.execute<DashboardOwnStatsRow[]>(
      `SELECT COUNT(*) AS total_links,
              COALESCE(SUM(clicks), 0) AS total_clicks,
              COALESCE(SUM(CASE WHEN today_click_date = ? THEN today_clicks ELSE 0 END), 0) AS today_clicks
         FROM links WHERE user_id = ?`,
      [businessDate, userId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("MariaDB returned no dashboard summary row.");
    return {
      totalLinks: parseRequiredUnsignedCounter(row.total_links, "total links"),
      totalClicks: parseRequiredUnsignedCounter(row.total_clicks, "total clicks"),
      clicksToday: parseRequiredUnsignedCounter(row.today_clicks, "today clicks"),
    };
  }

  public async loadDashboardCommunityStats(businessDate: string): Promise<DashboardCommunityStats> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new RangeError("Invalid dashboard business date.");
    }
    const [rows] = await this.pool.execute<DashboardCommunityStatsRow[]>(
      `SELECT COALESCE(SUM(l.clicks), 0) AS total_clicks,
              COALESCE(SUM(CASE WHEN l.today_click_date = ? THEN l.today_clicks ELSE 0 END), 0) AS today_clicks
         FROM links l JOIN users u ON u.id = l.user_id
        WHERE u.role <> 'admin'`,
      [businessDate],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("MariaDB returned no community summary row.");
    return {
      totalClicks: parseRequiredUnsignedCounter(row.total_clicks, "community clicks"),
      clicksToday: parseRequiredUnsignedCounter(row.today_clicks, "community today clicks"),
    };
  }

  public async loadTrafficShieldAggregate(
    userId: number,
    slots: readonly TrafficShieldDateSlot[],
  ): Promise<TrafficShieldAggregate> {
    assertTrafficShieldQuery(userId, slots);
    const dailyColumns = slots.map((entry, index) => (
      `COALESCE(SUM(CASE WHEN filtered_d${entry.slot} = ? THEN filtered_c${entry.slot} ELSE 0 END), 0) AS d${index}`
    ));
    const [rows] = await this.pool.execute<TrafficShieldSqlRow[]>(
      `SELECT (SELECT svalue FROM settings
                         WHERE skey = 'compact_filtered_history_started_at_utc') AS activation_started_at_utc,
              COALESCE(SUM(
                filtered_meta_clicks + filtered_bot_clicks + filtered_other_clicks
              ), 0) AS lifetime_total,
              ${dailyColumns.join(",\n              ")}
         FROM links
        WHERE user_id = ?`,
      [...slots.map((entry) => entry.date), userId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("MariaDB returned no Traffic Shield aggregate row.");
    if (row.activation_started_at_utc !== null && typeof row.activation_started_at_utc !== "string") {
      throw new Error("MariaDB returned an invalid Traffic Shield activation marker.");
    }
    return {
      activationStartedAtUtc: row.activation_started_at_utc,
      lifetimeTotal: parseRequiredUnsignedCounter(row.lifetime_total, "Traffic Shield lifetime"),
      dailyTotals: [row.d0, row.d1, row.d2, row.d3, row.d4, row.d5, row.d6]
        .map((value) => parseRequiredUnsignedCounter(value, "Traffic Shield daily")),
    };
  }

  public async countDashboardLinks(userId: number, literalQuery: string): Promise<number> {
    assertDashboardUserAndQuery(userId, literalQuery);
    const search = dashboardSearchClause(literalQuery, "links");
    const [rows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM links WHERE user_id = ?${search.sql}`,
      [userId, ...search.params],
    );
    const total = parseRequiredUnsignedCounter(rows[0]?.total, "dashboard link count");
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Dashboard link count exceeds the safe pagination range.");
    }
    return Number(total);
  }

  public async listDashboardLinks(input: {
    readonly userId: number;
    readonly literalQuery: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly DashboardHistoryLink[]> {
    assertDashboardUserAndQuery(input.userId, input.literalQuery);
    if (![20, 50, 100].includes(input.limit) || !Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new RangeError("Invalid dashboard history window.");
    }
    const search = dashboardSearchClause(input.literalQuery, "l");
    // limit/offset are validated integers. Inline them to avoid the PDO LIMIT
    // binding incompatibility that affected the PHP implementation.
    const [rows] = await this.pool.execute<DashboardHistorySqlRow[]>(
      `SELECT l.id, l.domain_id, l.code, l.user_id, l.destination,
              l.title, l.description, l.image,
              (l.recent_activity_epochs IS NOT NULL) AS compact_activity_tracked,
              u.role AS author_role,
              d.hostname AS domain_hostname, d.label AS domain_label,
              d.diversion_campaign, l.created_at,
              l.clicks, l.diverted_clicks, l.filtered_meta_clicks,
              l.filtered_bot_clicks, l.filtered_other_clicks, l.today_clicks,
              DATE_FORMAT(l.today_click_date, '%Y-%m-%d') AS today_click_date,
              l.last_activity_at
         FROM links l
         LEFT JOIN users u ON u.id = l.user_id
         JOIN domains d ON d.id = l.domain_id
        WHERE l.user_id = ?${search.sql}
        ORDER BY l.id DESC LIMIT ${input.limit} OFFSET ${input.offset}`,
      [input.userId, ...search.params],
    );
    return rows.map(mapDashboardHistoryLink);
  }

  public async record(event: LinkAccountingEvent): Promise<void> {
    const deltas = outcomeDeltas(event.outcome);
    const historyDelta = deltas.diverted + deltas.meta + deltas.bot + deltas.other;
    if (historyDelta === 0) {
      await this.#updateLink(this.pool, event, deltas, false);
      return;
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.#updateLink(connection, event, deltas, true);
      await this.#updateCountryHistory(connection, event, deltas);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  public async loadDeliveredCountryWindow(
    domainId: number,
    start: Date,
    end: Date,
  ): Promise<DeliveredCountryWindowRows> {
    const bucketMs = DELIVERED_COUNTRY_BUCKET_SECONDS * 1000;
    const durationMs = end.getTime() - start.getTime();
    const expectedBuckets = durationMs / bucketMs;
    if (!Number.isInteger(domainId) || domainId < 1 || domainId > 65_535
      || !Number.isSafeInteger(start.getTime()) || !Number.isSafeInteger(end.getTime())
      || start.getTime() % bucketMs !== 0 || end.getTime() % bucketMs !== 0
      || !Number.isSafeInteger(expectedBuckets) || expectedBuckets < 1
      || expectedBuckets > DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS) {
      throw new RangeError("Delivered-country report query requires 1..1008 exact ten-minute UTC buckets.");
    }
    const params = [domainId, formatUtc(start), formatUtc(end)] as const;
    const [stateRows] = await this.pool.execute<DeliveredCountryStateSqlRow[]>(
      `SELECT domain_id, bucket_start_utc, status, delivered_total, provenance,
              source_sha256, redis_run_id_sha256, reason_code, recorded_at_utc
         FROM delivered_country_10m_state
        WHERE domain_id = ? AND bucket_start_utc >= ? AND bucket_start_utc < ?
        ORDER BY bucket_start_utc ASC`,
      [...params],
    );
    const [historyRows] = await this.pool.execute<DeliveredCountryHistorySqlRow[]>(
      `SELECT domain_id, bucket_start_utc, country, delivered
         FROM diversion_history_10m
        WHERE domain_id = ? AND bucket_start_utc >= ? AND bucket_start_utc < ?
        ORDER BY bucket_start_utc ASC, country ASC`,
      [...params],
    );
    return {
      states: stateRows.map(mapDeliveredCountryState),
      history: historyRows.map(mapDeliveredCountryHistory),
    };
  }

  public async findUserByUsername(username: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT id, username, password_hash, role, default_domain_id, created_at
         FROM users WHERE username = ? LIMIT 1`,
      [username],
    );
    return rows[0] === undefined ? null : mapUser(rows[0]);
  }

  public async findUserById(userId: number): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT id, username, password_hash, role, default_domain_id, created_at
         FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    return rows[0] === undefined ? null : mapUser(rows[0]);
  }

  public async isRegistrationEnabled(): Promise<boolean> {
    const [rows] = await this.pool.execute<(RowDataPacket & { svalue: string | null })[]>(
      "SELECT svalue FROM settings WHERE skey = 'registration_enabled' LIMIT 1",
    );
    return String(rows[0]?.svalue ?? "0") === "1";
  }

  public async usernameExists(username: string): Promise<boolean> {
    // The captured current schema uses ascii_bin for users.username, so this
    // indexed equality is case-sensitive and matches its UNIQUE key exactly.
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT 1 FROM users WHERE username = ? LIMIT 1",
      [username],
    );
    return rows[0] !== undefined;
  }

  public async createUser(input: CreateRegisteredUserInput): Promise<number> {
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        [input.username, input.passwordHash, input.role, formatUtc(input.createdAt)],
      );
      if (result.affectedRows !== 1) {
        throw new Error("Registered user could not be created.");
      }
      if (!Number.isSafeInteger(result.insertId) || result.insertId <= 0) {
        throw codedError("Registered-user INSERT acknowledgement was incomplete.", "AMBIGUOUS_USER_INSERT_RESULT");
      }
      return result.insertId;
    } catch (error) {
      if (isPlausiblyAmbiguousMysqlMutationError(error)) {
        // An autocommit INSERT can be durable even when mysql2 loses the reply.
        // Never retry it. Resolve only an exact tuple through a new pool query;
        // otherwise preserve the original transport error.
        try {
          const committedId = await observeCommittedUserCreate(this.pool, input);
          if (committedId !== null) return committedId;
        } catch {
          // The original ambiguous mutation error remains authoritative.
        }
      }
      throw error;
    }
  }

  public async authFailureCount(ipHash: string, action: string, since: Date): Promise<number> {
    const [rows] = await this.pool.execute<CountRow[]>(
      "SELECT COUNT(*) AS total FROM auth_throttle WHERE ip_hash = ? AND action = ? AND created_at >= ?",
      [ipHash, action, formatUtc(since)],
    );
    return Number(rows[0]?.total ?? 0);
  }

  public async recordAuthFailure(ipHash: string, action: string, at: Date): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      "INSERT INTO auth_throttle (ip_hash, action, created_at) VALUES (?, ?, ?)",
      [ipHash, action, formatUtc(at)],
    );
    try {
      await this.pool.execute<ResultSetHeader>(
        "DELETE FROM auth_throttle WHERE ip_hash = ? AND created_at < ?",
        [ipHash, formatUtc(new Date(at.getTime() - 86_400_000))],
      );
    } catch {
      // Per-IP housekeeping is best-effort and never changes the login result.
    }
  }

  public async getAuthEpoch(): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { svalue: string | null })[]>(
      "SELECT svalue FROM settings WHERE skey = 'auth_epoch' LIMIT 1",
    );
    const value = Number(rows[0]?.svalue ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  public async createRememberToken(input: {
    userId: number;
    selector: string;
    validatorHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const authEpoch = await lockAuthEpoch(connection, "shared");
      await connection.execute<ResultSetHeader>(
        `INSERT INTO remember_tokens
          (user_id, selector, validator_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.userId, input.selector, input.validatorHash, formatUtc(input.expiresAt), formatUtc(input.createdAt)],
      );
      await connection.commit();
      return { authEpoch };
    } catch (error) {
      await rollbackAuthTransaction(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async findRememberToken(selector: string): Promise<RememberTokenRecord | null> {
    const [rows] = await this.pool.execute<RememberRow[]>(
      `SELECT id, user_id, selector, validator_hash, expires_at
         FROM remember_tokens WHERE selector = ? LIMIT 1`,
      [selector],
    );
    const row = rows[0];
    return row === undefined ? null : {
      id: String(row.id),
      userId: row.user_id,
      selector: row.selector,
      validatorHash: row.validator_hash,
      expiresAt: row.expires_at,
    };
  }

  public async rotateRememberToken(id: string, validatorHash: string, expiresAt: Date): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await lockAuthEpoch(connection, "shared");
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE remember_tokens SET validator_hash = ?, expires_at = ? WHERE id = ?",
        [validatorHash, formatUtc(expiresAt), id],
      );
      if (result.affectedRows !== 1) {
        throw new Error("Remember token could not be rotated.");
      }
      await connection.commit();
    } catch (error) {
      await rollbackAuthTransaction(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async restoreRememberToken(input: {
    readonly selector: string;
    readonly validatorHash: string;
    readonly rotatedValidatorHash: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<
    | {
        readonly status: "rotated";
        readonly userId: number;
        readonly selector: string;
        readonly authEpoch: number;
      }
    | { readonly status: "invalid" }
  > {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const authEpoch = await lockAuthEpoch(connection, "shared");
      const [rows] = await connection.execute<RememberRow[]>(
        `SELECT id, user_id, selector, validator_hash, expires_at
           FROM remember_tokens WHERE selector = ? LIMIT 1 FOR UPDATE`,
        [input.selector],
      );
      const token = rows[0];
      if (token === undefined) {
        await connection.rollback();
        return { status: "invalid" };
      }

      const valid = fixedHashEquals(token.validator_hash, input.validatorHash)
        && token.expires_at > input.now;
      if (!valid) {
        await connection.execute<ResultSetHeader>(
          "DELETE FROM remember_tokens WHERE id = ?",
          [String(token.id)],
        );
        await connection.commit();
        return { status: "invalid" };
      }

      const [rotated] = await connection.execute<ResultSetHeader>(
        "UPDATE remember_tokens SET validator_hash = ?, expires_at = ? WHERE id = ?",
        [input.rotatedValidatorHash, formatUtc(input.expiresAt), String(token.id)],
      );
      if (rotated.affectedRows !== 1) {
        throw new Error("Remember token lost its transaction lock.");
      }
      await connection.commit();
      return {
        status: "rotated",
        userId: token.user_id,
        selector: token.selector,
        authEpoch,
      };
    } catch (error) {
      await rollbackAuthTransaction(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async resetAllAuthCredentials(input: {
    readonly adminUserId: number;
    readonly selector: string;
    readonly validatorHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute<ResultSetHeader>(
        `INSERT INTO settings (skey, svalue) VALUES ('auth_epoch', '0')
         ON DUPLICATE KEY UPDATE svalue = svalue`,
      );
      const currentEpoch = await lockAuthEpoch(connection, "exclusive");
      if (currentEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Authentication epoch cannot be incremented safely.");
      }
      const authEpoch = currentEpoch + 1;
      const [updated] = await connection.execute<ResultSetHeader>(
        "UPDATE settings SET svalue = ? WHERE skey = 'auth_epoch'",
        [String(authEpoch)],
      );
      if (updated.affectedRows !== 1) {
        throw new Error("Authentication epoch row could not be updated.");
      }
      await connection.execute<ResultSetHeader>("DELETE FROM remember_tokens");
      await connection.execute<ResultSetHeader>(
        `INSERT INTO remember_tokens
          (user_id, selector, validator_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          input.adminUserId,
          input.selector,
          input.validatorHash,
          formatUtc(input.expiresAt),
          formatUtc(input.createdAt),
        ],
      );
      await connection.commit();
      return { authEpoch };
    } catch (error) {
      await rollbackAuthTransaction(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async deleteRememberToken(selector: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>("DELETE FROM remember_tokens WHERE selector = ?", [selector]);
  }

  public async setDefaultDomain(userId: number, domainId: number): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE users SET default_domain_id = ? WHERE id = ?",
      [domainId, userId],
    );
    if (result.affectedRows !== 1) {
      throw new Error("Default domain could not be saved.");
    }
  }

  public async countReadyForScope(userId: number, sessionScopeHash: string): Promise<number> {
    const [rows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM uploaded_images
        WHERE user_id = ? AND session_scope_hash = ? AND state = 1`,
      [userId, Buffer.from(sessionScopeHash, "hex")],
    );
    return Number(rows[0]?.total ?? 0);
  }

  public async countReadyTotal(): Promise<number> {
    const [rows] = await this.pool.query<CountRow[]>(
      "SELECT COUNT(*) AS total FROM uploaded_images WHERE state = 1",
    );
    return Number(rows[0]?.total ?? 0);
  }

  public async registerReady(input: RegisterUploadInput, capacity?: UploadCapacity): Promise<void> {
    if (capacity === undefined) {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `INSERT INTO uploaded_images
          (path, user_id, session_scope_hash, state, created_at, expires_at, attached_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL)`,
        readyUploadParams(input),
      );
      if (result.affectedRows !== 1) {
        throw new Error("Ready upload was not registered.");
      }
      return;
    }

    const connection = await this.pool.getConnection();
    let lockHeld = false;
    let transactionStarted = false;
    let reusableConnection = true;
    try {
      const [lockRows] = await connection.query<CapacityLockRow[]>(
        `SELECT GET_LOCK(${uploadCapacityLockExpression}, 5) AS acquired`,
      );
      if (lockRows[0]?.acquired !== 1) {
        throw codedError("Upload capacity lock unavailable.", "UPLOAD_CAPACITY_UNAVAILABLE");
      }
      lockHeld = true;
      await connection.beginTransaction();
      transactionStarted = true;

      const [scopeRows] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM uploaded_images
          WHERE user_id = ? AND session_scope_hash = ? AND state = 1`,
        [input.userId, Buffer.from(input.sessionScopeHash, "hex")],
      );
      if (Number(scopeRows[0]?.total ?? 0) >= capacity.readyPerSession) {
        throw codedError("Session upload capacity reached.", "SESSION_UPLOAD_LIMIT");
      }

      const [totalRows] = await connection.query<CountRow[]>(
        "SELECT COUNT(*) AS total FROM uploaded_images WHERE state = 1",
      );
      if (Number(totalRows[0]?.total ?? 0) >= capacity.readyTotal) {
        throw codedError("Global upload capacity reached.", "GLOBAL_UPLOAD_LIMIT");
      }

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO uploaded_images
          (path, user_id, session_scope_hash, state, created_at, expires_at, attached_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL)`,
        readyUploadParams(input),
      );
      if (result.affectedRows !== 1) {
        throw new Error("Ready upload was not registered.");
      }
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          reusableConnection = false;
        }
      }
      throw error;
    } finally {
      if (lockHeld) {
        try {
          const [releaseRows] = await connection.query<CapacityLockRow[]>(
            `SELECT RELEASE_LOCK(${uploadCapacityLockExpression}) AS released`,
          );
          if (releaseRows[0]?.released !== 1) {
            reusableConnection = false;
          }
        } catch {
          reusableConnection = false;
        }
      }
      if (reusableConnection) {
        connection.release();
      } else {
        connection.destroy();
      }
    }
  }

  public async verifyOwnedPaths(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    now: Date,
  ): Promise<readonly string[]> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) {
      return [];
    }
    const placeholders = unique.map(() => "?").join(",");
    const [rows] = await this.pool.execute<UploadStateRow[]>(
      `SELECT u.path, u.state, j.job_id AS ledger_job_id, j.user_id AS ledger_user_id,
              j.state AS ledger_state, j.publication_state AS ledger_publication_state,
              j.compensation_state AS ledger_compensation_state
         FROM uploaded_images u
         LEFT JOIN image_job_ledger_v1 j ON j.output_storage_key = u.path
        WHERE u.path IN (${placeholders}) AND u.user_id = ? AND u.session_scope_hash = ?
          AND u.state IN (1, 2) AND u.expires_at > ?`,
      [...unique, userId, Buffer.from(sessionScopeHash, "hex"), formatUtc(now)],
    );
    const found = new Set(rows.filter((row) => isUploadLedgerReady(row, userId)).map((row) => row.path));
    if (unique.some((path) => !found.has(path))) {
      throw new Error("One or more uploaded images are unavailable. Re-upload them.");
    }
    return unique;
  }

  public async markAttached(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    at: Date,
    expiresAt: Date,
  ): Promise<void> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) {
      return;
    }
    const placeholders = unique.map(() => "?").join(",");
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [owned] = await connection.execute<UploadStateRow[]>(
        `SELECT u.path, u.state, j.job_id AS ledger_job_id, j.user_id AS ledger_user_id,
                j.state AS ledger_state, j.publication_state AS ledger_publication_state,
                j.compensation_state AS ledger_compensation_state
           FROM uploaded_images u
           LEFT JOIN image_job_ledger_v1 j ON j.output_storage_key = u.path
          WHERE u.path IN (${placeholders}) AND u.user_id = ? AND u.session_scope_hash = ?
            AND u.state IN (1, 2) AND u.expires_at > ?
          FOR UPDATE`,
        [...unique, userId, Buffer.from(sessionScopeHash, "hex"), formatUtc(at)],
      );
      if (new Set(owned.filter((row) => isUploadLedgerReady(row, userId)).map((row) => row.path)).size !== unique.length) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE uploaded_images
            SET state = 2, attached_at = COALESCE(attached_at, ?), expires_at = ?
          WHERE path IN (${placeholders}) AND user_id = ? AND session_scope_hash = ? AND state IN (1, 2)`,
        [
          formatUtc(at),
          formatUtc(expiresAt),
          ...unique,
          userId,
          Buffer.from(sessionScopeHash, "hex"),
        ],
      );
      if (updated.affectedRows > unique.length) {
        throw new Error("Unexpected upload attachment row count.");
      }
      const [postcondition] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM uploaded_images
          WHERE path IN (${placeholders}) AND user_id = ? AND session_scope_hash = ?
            AND state = 2 AND expires_at >= ?`,
        [...unique, userId, Buffer.from(sessionScopeHash, "hex"), formatUtc(expiresAt)],
      );
      if (Number(postcondition[0]?.total ?? 0) !== unique.length) {
        throw new Error("Upload attachment postcondition failed.");
      }
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original mutation error.
        }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async #updateLink(
    connection: Pick<Pool, "execute"> | Pick<PoolConnection, "execute">,
    event: LinkAccountingEvent,
    deltas: OutcomeDeltas,
    bounded: boolean,
  ): Promise<void> {
    const today = indiaDate(event.occurredAt);
    const activityAt = formatUtc(event.occurredAt);
    const activityEpoch = Math.floor(event.occurredAt.getTime() / 1000);
    const params: SqlValue[] = [
      today, deltas.delivered, today, deltas.delivered,
      today, today,
      deltas.delivered, deltas.diverted, deltas.meta, deltas.bot, deltas.other,
    ];
    let whereParams: SqlValue[];
    let setSql = `today_clicks = CASE
          WHEN today_click_date = ? THEN today_clicks + ?
          WHEN today_click_date IS NULL OR today_click_date < ? THEN ?
          ELSE today_clicks END,
        today_click_date = CASE
          WHEN today_click_date IS NULL OR today_click_date < ? THEN ?
          ELSE today_click_date END,
        clicks = clicks + ?,
        diverted_clicks = diverted_clicks + ?,
        filtered_meta_clicks = filtered_meta_clicks + ?,
        filtered_bot_clicks = filtered_bot_clicks + ?,
        filtered_other_clicks = filtered_other_clicks + ?`;
    let whereSql = "id = ? AND domain_id = ?";

    if (event.outcome.startsWith("filtered_")) {
      const slot = trafficShieldSlot(event.occurredAt);
      const dateColumn = `filtered_d${slot.slot}`;
      const countColumn = `filtered_c${slot.slot}`;
      setSql += `, ${countColumn} = CASE
          WHEN ${dateColumn} = ? THEN ${countColumn} + 1
          WHEN ${dateColumn} IS NULL OR ${dateColumn} < ? THEN 1
          ELSE ${countColumn} END,
        ${dateColumn} = CASE
          WHEN ${dateColumn} IS NULL OR ${dateColumn} < ? THEN ?
          ELSE ${dateColumn} END`;
      params.push(slot.date, slot.date, slot.date, slot.date);
      whereSql += ` AND (${dateColumn} IS NULL OR ${dateColumn} <= ?)`;
      whereParams = [event.linkId, event.domainId, slot.date];
    } else {
      whereParams = [event.linkId, event.domainId];
    }
    setSql += `, last_activity_at = CASE
        WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
        ELSE last_activity_at END`;
    params.push(activityAt, activityAt);
    if (event.trackRecentActivity) {
      setSql += `, recent_activity_epochs = CASE
        WHEN recent_activity_epochs IS NULL
             OR JSON_VALID(recent_activity_epochs) = 0
             OR JSON_TYPE(recent_activity_epochs) <> 'ARRAY'
          THEN JSON_ARRAY(CAST(? AS UNSIGNED))
        WHEN JSON_LENGTH(recent_activity_epochs) < 100
          THEN JSON_ARRAY_APPEND(recent_activity_epochs, '$', CAST(? AS UNSIGNED))
        ELSE JSON_ARRAY_APPEND(
          JSON_REMOVE(recent_activity_epochs, '$[0]'), '$', CAST(? AS UNSIGNED)
        ) END`;
      params.push(activityEpoch, activityEpoch, activityEpoch);
    }
    params.push(...whereParams);

    const prefix = bounded ? "SET STATEMENT max_statement_time=0.25 FOR " : "";
    const [result] = await connection.execute<ResultSetHeader>(
      `${prefix}UPDATE links SET ${setSql} WHERE ${whereSql}`,
      params,
    );
    if (result.affectedRows !== 1) {
      throw new Error("Link accounting row was not updated.");
    }
  }

  async #updateCountryHistory(
    connection: Pick<PoolConnection, "execute">,
    event: LinkAccountingEvent,
    deltas: OutcomeDeltas,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      `SET STATEMENT max_statement_time=0.25 FOR
       INSERT INTO diversion_history_10m
         (domain_id, bucket_start_utc, country, diverted, filtered_meta, filtered_bots, filtered_other)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE diverted = diverted + VALUES(diverted),
         filtered_meta = filtered_meta + VALUES(filtered_meta),
         filtered_bots = filtered_bots + VALUES(filtered_bots),
         filtered_other = filtered_other + VALUES(filtered_other)`,
      [
        event.domainId,
        tenMinuteBucket(event.occurredAt),
        normalizeCountry(event.country),
        deltas.diverted,
        deltas.meta,
        deltas.bot,
        deltas.other,
      ],
    );
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

interface OutcomeDeltas {
  delivered: 0 | 1;
  diverted: 0 | 1;
  meta: 0 | 1;
  bot: 0 | 1;
  other: 0 | 1;
}

type SqlValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

const uploadCapacityLockExpression = "CONCAT('node_upload:', LEFT(SHA2(DATABASE(), 256), 40))";

function readyUploadParams(input: RegisterUploadInput): SqlValue[] {
  return [
    input.path,
    input.userId,
    Buffer.from(input.sessionScopeHash, "hex"),
    formatUtc(input.createdAt),
    formatUtc(input.expiresAt),
  ];
}

function managedUploadPath(image: string | null): string | null {
  return image !== null && isManagedImagePath(image) ? image : null;
}

async function observeCommittedUserCreate(
  pool: Pool,
  input: CreateRegisteredUserInput,
): Promise<number | null> {
  const [rows] = await pool.execute<CreatedUserReadbackRow[]>(
    `SELECT id, username, password_hash, role,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_utc
       FROM users WHERE username = ? LIMIT 1`,
    [input.username],
  );
  const observed = rows[0];
  if (observed === undefined) return null;
  const id = parsePositiveSafeInteger(observed.id);
  return id !== null
    && observed.username === input.username
    && observed.password_hash === input.passwordHash
    && observed.role === input.role
    && observed.created_at_utc === formatUtc(input.createdAt)
    ? id
    : null;
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function outcomeDeltas(outcome: LinkAccountingEvent["outcome"]): OutcomeDeltas {
  return {
    delivered: outcome === "delivered" ? 1 : 0,
    diverted: outcome === "diverted" ? 1 : 0,
    meta: outcome === "filtered_meta" ? 1 : 0,
    bot: outcome === "filtered_bot" ? 1 : 0,
    other: outcome === "filtered_other" ? 1 : 0,
  };
}

function mapDomain(row: DomainRow): DomainPolicy {
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

async function observeCommittedLinkCreate(pool: Pool, input: CreateLinkInput): Promise<LinkRecord | null> {
  const [rows] = await pool.execute<LinkRow[]>(
    `SELECT l.id, l.domain_id, l.code, l.user_id, l.destination,
            l.title, l.description, l.image,
            (l.recent_activity_epochs IS NOT NULL) AS compact_activity_tracked,
            u.role AS author_role,
            d.hostname AS domain_hostname, d.label AS domain_label,
            d.diversion_campaign, l.created_at
       FROM links l
       LEFT JOIN users u ON u.id = l.user_id
       JOIN domains d ON d.id = l.domain_id
      WHERE l.domain_id = ? AND l.code = ? LIMIT 1`,
    [input.domainId, input.code],
  );
  if (rows[0] === undefined) return null;
  const observed = mapLink(rows[0]);
  return observed.userId === input.userId
    && observed.destination === input.destination
    && observed.title === input.title
    && observed.description === input.description
    && observed.image === input.image
    && observed.createdAt.getTime() === input.createdAt.getTime()
    ? observed
    : null;
}

function mapLink(row: LinkRow): LinkRecord {
  return {
    id: String(row.id),
    domainId: row.domain_id,
    code: row.code,
    userId: row.user_id,
    destination: row.destination,
    title: row.title,
    description: row.description,
    image: row.image,
    compactActivityTracked: row.compact_activity_tracked === 1,
    authorRole: row.author_role ?? "user",
    domainHostname: row.domain_hostname,
    domainLabel: row.domain_label,
    diversionCampaign: row.diversion_campaign,
    createdAt: row.created_at,
  };
}

function mapDashboardHistoryLink(row: DashboardHistorySqlRow): DashboardHistoryLink {
  return {
    link: mapLink(row),
    countedClicks: parseRequiredUnsignedCounter(row.clicks, "counted clicks"),
    divertedClicks: parseRequiredUnsignedCounter(row.diverted_clicks, "diverted clicks"),
    filteredMetaClicks: parseRequiredUnsignedCounter(row.filtered_meta_clicks, "Meta-filtered clicks"),
    filteredBotClicks: parseRequiredUnsignedCounter(row.filtered_bot_clicks, "bot-filtered clicks"),
    filteredOtherClicks: parseRequiredUnsignedCounter(row.filtered_other_clicks, "other-filtered clicks"),
    todayClicks: parseRequiredUnsignedCounter(row.today_clicks, "today clicks"),
    todayClickDate: validNullableBusinessDate(row.today_click_date),
    lastActivityAt: row.last_activity_at === null ? null : parseMysqlUtc(row.last_activity_at),
  };
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    defaultDomainId: row.default_domain_id,
    createdAt: row.created_at,
  };
}

function mapDeliveredCountryState(row: DeliveredCountryStateSqlRow): DeliveredCountryStateRow {
  return {
    domainId: row.domain_id,
    bucketStart: parseMysqlUtc(row.bucket_start_utc),
    status: row.status,
    deliveredTotal: parseUnsignedBigint(row.delivered_total),
    provenance: row.provenance,
    sourceSha256: row.source_sha256,
    redisRunIdSha256: row.redis_run_id_sha256,
    reasonCode: row.reason_code,
    recordedAt: parseMysqlUtc(row.recorded_at_utc),
  };
}

function mapDeliveredCountryHistory(row: DeliveredCountryHistorySqlRow): DeliveredCountryHistoryRow {
  return {
    domainId: row.domain_id,
    bucketStart: parseMysqlUtc(row.bucket_start_utc),
    country: row.country,
    delivered: parseUnsignedBigint(row.delivered),
  };
}

function parseUnsignedBigint(value: string | number | null): bigint | null {
  if (value === null) {
    return null;
  }
  const raw = String(value);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(raw)) {
    throw new Error("MariaDB returned an invalid unsigned Delivered counter.");
  }
  return BigInt(raw);
}

function parseRequiredUnsignedCounter(value: string | number | null | undefined, label: string): bigint {
  const raw = value === null || value === undefined ? "" : String(value);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(raw)) {
    throw new Error(`MariaDB returned an invalid ${label} counter.`);
  }
  const parsed = BigInt(raw);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`MariaDB returned an overflowing ${label} counter.`);
  }
  return parsed;
}

function validNullableBusinessDate(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("MariaDB returned an invalid dashboard business date.");
  }
  return value;
}

function assertDashboardUserAndDate(userId: number, businessDate: string): void {
  if (!Number.isSafeInteger(userId) || userId < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new RangeError("Invalid dashboard summary request.");
  }
}

function assertTrafficShieldQuery(userId: number, slots: readonly TrafficShieldDateSlot[]): void {
  if (!Number.isSafeInteger(userId) || userId < 1 || slots.length !== 7) {
    throw new RangeError("Invalid Traffic Shield aggregate request.");
  }
  const dates = new Set<string>();
  for (const entry of slots) {
    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot > 6
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || dates.has(entry.date)
      || trafficShieldSlotForDate(entry.date) !== entry.slot) {
      throw new RangeError("Invalid Traffic Shield aggregate request.");
    }
    dates.add(entry.date);
  }
}

function assertDashboardUserAndQuery(userId: number, literalQuery: string): void {
  if (!Number.isSafeInteger(userId) || userId < 1 || typeof literalQuery !== "string") {
    throw new RangeError("Invalid dashboard history request.");
  }
}

function dashboardSearchClause(
  literalQuery: string,
  tableAlias: "links" | "l",
): { readonly sql: string; readonly params: readonly string[] } {
  if (literalQuery === "") return { sql: "", params: [] };
  const like = `%${escapeDashboardLikeLiteral(literalQuery)}%`;
  return {
    sql: ` AND (${tableAlias}.title LIKE ? ESCAPE '!' OR ${tableAlias}.destination LIKE ? ESCAPE '!'
      OR ${tableAlias}.code LIKE ? ESCAPE '!')`,
    params: [like, like, like],
  };
}

function parseMysqlUtc(value: Date | string): Date {
  const parsed = value instanceof Date
    ? new Date(value)
    : new Date(`${value.replace(" ", "T")}Z`);
  if (!Number.isSafeInteger(parsed.getTime())) {
    throw new Error("MariaDB returned an invalid Delivered-country timestamp.");
  }
  return parsed;
}

function formatUtc(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

async function lockAuthEpoch(
  connection: Pick<PoolConnection, "execute">,
  mode: "shared" | "exclusive",
): Promise<number> {
  const lockClause = mode === "shared" ? "LOCK IN SHARE MODE" : "FOR UPDATE";
  const [rows] = await connection.execute<AuthEpochRow[]>(
    `SELECT svalue FROM settings WHERE skey = 'auth_epoch' LIMIT 1 ${lockClause}`,
  );
  const raw = rows[0]?.svalue;
  if (raw === null || raw === undefined || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("Authentication epoch setting is missing or invalid.");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Authentication epoch setting exceeds the safe integer range.");
  }
  return parsed;
}

async function rollbackAuthTransaction(connection: Pick<PoolConnection, "rollback">): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Preserve the original/possibly ambiguous mutation error. Callers must
    // never blindly retry a global reset after an unacknowledged commit.
  }
}

function fixedHashEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function indiaDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year ?? ""}-${map.month ?? ""}-${map.day ?? ""}`;
}

function tenMinuteBucket(value: Date): string {
  const bucket = new Date(value);
  bucket.setUTCMinutes(Math.floor(bucket.getUTCMinutes() / 10) * 10, 0, 0);
  return formatUtc(bucket);
}

function normalizeCountry(value: string | null): string {
  const country = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(country) ? country : "??";
}

function isMysqlDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "errno" in error && (error as { errno?: unknown }).errno === 1062;
}

function isPlausiblyAmbiguousMysqlMutationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || isMysqlDuplicate(error)) return false;
  const candidate = error as { code?: unknown; errno?: unknown; fatal?: unknown };
  if (candidate.fatal === true) return true;
  if (candidate.errno === 2006 || candidate.errno === 2013 || candidate.errno === 2055) return true;
  return typeof candidate.code === "string" && new Set([
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "AMBIGUOUS_USER_INSERT_RESULT",
    "PROTOCOL_CONNECTION_LOST",
    "PROTOCOL_SEQUENCE_TIMEOUT",
    "PROTOCOL_UNEXPECTED_PACKET",
  ]).has(candidate.code);
}

function parsePositiveSafeInteger(value: string | number): number | null {
  const raw = String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isUploadLedgerReady(row: UploadStateRow | undefined, userId: number): boolean {
  if (row === undefined) return false;
  if (row.ledger_job_id === null) return true;
  return row.ledger_user_id === userId
    && row.ledger_state === "ready"
    && row.ledger_publication_state === "published"
    && row.ledger_compensation_state === "not_required";
}
