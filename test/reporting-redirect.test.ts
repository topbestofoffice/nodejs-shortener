import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import type {
  DeliveredCountryGapEvent,
  DeliveredCountryObservation,
  LinkRecord,
} from "../src/core/types.js";
import type { DeliveredCountryObserverStore } from "../src/ports.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("post-accounting Delivered-country observation", () => {
  it("mirrors a D3 admitted fail-open only after MariaDB accounting succeeds", async () => {
    const { store, observer, link } = await start(3);
    store.failClaims = true;

    const response = await redirect(link);

    expect(response.statusCode).toBe(301);
    expect(store.accountingEvents).toHaveLength(1);
    expect(observer.observations).toEqual([{
      domainId: 3,
      country: "IN",
      occurredAt: new Date("2026-09-01T00:05:30.000Z"),
    }]);
    expect(observer.gaps).toEqual([]);
  });

  it("keeps D2's unproved fail-open out while token-owned winners enter", async () => {
    const unavailable = await start(2);
    unavailable.store.failClaims = true;
    await redirect(unavailable.link);
    expect(unavailable.store.accountingEvents).toHaveLength(1);
    expect(unavailable.observer.observations).toEqual([]);
    expect(unavailable.observer.gaps.map((gap) => gap.reason)).toEqual(["claim"]);
    await app?.close();
    app = undefined;

    const winner = await start(2);
    await redirect(winner.link);
    expect(winner.observer.observations).toHaveLength(1);
    expect(winner.observer.gaps).toEqual([]);
  });

  it("excludes confirmed duplicates and non-Delivered outcomes", async () => {
    const duplicate = await start(3);
    await redirect(duplicate.link);
    await redirect(duplicate.link);
    expect(duplicate.store.accountingEvents).toHaveLength(1);
    expect(duplicate.observer.observations).toHaveLength(1);
    await app?.close();
    app = undefined;

    const filtered = await start(3, {
      diverted: false,
      filterReason: "meta",
    });
    await redirect(filtered.link);
    expect(filtered.store.accountingEvents[0]?.outcome).toBe("filtered_meta");
    expect(filtered.observer.observations).toEqual([]);
    expect(filtered.observer.gaps).toEqual([]);
  });

  it("never observes an accounting failure and latches the exact gap", async () => {
    const { store, observer, link } = await start(3);
    store.failAccounting = true;

    const response = await redirect(link);

    expect(response.statusCode).toBe(301);
    expect(observer.observations).toEqual([]);
    expect(observer.gaps.map((gap) => gap.reason)).toEqual(["accounting"]);
  });

  it("uses trusted reportCountry only and latches observer failure", async () => {
    const { store, observer, link } = await start(3, { reportCountry: null, country: "US" });
    observer.failObservation = true;

    await redirect(link);

    expect(store.accountingEvents[0]?.country).toBeNull();
    expect(observer.attempts[0]?.country).toBeNull();
    expect(observer.observations).toEqual([]);
    expect(observer.gaps.map((gap) => gap.reason)).toEqual(["observer"]);
  });
});

async function start(
  domainId: 2 | 3,
  decisionOverrides: Partial<{
    diverted: boolean;
    filterReason: "meta" | null;
    reportCountry: string | null;
    country: string | null;
  }> = {},
): Promise<{
  store: InMemoryApplicationStore;
  observer: RecordingObserver;
  link: LinkRecord;
}> {
  const store = new InMemoryApplicationStore(domainPolicies);
  const observer = new RecordingObserver([2, 3]);
  Object.assign(store, { deliveredCountryObserver: observer });
  const link: LinkRecord = domainId === 2
    ? baseLink
    : {
        ...baseLink,
        id: "9007199254740994",
        domainId: 3,
        domainHostname: "plays9x.local",
        domainLabel: "Plays9X",
        diversionCampaign: "plays9x",
      };
  store.seedLink(link);
  app = await buildApplication({
    config: testConfig,
    stores: store,
    clock: { now: () => new Date("2026-09-01T00:05:30.000Z") },
    decisions: {
      decide: async () => ({
        target: link.destination,
        diverted: decisionOverrides.diverted ?? false,
        filterReason: decisionOverrides.filterReason ?? null,
        country: decisionOverrides.country ?? "US",
        reportCountry: decisionOverrides.reportCountry === undefined ? "IN" : decisionOverrides.reportCountry,
        dynamicDiversionEnabled: false,
        block: null,
      }),
    },
  });
  return { store, observer, link };
}

async function redirect(link: LinkRecord) {
  if (app === undefined) {
    throw new Error("Test application is unavailable.");
  }
  return app.inject({
    method: "GET",
    url: `/${link.code}`,
    headers: {
      host: link.domainHostname,
      "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36",
    },
  });
}

class RecordingObserver implements DeliveredCountryObserverStore {
  public readonly attempts: DeliveredCountryObservation[] = [];
  public readonly observations: DeliveredCountryObservation[] = [];
  public readonly gaps: DeliveredCountryGapEvent[] = [];
  public failObservation = false;
  readonly #enabled: ReadonlySet<number>;

  public constructor(enabled: readonly number[]) {
    this.#enabled = new Set(enabled);
  }

  public isEnabled(domainId: number): boolean {
    return this.#enabled.has(domainId);
  }

  public async observe(event: DeliveredCountryObservation): Promise<void> {
    this.attempts.push(structuredClone(event));
    if (this.failObservation) {
      throw new Error("Injected observer failure");
    }
    this.observations.push(structuredClone(event));
  }

  public async markGap(event: DeliveredCountryGapEvent): Promise<void> {
    this.gaps.push(structuredClone(event));
  }
}
