export function parseExactEnvironment(source: string, context?: string): Readonly<Record<string, string>>;
export function assertLocalPilotTransports(environment: Record<string, string>): void;
export function exactDeploymentRoots(environment: Record<string, string>, projectRoot: string): Promise<any>;
