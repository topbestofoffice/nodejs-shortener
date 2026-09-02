import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { MaintenanceDryRunReceipt } from "./maintenance-report.js";

export interface PersistedMaintenanceReceipt {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export async function writeMaintenanceDryRunReceipt(
  directory: string,
  receipt: MaintenanceDryRunReceipt,
): Promise<PersistedMaintenanceReceipt> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
    throw new Error("Maintenance receipt directory must be a real directory, not a symlink.");
  }
  const resolvedDirectory = await realpath(directory);
  const lockDirectory = join(resolvedDirectory, ".maintenance-report.lock");
  let persisted: PersistedMaintenanceReceipt | undefined;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error(
        "MAINTENANCE_REPORT_LOCKED: another report writer or an unrecovered lock exists.",
        { cause: error },
      );
    }
    throw error;
  }

  try {
    const captured = receipt.source.capturedAt.replaceAll(/[^0-9]/g, "").slice(0, 14);
    const nonce = randomBytes(6).toString("hex");
    const fileName = `maintenance-dry-run-${captured}-${nonce}.json`;
    const path = join(resolvedDirectory, fileName);
    const body = `${JSON.stringify(receipt, null, 2)}\n`;
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(body, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }

    const back = await readFile(path);
    const expected = Buffer.from(body, "utf8");
    if (!back.equals(expected)) {
      throw new Error("Maintenance receipt read-back did not match the written bytes.");
    }
    persisted = {
      path,
      sha256: createHash("sha256").update(back).digest("hex"),
      bytes: back.byteLength,
    };
  } catch (error) {
    primaryError = error;
    operationFailed = true;
  }
  let lockReleaseError: unknown;
  try {
    await rmdir(lockDirectory);
  } catch (error) {
    lockReleaseError = error;
  }
  if (operationFailed) {
    throw primaryError;
  }
  if (lockReleaseError !== undefined) {
    // A non-empty or replaced lock is not removed blindly. Expose the stale
    // lock instead of claiming the otherwise-written receipt was successful.
    throw new Error("Maintenance receipt was written but its writer lock could not be released.", {
      cause: lockReleaseError,
    });
  }
  if (persisted === undefined) throw new Error("Maintenance receipt was not persisted.");
  return persisted;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "EEXIST";
}
