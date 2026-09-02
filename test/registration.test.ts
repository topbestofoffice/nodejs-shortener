import { describe, expect, it } from "vitest";
import {
  type CreateRegisteredUserInput,
  RegistrationError,
  RegistrationService,
  type RegistrationStore,
  normalizeRegistrationUsername,
  validateRegistrationUsername,
} from "../src/modules/auth/registration.js";
import { verifyPhpPassword } from "../src/modules/auth/passwords.js";

const fixedDate = new Date("2026-08-23T12:00:00.000Z");
const fixedClock = { now: () => new Date(fixedDate) };

describe("RegistrationService PHP parity", () => {
  it("uses PHP trim semantics without lowercasing the username", () => {
    expect(normalizeRegistrationUsername("\0\v \tCase.User-1\r\n")).toBe("Case.User-1");
    expect(normalizeRegistrationUsername("\u00a0Case.User-1\u00a0")).toBe("\u00a0Case.User-1\u00a0");
  });

  it.each([
    ["", "Please choose a username."],
    ["ab", "Username must be 3–64 characters: letters, numbers, and _ . - only."],
    ["a".repeat(65), "Username must be 3–64 characters: letters, numbers, and _ . - only."],
    ["user@example", "Username must be 3–64 characters: letters, numbers, and _ . - only."],
    ["\u00a0user\u00a0", "Username must be 3–64 characters: letters, numbers, and _ . - only."],
  ])("returns the exact username validation message for %j", (username, message) => {
    expect(validateRegistrationUsername(username)).toBe(message);
  });

  it("accepts the exact 3-64 ASCII username alphabet", () => {
    expect(validateRegistrationUsername("a_-")).toBeNull();
    expect(validateRegistrationUsername(`A.${"b".repeat(61)}-`)).toBeNull();
  });

  it("keeps public-validation order and exact messages", async () => {
    const { service } = fixture();

    await expect(service.register({
      username: "x",
      password: "short",
      passwordConfirmation: "different",
    })).rejects.toMatchObject({
      code: "INVALID_USERNAME",
      message: "Username must be 3–64 characters: letters, numbers, and _ . - only.",
    });
    await expect(service.register({
      username: "valid-user",
      password: "1234567",
      passwordConfirmation: "1234567",
    })).rejects.toMatchObject({
      code: "INVALID_PASSWORD",
      message: "Password must be at least 8 characters.",
    });
    await expect(service.register({
      username: "valid-user",
      password: "😀".repeat(19),
      passwordConfirmation: "😀".repeat(19),
    })).rejects.toMatchObject({
      code: "INVALID_PASSWORD",
      message: "Password must be at most 72 UTF-8 bytes.",
    });
    await expect(service.register({
      username: "valid-user",
      password: "12345678",
      passwordConfirmation: "87654321",
    })).rejects.toMatchObject({
      code: "PASSWORD_MISMATCH",
      message: "The two passwords do not match.",
    });
  });

  it("counts the password with PHP strlen-compatible UTF-8 bytes and does not trim it", async () => {
    const hashedPasswords: string[] = [];
    const { service, store } = fixture({
      hashPassword: async (password) => {
        hashedPasswords.push(password);
        return "synthetic-php-hash";
      },
    });

    await expect(service.register({
      username: "emoji-user",
      password: "😀😀",
      passwordConfirmation: "😀😀",
    })).resolves.toMatchObject({ username: "emoji-user" });
    await expect(service.register({
      username: "space-user",
      password: "        ",
      passwordConfirmation: "        ",
    })).resolves.toMatchObject({ username: "space-user" });
    expect(hashedPasswords).toEqual(["😀😀", "        "]);
    expect(store.created).toHaveLength(2);
  });

  it("checks uniqueness after PHP-style normalization and keeps case significant", async () => {
    const { service, store } = fixture();
    store.existing.add("CaseUser");

    await expect(service.register({
      username: " \tCaseUser\r\n",
      password: "password",
      passwordConfirmation: "password",
    })).rejects.toEqual(new RegistrationError(
      "That username is taken — please choose another.",
      "USERNAME_TAKEN",
    ));
    await expect(service.register({
      username: "caseuser",
      password: "password",
      passwordConfirmation: "password",
    })).resolves.toMatchObject({ username: "caseuser" });
    expect(store.lookups).toEqual(["CaseUser", "caseuser"]);
  });

  it("uses the existing PHP-compatible password hasher and forces role=user", async () => {
    const store = new FakeRegistrationStore();
    const service = new RegistrationService({ store, clock: fixedClock });
    const password = "correct horse battery staple";

    const result = await service.register({
      username: "  New.User  ",
      password,
      passwordConfirmation: password,
    });

    expect(result).toEqual({ id: 101, username: "New.User", role: "user", createdAt: fixedDate });
    expect(store.created).toHaveLength(1);
    const created = store.created[0];
    expect(created).toBeDefined();
    expect(Object.keys(created ?? {}).sort()).toEqual(["createdAt", "passwordHash", "role", "username"]);
    expect(created).not.toHaveProperty("email");
    expect(created).not.toHaveProperty("defaultDomainId");
    expect(created).not.toHaveProperty("password");
    expect(created).toMatchObject({ username: "New.User", role: "user", createdAt: fixedDate });
    expect(created?.passwordHash.startsWith("$2y$")).toBe(true);
    await expect(verifyPhpPassword(password, created?.passwordHash ?? "")).resolves.toBe(true);
  });

  it("converts a username lookup failure into the generic public error", async () => {
    const { service, store } = fixture();
    store.lookupError = new Error("synthetic database hostname and driver detail");

    await expect(service.register(validRequest("lookup-user"))).rejects.toMatchObject({
      code: "REGISTRATION_FAILED",
      message: "Could not create your account. Please try again.",
    });
    await expect(service.register(validRequest("lookup-user"))).rejects.not.toThrow(/hostname|driver/i);
    expect(store.created).toEqual([]);
  });

  it("converts a duplicate race or any create failure into the same generic error", async () => {
    const { service, store } = fixture();
    const duplicate = new Error("Duplicate entry 'race-user' for UNIQUE username") as Error & { code: string };
    duplicate.code = "ER_DUP_ENTRY";
    store.createError = duplicate;

    await expect(service.register(validRequest("race-user"))).rejects.toEqual(new RegistrationError(
      "Could not create your account. Please try again.",
      "REGISTRATION_FAILED",
    ));
    expect(store.lookups).toEqual(["race-user"]);
    expect(store.created).toEqual([]);
  });

  it("also hides hashing failures and never calls the store create method", async () => {
    const { service, store } = fixture({
      hashPassword: async () => {
        throw new Error("synthetic hashing implementation detail");
      },
    });

    await expect(service.register(validRequest("hash-user"))).rejects.toMatchObject({
      code: "REGISTRATION_FAILED",
      message: "Could not create your account. Please try again.",
    });
    expect(store.created).toEqual([]);
  });
});

class FakeRegistrationStore implements RegistrationStore {
  public readonly existing = new Set<string>();
  public readonly lookups: string[] = [];
  public readonly created: CreateRegisteredUserInput[] = [];
  public lookupError: Error | null = null;
  public createError: Error | null = null;

  public async usernameExists(username: string): Promise<boolean> {
    this.lookups.push(username);
    if (this.lookupError !== null) {
      throw this.lookupError;
    }
    return this.existing.has(username);
  }

  public async createUser(input: CreateRegisteredUserInput): Promise<number> {
    if (this.createError !== null) {
      throw this.createError;
    }
    this.created.push(structuredClone(input));
    this.existing.add(input.username);
    return 100 + this.created.length;
  }
}

function fixture(overrides: {
  readonly hashPassword?: (password: string) => Promise<string>;
} = {}): { service: RegistrationService; store: FakeRegistrationStore } {
  const store = new FakeRegistrationStore();
  return {
    store,
    service: new RegistrationService({
      store,
      clock: fixedClock,
      hashPassword: overrides.hashPassword ?? (async () => "synthetic-php-hash"),
    }),
  };
}

function validRequest(username: string) {
  return { username, password: "password", passwordConfirmation: "password" };
}
