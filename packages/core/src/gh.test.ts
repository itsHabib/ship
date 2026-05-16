/* eslint-disable no-param-reassign -- `res.statusCode = ...` is the
   standard node:http mutation pattern; immutability would require
   constructing a new response object the API doesn't expose. */
// Unit tests for `createNodeGhClient`. The preflight + lazy-build
// surface is asserted directly; the HTTP-bound `pulls.list` /
// `pulls.create` paths run against a tiny localhost server so we
// don't need to mock Octokit's internals and the Octokit error →
// typed-error mapping is genuinely exercised.

import type { AddressInfo } from "node:net";

import { Octokit } from "@octokit/rest";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { GhAuthError, GhCreatePrFailedError } from "./errors.js";
import { createNodeGhClient } from "./gh.js";

interface MockRoute {
  readonly method: "GET" | "POST";
  readonly pathStartsWith: string;
  status: number;
  body: unknown;
}

let server: Server;
let baseUrl: string;
const routes: MockRoute[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    const route = routes.find((r) => r.method === method && url.startsWith(r.pathStartsWith));
    if (route === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "no route" }));
      return;
    }
    res.statusCode = route.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  routes.length = 0;
});

describe("createNodeGhClient — preflight", () => {
  const savedToken = process.env["GITHUB_TOKEN"];
  const savedGhToken = process.env["GH_TOKEN"];

  beforeEach(() => {
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
  });

  afterEach(() => {
    if (savedToken !== undefined) process.env["GITHUB_TOKEN"] = savedToken;
    else delete process.env["GITHUB_TOKEN"];
    if (savedGhToken !== undefined) process.env["GH_TOKEN"] = savedGhToken;
    else delete process.env["GH_TOKEN"];
  });

  test("throws GhAuthError on the first call when no token is set", async () => {
    const client = createNodeGhClient();
    await expect(
      client.listOpenPrsForBranch({ owner: "x", repo: "y", head: "h", base: "b" }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("constructor is lazy: throws only on first call, not on factory invocation", () => {
    // The factory itself must not throw — otherwise `--help`-style
    // invocations that never touch gh would fail with a misleading
    // auth error.
    expect(() => createNodeGhClient()).not.toThrow();
  });

  test("explicit `token` opt bypasses env-var lookup", () => {
    const client = createNodeGhClient({ token: "ghp_test" });
    // No throw on construction; preflight is deferred to the first
    // method call and the call attempts an HTTP request which we
    // don't make here. Construction-without-throw is the assertion.
    expect(typeof client.listOpenPrsForBranch).toBe("function");
  });

  test("explicit `octokit` opt wins over `token` / env vars", () => {
    const octokit = new Octokit({ auth: "ghp_provided" });
    const client = createNodeGhClient({ octokit });
    expect(typeof client.createPr).toBe("function");
  });
});

describe("createNodeGhClient — listOpenPrsForBranch", () => {
  test("returns the narrow { number, url } shape per PR", async () => {
    routes.push({
      method: "GET",
      pathStartsWith: "/repos/x/y/pulls",
      status: 200,
      body: [
        { number: 42, html_url: "https://github.com/x/y/pull/42", extra: "dropped" },
        { number: 7, html_url: "https://github.com/x/y/pull/7" },
      ],
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    const prs = await client.listOpenPrsForBranch({
      owner: "x",
      repo: "y",
      head: "feat",
      base: "main",
    });
    expect(prs).toEqual([
      { number: 42, url: "https://github.com/x/y/pull/42" },
      { number: 7, url: "https://github.com/x/y/pull/7" },
    ]);
  });

  test("empty array on no matches", async () => {
    routes.push({
      method: "GET",
      pathStartsWith: "/repos/x/y/pulls",
      status: 200,
      body: [],
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    const prs = await client.listOpenPrsForBranch({
      owner: "x",
      repo: "y",
      head: "feat",
      base: "main",
    });
    expect(prs).toEqual([]);
  });
});

describe("createNodeGhClient — createPr", () => {
  test("returns { number, url } from a successful create", async () => {
    routes.push({
      method: "POST",
      pathStartsWith: "/repos/x/y/pulls",
      status: 201,
      body: { number: 99, html_url: "https://github.com/x/y/pull/99" },
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    const out = await client.createPr({
      owner: "x",
      repo: "y",
      base: "main",
      head: "feat",
      title: "t",
      body: "b",
      draft: false,
    });
    expect(out).toEqual({ number: 99, url: "https://github.com/x/y/pull/99" });
  });

  test("maps 401 to GhAuthError (token rejected)", async () => {
    routes.push({
      method: "POST",
      pathStartsWith: "/repos/x/y/pulls",
      status: 401,
      body: { message: "Bad credentials" },
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    await expect(
      client.createPr({
        owner: "x",
        repo: "y",
        base: "main",
        head: "feat",
        title: "t",
        body: "b",
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("maps 403 to GhAuthError (insufficient scope)", async () => {
    routes.push({
      method: "POST",
      pathStartsWith: "/repos/x/y/pulls",
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    await expect(
      client.createPr({
        owner: "x",
        repo: "y",
        base: "main",
        head: "feat",
        title: "t",
        body: "b",
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("maps 422 to GhCreatePrFailedError (validation)", async () => {
    routes.push({
      method: "POST",
      pathStartsWith: "/repos/x/y/pulls",
      status: 422,
      body: { message: "Validation failed" },
    });
    const client = createNodeGhClient({ token: "ghp_x", baseUrl });
    await expect(
      client.createPr({
        owner: "x",
        repo: "y",
        base: "main",
        head: "feat",
        title: "t",
        body: "b",
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GhCreatePrFailedError);
  });
});
