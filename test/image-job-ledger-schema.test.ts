import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MariaDB image job ledger schema", () => {
  it("is repeatable and pins both request and job idempotency", async () => {
    const sql = await schema();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS image_job_ledger_v1/i);
    expect(sql).toMatch(/UNIQUE KEY uq_image_job_ledger_job \(job_id\)/i);
    expect(sql).toMatch(/UNIQUE KEY uq_image_job_ledger_request \(request_key\)/i);
    expect(sql).toMatch(/UNIQUE KEY uq_image_job_ledger_output \(output_storage_key\)/i);
    expect(sql).toMatch(/ENGINE=InnoDB/i);
  });

  it("contains bounded lease, restart and compensation recovery indexes", async () => {
    const sql = await schema();
    expect(sql).toMatch(/KEY ix_image_job_dispatch \(state, next_attempt_at, id\)/i);
    expect(sql).toMatch(/KEY ix_image_job_expired_lease \(state, lease_expires_at, id\)/i);
    expect(sql).toMatch(/KEY ix_image_job_compensation \(compensation_state, next_attempt_at, id\)/i);
    expect(sql).toMatch(/attempt_count <= max_attempts/i);
    expect(sql).toMatch(/compensation_attempt_count <= max_compensation_attempts/i);
  });

  it("makes ready publication explicit and rejects absolute storage keys", async () => {
    const sql = await schema();
    expect(sql).toMatch(/state = 'ready'[\s\S]+publication_state = 'published'[\s\S]+compensation_state = 'not_required'/i);
    expect(sql).toMatch(/LEFT\(input_storage_key, 1\) <> '\/'/i);
    expect(sql).toMatch(/LOCATE\(CHAR\(92\), input_storage_key\) = 0/i);
    expect(sql).toMatch(/LOCATE\(':', input_storage_key\) = 0/i);
    expect(sql).not.toMatch(/(?:password|secret|redis_url|database_url)\s*=\s*['"][^'"]+/i);
  });
});

async function schema(): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../database/001_image_job_ledger.sql"), "utf8");
}
