import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

interface RegistrationClientContract {
  readonly validateInput: (values: {
    readonly username: string;
    readonly password: string;
    readonly password2: string;
  }) => string;
  readonly classifyResponse: (result: unknown) => "authenticated" | "login_required" | "error";
}

let contract: RegistrationClientContract;

beforeAll(async () => {
  const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
  const browserWindow: Record<string, unknown> = {};
  vm.runInNewContext(source, {
    window: browserWindow,
    document: {
      getElementById: (_id: string) => null,
      querySelector: (_selector: string) => null,
    },
    TextEncoder,
  });
  const candidate = browserWindow.__dashboardRegistrationContract;
  if (!isRegistrationClientContract(candidate)) {
    throw new Error("Dashboard registration client contract was not exposed by the browser asset.");
  }
  contract = candidate;
});

describe("dashboard registration browser-JS contract", () => {
  it("matches the backend username trim, character and UTF-8 byte rules", () => {
    expect(contract.validateInput({
      username: " \tvalid.user\r\n",
      password: "12345678",
      password2: "12345678",
    })).toBe("");
    expect(contract.validateInput({
      username: "\0valid-user\0",
      password: "🙂🙂",
      password2: "🙂🙂",
    })).toBe("");
    expect(contract.validateInput({
      username: "valid-user",
      password: "🙂",
      password2: "🙂",
    })).toBe("Password must be at least 8 UTF-8 bytes.");
    expect(contract.validateInput({
      username: "valid-user",
      password: "🙂".repeat(19),
      password2: "🙂".repeat(19),
    })).toBe("Password must be at most 72 UTF-8 bytes.");
    expect(contract.validateInput({
      username: "valid-user",
      password: "12345678",
      password2: "87654321",
    })).toBe("The two passwords do not match.");
    expect(contract.validateInput({
      username: "<script>",
      password: "12345678",
      password2: "12345678",
    })).toBe("Username must be 3–64 characters: letters, numbers, and _ . - only.");
    expect(contract.validateInput({
      username: "a".repeat(65),
      password: "12345678",
      password2: "12345678",
    })).toBe("Username must be 3–64 characters: letters, numbers, and _ . - only.");
  });

  it("accepts only the exact authenticated registration success shape", () => {
    expect(contract.classifyResponse({
      status: 201,
      data: {
        ok: true,
        status: "authenticated",
        login_required: false,
        user: { username: "new-user", role: "user" },
        csrf: "a".repeat(64),
      },
    })).toBe("authenticated");

    for (const result of [
      { status: 200, data: { ok: true, status: "authenticated", login_required: false, user: { username: "new-user", role: "user" }, csrf: "a".repeat(64) } },
      { status: 201, data: { ok: true, status: "authenticated", login_required: true, user: { username: "new-user", role: "user" }, csrf: "a".repeat(64) } },
      { status: 201, data: { ok: true, status: "authenticated", login_required: false, user: { username: "new-user", role: "admin" }, csrf: "a".repeat(64) } },
      { status: 201, data: { ok: true, status: "authenticated", login_required: false, user: { username: "new-user", role: "user" }, csrf: "not-a-token" } },
      { status: 201, data: { ok: false, status: "authenticated", login_required: false, user: { username: "new-user", role: "user" }, csrf: "a".repeat(64) } },
    ]) {
      expect(contract.classifyResponse(result)).toBe("error");
    }
  });

  it("distinguishes committed-account login-required recovery from malformed success", () => {
    expect(contract.classifyResponse({
      status: 201,
      data: {
        ok: true,
        status: "account_created",
        login_required: true,
        user: { username: "new-user", role: "user" },
      },
    })).toBe("login_required");

    for (const result of [
      { status: 201, data: { ok: true, status: "account_created", login_required: false, user: { username: "new-user", role: "user" } } },
      { status: 201, data: { ok: true, status: "account_created", login_required: true, user: { username: "new-user", role: "admin" } } },
      { status: 201, data: { ok: true, status: "account_created", login_required: true } },
      { status: 201, data: null },
      null,
    ]) {
      expect(contract.classifyResponse(result)).toBe("error");
    }
  });
});

function isRegistrationClientContract(value: unknown): value is RegistrationClientContract {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.validateInput === "function" && typeof candidate.classifyResponse === "function";
}
