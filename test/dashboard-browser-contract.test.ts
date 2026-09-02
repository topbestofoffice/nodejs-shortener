import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("dashboard browser parity behavior", () => {
  it("expires stale/future Quick Reuse entries, deduplicates them and persists a bounded versioned record", async () => {
    const now = Date.now();
    const storage = new Map<string, string>();
    storage.set("node-shortener:quick-reuse:v1:42", JSON.stringify({
      version: 1,
      items: [
        entry("https://valid.example/a", 2, now - 1_000),
        entry("https://valid.example/a", 7, now - 2_000),
        entry("https://expired.example/", 9, now - (31 * 24 * 60 * 60 * 1_000)),
        entry("https://future.example/", 9, now + (6 * 60 * 1_000)),
      ],
    }));
    const fixture = await browserFixture(storage);

    expect(fixture.hooks.readQuickReuse()).toEqual([expect.objectContaining({
      destination: "https://valid.example/a",
      count: 7,
    })]);
    fixture.hooks.recordQuickReuse([{ destination: "https://new.example/", title: "New", description: "" }]);
    const persisted = JSON.parse(storage.get("node-shortener:quick-reuse:v1:42") ?? "null") as {
      version: number;
      items: unknown[];
    };
    expect(persisted.version).toBe(1);
    expect(persisted.items.length).toBeLessThanOrEqual(20);
  });

  it("does not save an old Remember choice after the domain preference revision changes", async () => {
    const fixture = await browserFixture(new Map());

    fixture.rememberInputs[0]!.checked = true;
    fixture.rememberInputs[0]!.emitChange();
    fixture.hooks.rememberDomainAfterComplete("3", true, 0);

    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.setItem).not.toHaveBeenCalled();
  });

  it("saves an explicit browser default immediately", async () => {
    const fixture = await browserFixture(new Map());

    await fixture.hooks.saveDefaultDomain("3", false);

    expect(fixture.setItem).toHaveBeenCalledWith("node-shortener:domain-default:v1:42", "3");
  });

  it("never assigns a deferred image source while the document is hidden", async () => {
    const fixture = await browserFixture(new Map());
    const attributes = new Map([["data-dashboard-src", "https://img.example/picture.jpg"]]);
    const image = {
      src: "",
      hidden: true,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => { attributes.delete(name); },
      getBoundingClientRect: () => ({ width: 50, height: 50, top: 0, left: 0, right: 50, bottom: 50 }),
    };
    const scope = { querySelectorAll: () => [image] };

    fixture.document.visibilityState = "hidden";
    fixture.hooks.observeImages(scope);
    expect(image.src).toBe("");
    expect(attributes.has("data-dashboard-src")).toBe(true);

    fixture.document.visibilityState = "visible";
    fixture.hooks.observeImages(scope);
    expect(image.src).toBe("https://img.example/picture.jpg");
    expect(attributes.has("data-dashboard-src")).toBe(false);
  });

  it("buckets create attempts and repeated image identities without exposing the identity", async () => {
    const fixture = await browserFixture(new Map());

    expect([
      fixture.hooks.nextCreateAttemptBucket("single"),
      fixture.hooks.nextCreateAttemptBucket("single"),
      fixture.hooks.nextCreateAttemptBucket("single"),
      fixture.hooks.nextCreateAttemptBucket("bulk"),
    ]).toEqual(["first", "second", "third_plus", "first"]);
    expect([
      fixture.hooks.nextSingleImageSequenceBucket("private-token"),
      fixture.hooks.nextSingleImageSequenceBucket("private-token"),
      fixture.hooks.nextSingleImageSequenceBucket("private-token"),
      fixture.hooks.nextSingleImageSequenceBucket(null),
    ]).toEqual(["first", "second", "third_plus", "not_applicable"]);
  });

  it("attributes Quick Reuse only to an exact pending mode and destination", async () => {
    const fixture = await browserFixture(new Map());
    fixture.hooks.markQuickReusePending("single", "https://target.example/a");

    expect(fixture.hooks.quickReuseWasUsed("single", [{ destination: "https://target.example/a" }])).toBe(true);
    expect(fixture.hooks.quickReuseWasUsed("bulk", [{ destination: "https://target.example/a" }])).toBe(false);
    expect(fixture.hooks.quickReuseWasUsed("single", [{ destination: "https://target.example/b" }])).toBe(false);
  });

  it("replaces the destination in one-link-per-image mode and clears live attribution with the real Clear handler", async () => {
    const fixture = await browserFixture(new Map());
    fixture.bulk.urls.value = "https://old.example/";

    fixture.hooks.applyQuickReuse({
      destination: "https://target.example/a",
      title: "Reused title",
      description: "Reused description",
    });

    expect(fixture.bulk.urls.value).toBe("https://target.example/a");
    expect(fixture.hooks.quickReuseWasUsed("bulk", [{ destination: "https://target.example/a" }])).toBe(true);
    fixture.clearQuickReuse.emitClick();
    expect(fixture.hooks.quickReuseWasUsed("bulk", [{ destination: "https://target.example/a" }])).toBe(false);
  });

  it("bridges one uploaded File identity to its retained managed path", async () => {
    const fixture = await browserFixture(new Map());
    const file = {};
    const picker = { files: [file] as unknown[] };
    const imageUrl = { value: "" };
    const form = {
      dataset: {} as Record<string, string>,
      querySelector: (selector: string) => selector === "input[name=upload_image]" ? picker
        : selector === "input[name=image_url]" ? imageUrl : null,
    };

    const uploadedIdentity = fixture.hooks.currentSingleImageIdentity(form);
    expect(fixture.hooks.nextSingleImageSequenceBucket(uploadedIdentity)).toBe("first");
    fixture.hooks.rememberRetainedSingleImageIdentity("uploads/0123456789abcdef.jpg", uploadedIdentity);
    picker.files = [];
    form.dataset.retainedImagePath = "uploads/0123456789abcdef.jpg";
    const retainedIdentity = fixture.hooks.currentSingleImageIdentity(form);

    expect(retainedIdentity).toBe(uploadedIdentity);
    expect(fixture.hooks.nextSingleImageSequenceBucket(retainedIdentity)).toBe("second");
  });

  it("classifies a real image without Resource Timing as unavailable, not no-image", async () => {
    const fixture = await browserFixture(new Map());
    const image = {
      currentSrc: "https://img.example/picture.jpg",
      src: "https://img.example/picture.jpg",
      hasAttribute: () => false,
    };
    const deferred = { ...image, hasAttribute: (name: string) => name === "data-dashboard-src" };

    expect(fixture.hooks.postCreateTransferBucket(image, 0)).toBe("unavailable");
    expect(fixture.hooks.postCreateTransferBucket(deferred, 0)).toBe("none");
  });

  it("uses the authenticated runtime bulk limits for URL counting and remaining image slots", async () => {
    const fixture = await browserFixture(new Map(), { maxBulkLinks: 17, maxBulkImages: 19 });

    expect(fixture.hooks.runtimeBulkLimits()).toEqual({ links: 17, images: 19 });
    expect(fixture.hooks.bulkDestinationCount(" https://one.example/\r\n\rhttps://two.example/\n \nhttps://three.example/ ")).toBe(3);
    expect(fixture.hooks.availableBulkUploadSlots(7, 5)).toBe(7);
    expect(fixture.hooks.availableBulkUploadSlots(19, 1)).toBe(0);
  });
});

interface BrowserHooks {
  readQuickReuse: () => Array<Record<string, unknown>>;
  recordQuickReuse: (records: Array<Record<string, string>>) => void;
  rememberDomainAfterComplete: (domainId: string, requested: boolean, revision: number) => void;
  saveDefaultDomain: (domainId: string, afterCreate: boolean) => Promise<boolean>;
  advancePreferenceRevision: () => void;
  loadDeferredImage: (image: { src: string; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void }) => void;
  observeImages: (scope: { querySelectorAll: () => unknown[] }) => void;
  nextCreateAttemptBucket: (mode: string) => string;
  nextSingleImageSequenceBucket: (identity: string | null) => string;
  markQuickReusePending: (mode: string, destination: string) => void;
  quickReuseWasUsed: (mode: string, records: Array<{ destination: string }>) => boolean;
  postCreateTransferBucket: (image: { currentSrc: string; src: string; hasAttribute: (name: string) => boolean }, startedAt: number) => string;
  applyQuickReuse: (entry: { destination: string; title: string; description: string }) => void;
  currentSingleImageIdentity: (form: {
    dataset: Record<string, string>;
    querySelector: (selector: string) => unknown;
  }) => string | null;
  rememberRetainedSingleImageIdentity: (path: string, identity: string | null) => void;
  runtimeBulkLimits: () => { links: number; images: number };
  bulkDestinationCount: (value: string) => number;
  availableBulkUploadSlots: (readyCount: number, busyCount: number) => number;
}

async function browserFixture(
  storage: Map<string, string>,
  limits: { readonly maxBulkLinks?: number; readonly maxBulkImages?: number } = {},
) {
  const original = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
  const source = original.replace(/\n\}\)\(\);\s*$/, `
  window.__dashboardTestHooks = {
    readQuickReuse: readQuickReuse,
    recordQuickReuse: recordQuickReuse,
    rememberDomainAfterComplete: rememberDomainAfterComplete,
    saveDefaultDomain: saveDefaultDomain,
    advancePreferenceRevision: function () { domainPreferenceRevision += 1; },
    loadDeferredImage: loadDeferredImage,
    observeImages: observeImages,
    nextCreateAttemptBucket: nextCreateAttemptBucket,
    nextSingleImageSequenceBucket: nextSingleImageSequenceBucket,
    markQuickReusePending: function (mode, destination) {
      quickReusePendingMode = mode;
      quickReusePendingDestinations.clear();
      quickReusePendingDestinations.add(destination);
    },
    quickReuseWasUsed: quickReuseWasUsed,
    postCreateTransferBucket: postCreateTransferBucket,
    applyQuickReuse: applyQuickReuse,
    currentSingleImageIdentity: currentSingleImageIdentity,
    rememberRetainedSingleImageIdentity: rememberRetainedSingleImageIdentity,
    runtimeBulkLimits: function () { return { links: maxBulkLinks, images: maxBulkImages }; },
    bulkDestinationCount: bulkDestinationCount,
    availableBulkUploadSlots: availableBulkUploadSlots
  };
})();`);
  const selects = [select("2"), select("2")];
  const rememberInputs = [rememberInput(), rememberInput()];
  const clearQuickReuse = clickTarget();
  const bulk = {
    urls: textField(),
    title: textField(),
    description: textField(),
  };
  const bulkForm = {
    querySelector: (selector: string) => selector === "[name=bulk_urls]" ? bulk.urls
      : selector === "[name=bulk_title]" ? bulk.title
        : selector === "[name=bulk_description]" ? bulk.description : null,
    addEventListener: () => undefined,
  };
  const elements = new Map<string, unknown>([
    ["singleDomain", selects[0]],
    ["bulkDomain", selects[1]],
    ["clearQuickReuse", clearQuickReuse],
    ["bulkPanel", { hidden: false }],
    ["bulkLinkForm", bulkForm],
    ["oneLinkPerImage", { checked: true }],
  ]);
  const shell = {
    dataset: {
      csrf: "a".repeat(64),
      userId: "42",
      preferenceScope: "browser",
      defaultDomainId: "2",
      maxBulkLinks: String(limits.maxBulkLinks ?? 100),
      maxBulkImages: String(limits.maxBulkImages ?? 100),
      shieldDate: "2026-09-01",
      analyticsEnabled: "0",
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const document = {
    visibilityState: "visible",
    readyState: "loading",
    head: null,
    documentElement: { clientHeight: 800, clientWidth: 1200 },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === "[data-dashboard-shell]" ? shell : null,
    querySelectorAll: (selector: string) => selector === "[data-domain-select]" ? selects
      : selector === "[data-remember-domain]" ? rememberInputs : [],
    addEventListener: () => undefined,
    createElement: () => ({ append: () => undefined }),
  };
  const setItem = vi.fn((key: string, value: string) => { storage.set(key, value); });
  const fetch = vi.fn();
  const window = {
    __dashboardTestHooks: undefined as BrowserHooks | undefined,
    confirm: () => true,
    addEventListener: () => undefined,
    location: { origin: "https://url6x.local", pathname: "/index.php", href: "https://url6x.local/index.php" },
  };
  runInNewContext(source, {
    window,
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem,
      removeItem: (key: string) => { storage.delete(key); },
    },
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
    Date,
    URL,
    Set,
    Map,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  });
  if (window.__dashboardTestHooks === undefined) throw new Error("Dashboard test hooks were not injected.");
  return { hooks: window.__dashboardTestHooks, document, fetch, setItem, rememberInputs, bulk, clearQuickReuse };
}

function select(value: string) {
  return {
    value,
    options: [{ value: "2" }, { value: "3" }],
    addEventListener: () => undefined,
  };
}

function entry(destination: string, count: number, lastUsed: number) {
  return { destination, title: "Title", description: "Description", count, lastUsed };
}

function rememberInput() {
  let change = (): void => undefined;
  return {
    checked: false,
    disabled: false,
    addEventListener: (name: string, handler: () => void) => { if (name === "change") change = handler; },
    emitChange: () => change(),
  };
}

function textField() {
  return { value: "", focus: () => undefined };
}

function clickTarget() {
  let click = (): void => undefined;
  return {
    addEventListener: (name: string, handler: () => void) => { if (name === "click") click = handler; },
    emitClick: () => click(),
  };
}
