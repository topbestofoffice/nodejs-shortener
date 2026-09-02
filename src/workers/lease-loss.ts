export interface ImageWorkerLeaseLossCrashStopOptions {
  readonly writeError?: (message: string) => void;
  readonly exitNow?: (code: number) => void;
}

/**
 * A singleton lease is a process-fencing boundary. Never wait for an in-flight
 * Sharp job here: the Redis TTL could expire while graceful close waits and a
 * replacement worker could start a second CPU-heavy job. A hard process exit
 * leaves only private temporary output; BullMQ and the durable web-owned ledger
 * recover the stalled job.
 */
export function crashStopImageWorkerAfterLeaseLoss(
  error: unknown,
  options: ImageWorkerLeaseLossCrashStopOptions = {},
): void {
  const writeError = options.writeError ?? ((message: string) => { process.stderr.write(message); });
  const exitNow = options.exitNow ?? ((code: number) => { process.exit(code); });
  writeError(`image worker singleton lease lost: ${safeError(error)}\n`);
  exitNow(1);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "unknown error";
}
