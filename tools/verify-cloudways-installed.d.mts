export interface InstalledCloudwaysResult {
  readonly activationSha256: string;
  readonly htaccessSha256: string;
  readonly runtimeConfigurationSha256: string;
  readonly pm2DeploymentConfigurationSha256: string;
  readonly portablePermissions: "verified" | "not-portable";
}

export function verifyInstalledCloudways<T>(options: {
  readonly projectRoot: string;
  readonly environmentFile: string;
  readonly htaccessFile: string;
  readonly loadRuntimeConfig: (environment: Readonly<Record<string, string>>, root: string) => Promise<T>;
  readonly assertProductionStartupAllowed: (config: T, options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly projectRoot: string;
  }) => void;
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
}): Promise<InstalledCloudwaysResult>;

export function pm2DeploymentConfigurationSha256(environment: Readonly<Record<string, string>>): string;
export function validatePm2DeploymentEnvironment(environment: Readonly<Record<string, string>>): void;
