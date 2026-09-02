import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildMaintenanceDryRunReceipt,
  parseMaintenanceInventorySnapshot,
} from "../dist/modules/maintenance/maintenance-report.js";
import { writeMaintenanceDryRunReceipt } from "../dist/modules/maintenance/maintenance-receipt.js";

const maximumSnapshotBytes = 4 * 1024 * 1024;

try {
  const options = parseArgs(process.argv.slice(2));
  const snapshotPath = resolve(options.snapshot);
  const snapshotState = await lstat(snapshotPath);
  if (!snapshotState.isFile() || snapshotState.isSymbolicLink()
    || snapshotState.size > maximumSnapshotBytes) {
    throw new Error("Maintenance snapshot must be a non-symlink regular JSON file no larger than 4 MiB.");
  }
  const snapshot = parseMaintenanceInventorySnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
  if (snapshot.targetId !== options.targetId) {
    throw new Error("Maintenance snapshot targetId does not match --target-id.");
  }
  const receipt = buildMaintenanceDryRunReceipt(snapshot, new Date(), options.cap);
  const persisted = await writeMaintenanceDryRunReceipt(resolve(options.receiptDir), receipt);
  process.stdout.write(`${JSON.stringify({
    result: receipt.result,
    targetId: receipt.source.targetId,
    receiptPath: persisted.path,
    receiptSha256: persisted.sha256,
    mutationsAttempted: receipt.mutations.attempted,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--(snapshot|receipt-dir|target-id|cap)=(.+)$/.exec(arg);
    if (match === null || result[match[1]] !== undefined) {
      throw new Error(`Unknown, malformed or duplicate argument: ${arg}`);
    }
    result[match[1]] = match[2];
  }
  if (typeof result.snapshot !== "string" || typeof result["receipt-dir"] !== "string"
    || typeof result["target-id"] !== "string") {
    throw new Error("Usage: maintenance-report --snapshot=<json> --receipt-dir=<private-dir> --target-id=<id> [--cap=1..2000]");
  }
  const cap = result.cap === undefined ? 2_000 : Number(result.cap);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 2_000) {
    throw new Error("--cap must be an integer from 1 to 2000.");
  }
  return {
    snapshot: result.snapshot,
    receiptDir: result["receipt-dir"],
    targetId: result["target-id"],
    cap,
  };
}
