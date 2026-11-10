import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Load the Cloudflare module as an isolated ESM data URL; no package.json or live secrets required.
const source = await readFile(new URL("../deepseek-worker.js", import.meta.url), "utf8");
const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

let upstreamCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  upstreamCalls += 1;
  throw new Error("Unexpected upstream request in a negative-path Worker test.");
};

async function call(path, { method = "POST", token, env = {}, body = "{}", headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token !== undefined) requestHeaders.set("Authorization", "Bearer " + token);
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    if (!requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
  }
  const request = new Request("https://worker.test" + path, {
    method,
    headers: requestHeaders,
    ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body })
  });
  return worker.fetch(request, env);
}

try {
  assert.equal((await call("/health", { method: "GET" })).status, 200, "Health check should remain public.");
  const healthPayload = await (await call("/health", { method: "GET", env: { DEEPSEEK_API_KEY: "secret-a", CLAUDE_API_KEY: "secret-b", NEBULA_SYNC_TOKEN: "secret-c" } })).json();
  assert.equal(Object.hasOwn(healthPayload, "configured"), false, "Public health must not disclose configured secret presence.");
  assert.equal((await call("/coach", { method: "GET", token: "valid" })).status, 405, "Coach must reject non-POST methods.");
  assert.equal((await call("/mnemonic", { method: "GET", token: "valid" })).status, 405, "Mnemonic must reject non-POST methods.");
  assert.equal((await call("/coach", { env: {} })).status, 503, "Coach must fail closed when the shared token is not configured.");
  assert.equal((await call("/mnemonic", { env: {} })).status, 503, "Mnemonic must fail closed when the shared token is not configured.");
  assert.equal((await call("/coach", { token: "wrong", env: { NEBULA_SYNC_TOKEN: "correct" } })).status, 401, "Coach must reject an invalid token.");
  assert.equal((await call("/mnemonic", { token: "wrong", env: { NEBULA_SYNC_TOKEN: "correct" } })).status, 401, "Mnemonic must reject an invalid token.");
  const unauthenticatedOversize = await call("/coach", {
    token: "wrong",
    env: { NEBULA_SYNC_TOKEN: "correct" },
    body: "x".repeat(1024 * 1024 + 1)
  });
  assert.equal(unauthenticatedOversize.status, 401, "Unauthenticated requests must be rejected before request-body buffering.");
  const unauthenticatedShareOversize = await call("/share", {
    token: "wrong",
    env: { NEBULA_SYNC_TOKEN: "correct" },
    body: "x".repeat(1024 * 1024 + 1)
  });
  assert.equal(unauthenticatedShareOversize.status, 401, "Share requests must authenticate before request-body buffering.");
  assert.equal((await call("/coach", { token: "correct", env: { NEBULA_SYNC_TOKEN: "correct", NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) } } })).status, 503, "Coach must not call AI when its server-side API key is missing.");
  assert.equal((await call("/mnemonic", { token: "correct", env: { NEBULA_SYNC_TOKEN: "correct", NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) } } })).status, 503, "Mnemonic must not call AI when its server-side API key is missing.");
  assert.equal((await call("/share", { env: {} })).status, 401, "Share import must require the shared token.");
  assert.equal((await call("/analyze", { env: {} })).status, 503, "Analyze must fail closed when the shared token is not configured.");
  assert.equal((await call("/chat", { env: {} })).status, 503, "Chat must fail closed when the shared token is not configured.");
  assert.equal((await call("/research", { method: "GET", env: {} })).status, 503, "Research must fail closed when the shared token is not configured.");

  const missingLimiter = await call("/coach", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct" }
  });
  assert.equal(missingLimiter.status, 503, "Authenticated AI routes must fail closed when the rate-limit binding is missing.");
  assert.match(await missingLimiter.text(), /NEBULA_RATE_LIMITER is not configured/);

  const deniedLimiter = await call("/coach", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct", NEBULA_RATE_LIMITER: { limit: async () => ({ success: false }) } }
  });
  assert.equal(deniedLimiter.status, 429, "Authenticated AI routes must reject rate-limited requests.");

  const failedLimiter = await call("/coach", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct", NEBULA_RATE_LIMITER: { limit: async () => { throw new Error("binding unavailable"); } } }
  });
  assert.equal(failedLimiter.status, 503, "Rate-limit service errors must fail closed.");

  assert.equal((await call("/share", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct" }
  })).status, 503, "Share import must also require the rate-limit binding.");
  assert.equal((await call("/research", {
    method: "GET",
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct", NEBULA_RATE_LIMITER: { limit: async () => ({ success: false }) } }
  })).status, 429, "Research requests must be rate limited after authentication.");

  const declaredOversize = await call("/coach", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct" },
    body: "{}",
    headers: { "Content-Length": String(1024 * 1024 + 1) }
  });
  assert.equal(declaredOversize.status, 413, "Declared bodies above 1 MiB must be rejected.");

  const streamedOversize = await call("/mnemonic", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct" },
    body: "x".repeat(1024 * 1024 + 1)
  });
  assert.equal(streamedOversize.status, 413, "Actual streamed bodies above 1 MiB must be rejected.");

  let slowBodyCancelled = false;
  const slowBody = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    cancel() { slowBodyCancelled = true; }
  });
  const slowRequest = new Request("https://worker.test/coach", {
    method: "POST",
    headers: { Authorization: "Bearer correct", "Content-Type": "application/json" },
    body: slowBody,
    duplex: "half"
  });
  const slowBodyResponse = await worker.fetch(slowRequest, {
    NEBULA_SYNC_TOKEN: "correct",
    NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) }
  });
  assert.equal(slowBodyResponse.status, 408, "Slow request-body streams must be terminated with a request timeout.");
  assert.equal(slowBodyCancelled, true, "Timed-out request-body streams must be cancelled.");

  const deniedOrigin = await call("/coach", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct" },
    headers: { Origin: "https://untrusted.example" }
  });
  assert.equal(deniedOrigin.status, 403, "Unapproved browser origins must be rejected.");
  assert.equal(upstreamCalls, 0, "Negative-path checks must never call external AI or import providers.");

  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response("x", {
      headers: { "Content-Type": "application/json", "Content-Length": String(8 * 1024 * 1024 + 1) }
    });
  };
  const oversizedUpstream = await call("/analyze", {
    token: "correct",
    env: { NEBULA_SYNC_TOKEN: "correct", DEEPSEEK_API_KEY: "test-only-key", NEBULA_RATE_LIMITER: { limit: async () => ({ success: true }) } },
    body: JSON.stringify({ text: "response-size boundary test" })
  });
  assert.equal(oversizedUpstream.status, 500, "Analyze must reject an upstream response whose declared size exceeds 8 MiB.");
  assert.match(await oversizedUpstream.text(), /Upstream response exceeds the 8 MiB limit/);
  assert.equal(upstreamCalls, 1, "The oversized upstream response test should make exactly one mocked provider call.");
  console.log("NEBULA Worker runtime security checks passed.");
} finally {
  globalThis.fetch = originalFetch;
}
