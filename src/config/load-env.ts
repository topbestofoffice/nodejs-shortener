import { loadEnvFile } from "node:process";

/** Load a private .env without overwriting variables supplied by PM2/the shell. */
export function loadEnvironmentFile(path = ".env"): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
