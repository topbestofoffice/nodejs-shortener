import { describe, expect, it } from "vitest";
import { DomainRegistry, normalizeRequestHost } from "../src/config/domain-registry.js";

describe("normalizeRequestHost", () => {
  it.each([
    ["URL6X.COM", "url6x.com"],
    ["url6x.com.:443", "url6x.com"],
    ["www.url6x.com", "www.url6x.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRequestHost(input)).toBe(expected);
  });

  it.each(["", "bad host", "a.com:99999", "a.com:abc", "a.com/path", "[::1]"])("rejects %s", (input) => {
    expect(normalizeRequestHost(input)).toBeNull();
  });
});

describe("DomainRegistry", () => {
  it("maps canonical and alias hosts without changing the domain identity", () => {
    const registry = new DomainRegistry([{
      id: 7,
      key: "single",
      canonicalHost: "go.example",
      aliases: ["www.go.example"],
      label: "GO",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      publicBaseUrl: "https://go.example/",
      imageBaseUrl: "https://images.example/",
    }]);
    expect(registry.resolve("go.example").definition.id).toBe(7);
    expect(registry.resolve("go.example").definition).toMatchObject({
      publicBaseUrl: "https://go.example",
      imageBaseUrl: "https://images.example",
      compactNoImagePreview: false,
      creationFallback: false,
      acceptUnprovenDeliveredClaim: false,
    });
    expect(registry.resolve("www.go.example").isCanonical).toBe(false);
    expect(() => registry.resolve("unknown.example")).toThrow("Misdirected request");
  });

  it("accepts exactly one active creatable fallback and rejects ambiguous or paused fallbacks", () => {
    const domain = (id: number, creationFallback: boolean, allowCreate = true) => ({
      id,
      key: `short${id}`,
      canonicalHost: `go${id}.example`,
      aliases: [],
      label: `GO ${id}`,
      surface: "dashboard" as const,
      active: true,
      allowCreate,
      creationFallback,
      publicBaseUrl: `https://go${id}.example`,
      imageBaseUrl: `https://go${id}.example`,
    });

    expect(new DomainRegistry([domain(7, true)]).byId(7)?.creationFallback).toBe(true);
    expect(() => new DomainRegistry([domain(7, true), domain(8, true)]))
      .toThrow("Only one domain can be the creation fallback");
    expect(() => new DomainRegistry([domain(7, true, false)]))
      .toThrow("creation fallback must be active and allow link creation");
  });
});
