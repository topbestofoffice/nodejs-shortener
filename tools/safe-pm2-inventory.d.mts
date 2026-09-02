export type Pm2InventoryExpectation =
  | "neutral"
  | "absent"
  | "current-online"
  | "same-lineage-old-online";

export interface SafePm2InventoryInstance {
  readonly pmId: number | null;
  readonly pid: number | null;
  readonly status: "online" | "stopped" | "errored" | "launching" | "one-launch-status" | "unknown";
  readonly cwdMatchesRelease: boolean;
  readonly scriptMatchesRelease: boolean;
  readonly belongsToApplicationLineage: boolean;
  readonly releaseCwdSha256: string | null;
  readonly environmentFingerprintSha256: string;
  readonly environmentMatchesRendered: boolean;
  readonly nodeInterpreterMatches: boolean;
  readonly releaseClassification: "current-release" | "same-lineage-old-release" | "foreign";
}

export interface SafePm2InventoryProcess {
  readonly name: string;
  readonly expectedCount: number;
  readonly count: number;
  readonly countMatchesExpected: boolean;
  readonly instances: readonly SafePm2InventoryInstance[];
}

export interface SafePm2InventoryResult {
  readonly totalProcessCount: number;
  readonly otherProcessCount: number;
  readonly applicationPrivateRootSha256: string;
  readonly releaseCwdSha256: string;
  readonly pm2HomeSha256: string;
  readonly nodeVersion: string;
  readonly nodeBinaryPathSha256: string;
  readonly nodeBinarySha256: string;
  readonly pm2CliVersion: string;
  readonly pm2CliPathSha256: string;
  readonly pm2CliSha256: string;
  readonly expectedProcessEnvironmentSha256: string;
  readonly expectation: Pm2InventoryExpectation;
  readonly expected: readonly SafePm2InventoryProcess[];
}

export function safePm2Inventory(options: {
  readonly projectRoot: string;
  readonly environmentFile: string;
  readonly pm2Cli: string;
  readonly expect?: Pm2InventoryExpectation;
}): Promise<SafePm2InventoryResult>;
