import { crashStopImageWorkerAfterLeaseLoss } from "../../src/workers/lease-loss.js";

// A referenced timer represents native/in-flight work that would keep the
// process alive if the implementation regressed to process.exitCode.
setInterval(() => undefined, 1_000);
process.stdout.write("before-lease-loss\n");
crashStopImageWorkerAfterLeaseLoss(new Error("test owner conflict"));
process.stdout.write("unreachable-after-lease-loss\n");
