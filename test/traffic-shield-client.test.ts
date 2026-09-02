import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("Traffic Shield dashboard client", () => {
  it("loads lazily, formats bigint strings exactly, stores bounded seen state and closes accessibly", async () => {
    const report = shieldReport();
    const fixture = await browserFixture([{ status: 200, data: report }]);

    expect(fixture.fetchCalls).toHaveLength(0);
    fixture.button.emit("click", { stopPropagation: vi.fn() });
    await settlePromises();

    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]?.action).toBe("shield_stats");
    expect(fixture.fetchCalls[0]?.csrf).toBe("a".repeat(64));
    expect(fixture.button.attributes["aria-expanded"]).toBe("true");
    expect(fixture.lifetime.textContent).toBe("9,007,199,254,740,993");
    expect(fixture.yesterday.textContent).toBe("9,007,199,254,740,992");
    expect(fixture.historyTotal.textContent).toBe("18,014,398,509,481,985");
    expect(fixture.setItem).toHaveBeenCalledWith(
      "node-shortener:traffic-shield-seen:v1:42",
      "2026-09-01",
    );
    expect(fixture.days.children).toHaveLength(7);

    fixture.documentEmit("keydown", { key: "Escape" });
    expect(fixture.panel.classList.contains("hidden")).toBe(true);
    expect(fixture.button.focus).toHaveBeenCalledTimes(1);

    fixture.button.emit("click", { stopPropagation: vi.fn() });
    fixture.documentEmit("click", {});
    expect(fixture.panel.classList.contains("hidden")).toBe(true);
    expect(fixture.fetchCalls).toHaveLength(1);
  });

  it("shows unavailable rather than zero and retries after a received 503", async () => {
    const fixture = await browserFixture([
      { status: 503, data: { ok: false, error: "Protection report unavailable right now." } },
      { status: 200, data: shieldReport() },
    ]);

    fixture.button.emit("click", { stopPropagation: vi.fn() });
    await settlePromises();
    expect(fixture.status.textContent).toBe("Protection history is temporarily unavailable.");
    expect(fixture.lifetime.textContent).toBe("—");

    fixture.button.emit("click", { stopPropagation: vi.fn() });
    fixture.button.emit("click", { stopPropagation: vi.fn() });
    await settlePromises();
    expect(fixture.fetchCalls).toHaveLength(2);
    expect(fixture.lifetime.textContent).toBe("9,007,199,254,740,993");
  });
});

interface TestElement {
  textContent: string;
  className: string;
  readonly attributes: Record<string, string>;
  readonly children: TestElement[];
  readonly classList: {
    add: (...values: string[]) => void;
    remove: (...values: string[]) => void;
    contains: (value: string) => boolean;
  };
  readonly focus: ReturnType<typeof vi.fn>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => void;
  emit: (name: string, event: Record<string, unknown>) => void;
  append: (...children: TestElement[]) => void;
  replaceChildren: (...children: TestElement[]) => void;
}

async function browserFixture(responses: Array<{ status: number; data: unknown }>) {
  const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
  const button = element(["shield-button"]);
  const panel = element(["shield-panel", "hidden"]);
  const days = element();
  const yesterday = element();
  const lifetime = element();
  const historyTotal = element();
  const historyLabel = element();
  const status = element();
  const elements: Record<string, TestElement> = {
    shieldBell: button,
    shieldPanel: panel,
    shieldDays: days,
    shieldYesterday: yesterday,
    shieldTotal: lifetime,
    shieldHistoryTotal: historyTotal,
    shieldHistoryLabel: historyLabel,
    shieldStatus: status,
  };
  const shell = {
    dataset: {
      csrf: "a".repeat(64),
      userId: "42",
      preferenceScope: "account",
      defaultDomainId: "2",
      shieldDate: "2026-09-01",
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const documentListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (selector: string) => selector === "[data-dashboard-shell]" ? shell : null,
    querySelectorAll: () => [],
    createElement: () => element(),
    createDocumentFragment: () => element(["fragment"]),
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => {
      documentListeners.set(name, [...(documentListeners.get(name) ?? []), handler]);
    },
  };
  const fetchCalls: Array<{ action: unknown; csrf: unknown }> = [];
  const fetch = vi.fn(async (_url: string, options: { body?: FormData }) => {
    fetchCalls.push({ action: options.body?.get("action"), csrf: options.body?.get("csrf") });
    const response = responses.shift() ?? { status: 500, data: null };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => JSON.stringify(response.data),
    };
  });
  const setItem = vi.fn();
  runInNewContext(source, {
    window: { __dashboardAnalyticsDebug: [], confirm: () => true },
    document,
    localStorage: { getItem: () => null, setItem, removeItem: () => undefined },
    navigator: {},
    fetch,
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
  return {
    button,
    panel,
    days,
    yesterday,
    lifetime,
    historyTotal,
    historyLabel,
    status,
    fetchCalls,
    setItem,
    documentEmit: (name: string, event: Record<string, unknown>) => {
      for (const handler of documentListeners.get(name) ?? []) handler(event);
    },
  };
}

function element(initialClasses: readonly string[] = []): TestElement {
  const classes = new Set(initialClasses);
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const target: TestElement = {
    textContent: "",
    className: "",
    attributes: {},
    children: [],
    classList: {
      add: (...values) => { for (const value of values) classes.add(value); },
      remove: (...values) => { for (const value of values) classes.delete(value); },
      contains: (value) => classes.has(value),
    },
    focus: vi.fn(),
    setAttribute: (name, value) => { target.attributes[name] = value; },
    addEventListener: (name, handler) => {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    },
    emit: (name, event) => { for (const handler of listeners.get(name) ?? []) handler(event); },
    append: (...children) => { target.children.push(...children); },
    replaceChildren: (...children) => {
      target.children.splice(0, target.children.length);
      for (const child of children) {
        if (child.classList.contains("fragment")) target.children.push(...child.children);
        else target.children.push(child);
      }
    },
  };
  return target;
}

function shieldReport() {
  return {
    ok: true,
    total: "9007199254740993",
    history_total: "18014398509481985",
    history_state: "exact",
    history_started_at: "2026-08-25 18:30:00",
    days: [
      { label: "Today so far", iso: "2026-09-01", count: "9007199254740993", state: "exact_so_far" },
      { label: "Yesterday", iso: "2026-08-31", count: "9007199254740992", state: "exact" },
      { label: "Sun 30 Aug", iso: "2026-08-30", count: "0", state: "exact" },
      { label: "Sat 29 Aug", iso: "2026-08-29", count: "0", state: "exact" },
      { label: "Fri 28 Aug", iso: "2026-08-28", count: "0", state: "exact" },
      { label: "Thu 27 Aug", iso: "2026-08-27", count: "0", state: "exact" },
      { label: "Wed 26 Aug", iso: "2026-08-26", count: "0", state: "exact" },
    ],
  };
}

async function settlePromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
