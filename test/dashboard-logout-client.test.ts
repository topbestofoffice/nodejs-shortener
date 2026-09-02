import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("dashboard shared-author logout client", () => {
  it("clears the browser-only D3 choice on a received 503 whose response cleared cookies", async () => {
    const fixture = await browserFixture(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ ok: false, error: "Logout revocation incomplete" }),
    }));

    fixture.click();
    await settlePromises();

    expect(fixture.removeItem).toHaveBeenCalledWith("node-shortener:domain-default:v1:8");
    expect(fixture.replace).not.toHaveBeenCalled();
  });

  it("retains the preference when no HTTP response was received", async () => {
    const fixture = await browserFixture(async () => Promise.reject(new Error("network lost")));

    fixture.click();
    await settlePromises();

    expect(fixture.removeItem).not.toHaveBeenCalled();
    expect(fixture.replace).not.toHaveBeenCalled();
  });
});

async function browserFixture(fetchImpl: () => Promise<unknown>) {
  const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
  let click = (): void => { throw new Error("Logout handler was not registered."); };
  const button = {
    dataset: {} as Record<string, string>,
    textContent: "Sign out",
    disabled: false,
    addEventListener: (name: string, handler: () => void) => {
      if (name === "click") click = handler;
    },
  };
  const shell = {
    dataset: { csrf: "a".repeat(64), userId: "8", preferenceScope: "browser", defaultDomainId: "3" },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const removeItem = vi.fn();
  const replace = vi.fn();
  const document = {
    getElementById: (id: string) => id === "logoutButton" ? button : null,
    querySelector: (selector: string) => selector === "[data-dashboard-shell]" ? shell : null,
    querySelectorAll: () => [],
  };
  const window = {
    location: { replace },
    confirm: () => true,
  };
  runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem },
    navigator: {},
    fetch: fetchImpl,
    FormData,
    URLSearchParams,
    Blob,
    Response,
    Promise,
    Error,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  });
  return { click: () => click(), removeItem, replace };
}

async function settlePromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
