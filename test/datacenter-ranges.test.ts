import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDatacenterRanges } from "../src/infrastructure/datacenter-ranges.js";
import { containsIpv4 } from "../src/infrastructure/current-decision-provider.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadDatacenterRanges", () => {
  it("loads the exact generated current-PHP range asset", async () => {
    const loaded = await loadDatacenterRanges(resolve("data/datacenter-ranges.json"));
    expect(loaded.starts).toHaveLength(11_473);
    expect(loaded.ends).toHaveLength(11_473);
    expect(loaded.sourceSha256).toBe("302d970336b7391e34bfe31ce3dbcd9c88de7b3788b16c6153aea3a0fa05c5aa");
  });

  it("loads aligned, sorted ranges and supports boundary lookups", async () => {
    const path = await rangeFile({ starts: [0x0a000000, 0xc6336400], ends: [0x0affffff, 0xc63364ff] });
    const loaded = await loadDatacenterRanges(path);
    expect(loaded.sourceSha256).toBe("a".repeat(64));
    expect(containsIpv4(loaded, "10.0.0.0")).toBe(true);
    expect(containsIpv4(loaded, "10.255.255.255")).toBe(true);
    expect(containsIpv4(loaded, "198.51.100.255")).toBe(true);
    expect(containsIpv4(loaded, "192.0.2.1")).toBe(false);
  });

  it.each([
    [{ starts: [10], ends: [20, 30] }, "count"],
    [{ starts: [20], ends: [10] }, "sorted"],
    [{ starts: [10, 15], ends: [20, 30] }, "sorted"],
  ])("rejects malformed range data", async (ranges, message) => {
    const path = await rangeFile(ranges, ranges.starts.length);
    await expect(loadDatacenterRanges(path)).rejects.toThrow(message);
  });
});

async function rangeFile(
  ranges: { readonly starts: readonly number[]; readonly ends: readonly number[] },
  count = ranges.starts.length,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-ranges-"));
  roots.push(root);
  const path = join(root, "ranges.json");
  await writeFile(path, JSON.stringify({
    schema_version: 1,
    source: {
      relative_path: "data/datacenter_ranges.php",
      sha256: "a".repeat(64),
      policy_sha256: "b".repeat(64),
      built_at_utc: "2026-07-26T18:57:04Z",
      ipv4_range_count: count,
    },
    starts: ranges.starts,
    ends: ranges.ends,
  }));
  return path;
}
