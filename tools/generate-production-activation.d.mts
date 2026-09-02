export interface ProductionArtifactManifest {
  readonly schemaVersion: 1;
  readonly kind: "nodejs-shortener-artifact-manifest";
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export interface ProductionActivationPlan<T> {
  readonly root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly runtimeConfig: T;
  readonly stage: "pilot" | "release";
  readonly targetId: string;
  readonly canonicalHosts: readonly string[];
  readonly runtimeConfigurationSha256: string;
  readonly pm2DeploymentConfigurationSha256: string;
  readonly manifest: ProductionArtifactManifest;
  readonly manifestBytes: Buffer;
  readonly artifactManifestSha256: string;
}

export interface ProductionActivationResult {
  readonly activationPath: string;
  readonly activationSha256: string;
  readonly artifactManifestPath: string;
  readonly artifactManifestSha256: string;
  readonly runtimeConfigurationSha256: string;
  readonly pm2DeploymentConfigurationSha256: string;
  readonly readinessDocumentPath: string;
  readonly readinessDocumentSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function buildProductionActivationPlan<T>(options: {
  readonly projectRoot: string;
  readonly environmentFile: string;
  readonly loadRuntimeConfig: (environment: Readonly<Record<string, string>>, root: string) => Promise<T>;
  readonly productionArtifactManifestPaths: (root: string) => readonly string[];
  readonly productionRuntimeConfigurationSha256: (config: T) => string;
  readonly productionPm2DeploymentConfigurationSha256: (
    config: T,
    pm2Home: string,
    nodeBinary: string,
    applicationPrivateRoot: string,
    applicationReleaseRoot: string,
    pm2CliScript: string,
    pm2Version: string,
  ) => string;
}): Promise<ProductionActivationPlan<T>>;

export function createProductionActivation<T>(
  plan: ProductionActivationPlan<T>,
  options: {
    readonly lifetimeHours?: number;
    readonly clock: () => Date;
    readonly verifyProductionReadiness: (options: Readonly<Record<string, unknown>>) => Promise<{
      readonly blockers: readonly string[];
      readonly requiredGateCount: number;
    }>;
    readonly assertProductionStartupAllowed: (config: T, options: {
      readonly environment: NodeJS.ProcessEnv;
      readonly now: Date;
      readonly projectRoot: string;
    }) => void;
  },
): Promise<ProductionActivationResult>;
