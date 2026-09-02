import type { Clock, RegistrationStore } from "../../ports.js";
import {
  bcryptMaximumPasswordBytes,
  createPhpCompatiblePasswordHash,
} from "./passwords.js";

export type { CreateRegisteredUserInput, RegistrationStore } from "../../ports.js";

export const registrationMinimumPasswordBytes = 8;
export const registrationMaximumPasswordBytes = bcryptMaximumPasswordBytes;

export type RegistrationErrorCode =
  | "INVALID_USERNAME"
  | "INVALID_PASSWORD"
  | "PASSWORD_MISMATCH"
  | "USERNAME_TAKEN"
  | "REGISTRATION_FAILED";

export class RegistrationError extends Error {
  public constructor(
    message: string,
    public readonly code: RegistrationErrorCode,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

export interface PublicRegistrationRequest {
  readonly username: string;
  readonly password: string;
  readonly passwordConfirmation: string;
}

export interface RegisteredAccount {
  readonly id: number;
  readonly username: string;
  readonly role: "user";
  readonly createdAt: Date;
}

export interface RegistrationServiceOptions {
  readonly store: RegistrationStore;
  readonly clock: Clock;
  readonly hashPassword?: (password: string) => Promise<string>;
}

export class RegistrationService {
  readonly #hashPassword: (password: string) => Promise<string>;

  public constructor(private readonly options: RegistrationServiceOptions) {
    this.#hashPassword = options.hashPassword ?? createPhpCompatiblePasswordHash;
  }

  public async register(request: PublicRegistrationRequest): Promise<RegisteredAccount> {
    const username = normalizeRegistrationUsername(request.username);
    const usernameError = validateRegistrationUsername(username);
    if (usernameError !== null) {
      throw new RegistrationError(usernameError, "INVALID_USERNAME");
    }
    const passwordBytes = Buffer.byteLength(request.password, "utf8");
    if (passwordBytes < registrationMinimumPasswordBytes) {
      throw new RegistrationError(
        `Password must be at least ${registrationMinimumPasswordBytes} characters.`,
        "INVALID_PASSWORD",
      );
    }
    if (passwordBytes > registrationMaximumPasswordBytes) {
      throw new RegistrationError(
        `Password must be at most ${registrationMaximumPasswordBytes} UTF-8 bytes.`,
        "INVALID_PASSWORD",
      );
    }
    if (request.password !== request.passwordConfirmation) {
      throw new RegistrationError("The two passwords do not match.", "PASSWORD_MISMATCH");
    }

    let exists: boolean;
    try {
      exists = await this.options.store.usernameExists(username);
    } catch {
      throw registrationFailed();
    }
    if (exists) {
      throw new RegistrationError("That username is taken — please choose another.", "USERNAME_TAKEN");
    }

    const createdAt = new Date(this.options.clock.now());
    try {
      const passwordHash = await this.#hashPassword(request.password);
      const id = await this.options.store.createUser({
        username,
        passwordHash,
        role: "user",
        createdAt,
      });
      return { id, username, role: "user", createdAt };
    } catch {
      // Includes the UNIQUE(username) race and hashing/storage failures. Do not
      // expose driver details or imply that a session/account was established.
      throw registrationFailed();
    }
  }
}

/** PHP trim() default mask: space, tab, LF, CR, NUL and vertical tab only. */
export function normalizeRegistrationUsername(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPhpTrimCharacter(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isPhpTrimCharacter(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function validateRegistrationUsername(username: string): string | null {
  if (username === "") {
    return "Please choose a username.";
  }
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    return "Username must be 3–64 characters: letters, numbers, and _ . - only.";
  }
  return null;
}

function isPhpTrimCharacter(code: number): boolean {
  return code === 0 || code === 9 || code === 10 || code === 11 || code === 13 || code === 32;
}

function registrationFailed(): RegistrationError {
  return new RegistrationError("Could not create your account. Please try again.", "REGISTRATION_FAILED");
}
