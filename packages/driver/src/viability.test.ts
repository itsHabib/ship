/** Tests for dispatch-target viability (spec §5). */

import { afterEach, describe, expect, test, vi } from "vitest";

import type { DispatchTarget, ViabilityDeps } from "./viability.js";

import { checkTargetViability, createViabilityDeps } from "./viability.js";

function target(overrides: Partial<DispatchTarget> = {}): DispatchTarget {
  return { modelId: "m", provider: "cursor", runtime: "cloud", ...overrides };
}

function deps(overrides: Partial<ViabilityDeps> = {}): ViabilityDeps {
  return { env: {}, listCursorModels: () => Promise.resolve([]), ...overrides };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("checkTargetViability — cursor", () => {
  test("viable when the id is in the catalog", async () => {
    const result = await checkTargetViability(
      target({ modelId: "grok-4.5", provider: "cursor" }),
      deps({ listCursorModels: () => Promise.resolve(["grok-4.5", "composer-2.5"]) }),
    );
    expect(result).toEqual({ viable: true });
  });

  test("not viable when the id is absent; reason names /v1/models", async () => {
    const result = await checkTargetViability(
      target({ modelId: "ghost", provider: "cursor" }),
      deps({ listCursorModels: () => Promise.resolve(["grok-4.5"]) }),
    );
    expect(result.viable).toBe(false);
    if (result.viable) return;
    expect(result.reason).toContain("/v1/models");
  });
});

describe("checkTargetViability — claude", () => {
  test("local viable via ANTHROPIC_AUTH_TOKEN", async () => {
    const result = await checkTargetViability(
      target({ provider: "claude", runtime: "local" }),
      deps({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }),
    );
    expect(result).toEqual({ viable: true });
  });

  test("local viable via ANTHROPIC_API_KEY", async () => {
    const result = await checkTargetViability(
      target({ provider: "claude", runtime: "local" }),
      deps({ env: { ANTHROPIC_API_KEY: "k" } }),
    );
    expect(result).toEqual({ viable: true });
  });

  test("local not viable with neither credential", async () => {
    const result = await checkTargetViability(
      target({ provider: "claude", runtime: "local" }),
      deps({ env: {} }),
    );
    expect(result.viable).toBe(false);
  });

  test("cloud requires ANTHROPIC_API_KEY — AUTH_TOKEN alone is not enough", async () => {
    const result = await checkTargetViability(
      target({ provider: "claude", runtime: "cloud" }),
      deps({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }),
    );
    expect(result.viable).toBe(false);
  });

  test("cloud viable via ANTHROPIC_API_KEY", async () => {
    const result = await checkTargetViability(
      target({ provider: "claude", runtime: "cloud" }),
      deps({ env: { ANTHROPIC_API_KEY: "k" } }),
    );
    expect(result).toEqual({ viable: true });
  });
});

describe("checkTargetViability — codex", () => {
  test("viable via CODEX_API_KEY", async () => {
    const result = await checkTargetViability(
      target({ provider: "codex", runtime: "local" }),
      deps({ env: { CODEX_API_KEY: "k" } }),
    );
    expect(result).toEqual({ viable: true });
  });

  test("viable via OPENAI_API_KEY", async () => {
    const result = await checkTargetViability(
      target({ provider: "codex", runtime: "local" }),
      deps({ env: { OPENAI_API_KEY: "k" } }),
    );
    expect(result).toEqual({ viable: true });
  });

  test("not viable with neither credential", async () => {
    const result = await checkTargetViability(
      target({ provider: "codex", runtime: "local" }),
      deps({ env: {} }),
    );
    expect(result.viable).toBe(false);
  });

  test("a blank credential does not count as present", async () => {
    const result = await checkTargetViability(
      target({ provider: "codex", runtime: "local" }),
      deps({ env: { CODEX_API_KEY: "  " } }),
    );
    expect(result.viable).toBe(false);
  });
});

describe("createViabilityDeps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches /v1/models with a bearer token and parses ids", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: [{ id: "grok-4.5" }, { id: "composer-2.5" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const built = createViabilityDeps({ CURSOR_API_KEY: "secret" });
    const ids = await built.listCursorModels();
    expect(ids).toEqual(["grok-4.5", "composer-2.5"]);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toContain("/v1/models");
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  test("memoizes: many calls hit the network once", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ data: [{ id: "grok-4.5" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const built = createViabilityDeps({ CURSOR_API_KEY: "secret" });
    await built.listCursorModels();
    await built.listCursorModels();
    await built.listCursorModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("throws a legible error when CURSOR_API_KEY is missing", async () => {
    const built = createViabilityDeps({});
    await expect(built.listCursorModels()).rejects.toThrow(/CURSOR_API_KEY/);
  });

  test("throws on a non-2xx catalog response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 503 }))),
    );
    const built = createViabilityDeps({ CURSOR_API_KEY: "secret" });
    await expect(built.listCursorModels()).rejects.toThrow(/unreachable/);
  });

  test("honours the CURSOR_API_BASE_URL override", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const built = createViabilityDeps({
      CURSOR_API_BASE_URL: "https://proxy.internal",
      CURSOR_API_KEY: "secret",
    });
    await built.listCursorModels();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.internal/v1/models");
  });
});
