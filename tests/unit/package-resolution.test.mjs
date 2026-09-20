import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePackageVersions,
  fetchJson,
  isFoundryCompatible,
  selectNewestCompatiblePackage,
} from "../integration/package-resolution.mjs";

test("GitHub requests authenticate and honor the primary rate-limit reset", async () => {
  const requests = [];
  const delays = [];
  const responses = [
    new Response("rate limit exceeded", {
      status: 403,
      statusText: "Forbidden",
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1002" },
    }),
    Response.json({ ok: true }),
  ];

  const result = await fetchJson("https://api.github.test/releases", "test-token", {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    sleep: async delay => delays.push(delay),
    now: () => 1_000_000,
    random: () => 0,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(delays, [3_000]);
});

test("GitHub secondary limits and 429 responses retry with server-directed delays", async () => {
  for (const response of [
    new Response("secondary rate limit", { status: 403, headers: { "retry-after": "4" } }),
    new Response("too many requests", { status: 429, headers: { "retry-after": "2" } }),
  ]) {
    const delays = [];
    const responses = [response, Response.json({ ok: true })];
    await fetchJson("https://api.github.test/releases", null, {
      fetchImpl: async () => responses.shift(),
      sleep: async delay => delays.push(delay),
      random: () => 0,
    });
    assert.deepEqual(delays, [Number(response.headers.get("retry-after")) * 1_000]);
  }
});

test("ordinary permission failures do not consume the retry budget", async () => {
  let requests = 0;
  await assert.rejects(fetchJson("https://api.github.test/releases", null, {
    fetchImpl: async () => {
      requests += 1;
      return new Response("resource forbidden", { status: 403, statusText: "Forbidden" });
    },
    sleep: async () => assert.fail("non-rate-limit 403 must not retry"),
  }), /403 Forbidden/);
  assert.equal(requests, 1);
});

test("package versions are ordered numerically across tag styles", () => {
  assert.equal(comparePackageVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(comparePackageVersions("5.3.3", "5.3.3"), 0);
});

test("generation-only maximum accepts every build in that generation", () => {
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "13", maximum: "14" } }, "14.368"), true);
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "14.369", maximum: "14" } }, "14.368"), false);
  assert.equal(isFoundryCompatible({ compatibility: { minimum: "13", maximum: "13" } }, "14.368"), false);
});

test("resolver selects the newest release that actually supports the Foundry build", () => {
  const candidate = (version, compatibility) => ({
    manifestUrl: `https://example.invalid/${version}/system.json`,
    manifest: { id: "example", version, compatibility, download: `https://example.invalid/${version}.zip` },
  });
  const selected = selectNewestCompatiblePackage([
    candidate("2.0.0", { minimum: "15" }),
    candidate("1.10.0", { minimum: "14", maximum: "14" }),
    candidate("1.9.0", { minimum: "14", maximum: "14" }),
  ], "example", "14.368");
  assert.equal(selected.manifest.version, "1.10.0");
});

test("resolver fails instead of silently installing an incompatible package", () => {
  assert.throws(() => selectNewestCompatiblePackage([{
    manifestUrl: "https://example.invalid/system.json",
    manifest: { id: "example", version: "2.0.0", compatibility: { minimum: "15" }, download: "x" },
  }], "example", "14.368"), /No example release is compatible/);
});
