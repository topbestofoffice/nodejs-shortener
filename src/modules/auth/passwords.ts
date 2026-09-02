import { verify as verifyArgon2 } from "@node-rs/argon2";
import bcrypt from "bcryptjs";

export const bcryptMaximumPasswordBytes = 72;

// Fixed cost-10 verifier used so an unknown login name performs the same
// expensive password check as an existing bcrypt account.
export const invalidLoginPasswordHash =
  "$2b$10$ZTHI.dYjUcM.qzW/M1LEcuwz9rHQjs1u6WN26fR94K8LN.XJk39g6";

export async function verifyPhpPassword(password: string, hash: string): Promise<boolean> {
  try {
    if (hash.startsWith("$argon2")) {
      return await verifyArgon2(hash, password);
    }
    if (/^\$2[aby]\$/.test(hash)) {
      const normalized = hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
      return await bcrypt.compare(password, normalized);
    }
    return false;
  } catch {
    return false;
  }
}

export async function createPhpCompatiblePasswordHash(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > bcryptMaximumPasswordBytes) {
    throw new RangeError(`Password exceeds bcrypt's ${bcryptMaximumPasswordBytes}-byte limit.`);
  }
  const hash = await bcrypt.hash(password, 10);
  return hash.startsWith("$2b$") ? `$2y$${hash.slice(4)}` : hash;
}
