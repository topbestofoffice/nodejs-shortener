import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { DatacenterIpv4Ranges } from "./current-decision-provider.js";

const unsignedIpv4 = z.number().int().min(0).max(0xffffffff);
const rangeFileSchema = z.object({
  schema_version: z.literal(1),
  source: z.object({
    relative_path: z.literal("data/datacenter_ranges.php"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    built_at_utc: z.iso.datetime(),
    ipv4_range_count: z.number().int().positive().max(50_000),
  }).strict(),
  starts: z.array(unsignedIpv4).min(1).max(50_000),
  ends: z.array(unsignedIpv4).min(1).max(50_000),
}).strict();

export interface LoadedDatacenterRanges extends DatacenterIpv4Ranges {
  readonly sourceSha256: string;
  readonly policySha256: string;
  readonly builtAtUtc: string;
}

export async function loadDatacenterRanges(path: string): Promise<LoadedDatacenterRanges> {
  const parsed = rangeFileSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (parsed.starts.length !== parsed.ends.length || parsed.starts.length !== parsed.source.ipv4_range_count) {
    throw new Error("Datacenter range count does not match its metadata.");
  }
  for (let index = 0; index < parsed.starts.length; index += 1) {
    const start = parsed.starts[index];
    const end = parsed.ends[index];
    if (start === undefined || end === undefined || start > end
      || (index > 0 && start <= (parsed.ends[index - 1] ?? -1))) {
      throw new Error("Datacenter ranges must be sorted, non-overlapping, and aligned.");
    }
  }
  return Object.freeze({
    starts: Object.freeze(parsed.starts),
    ends: Object.freeze(parsed.ends),
    sourceSha256: parsed.source.sha256,
    policySha256: parsed.source.policy_sha256,
    builtAtUtc: parsed.source.built_at_utc,
  });
}
