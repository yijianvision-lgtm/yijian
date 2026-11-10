import assert from "node:assert/strict";
import { createNebulaAuthAdapter } from "../nebula-auth-adapter.js";

let session = null;
let signInCalls = 0;
let consent = null;
const provider = {
  async signIn() { signInCalls += 1; session = { issuer: "https://test.clerk.accounts.dev", subject: "user_test_123", email: "synthetic@example.invalid" }; },
  async signOut() { session = null; },
  async getSession() { return session; },
  async getAccessToken() { return session ? "synthetic.jwt.token" : null; }
};
const consentStore = {
  async read() { return consent; },
  async write(value) { consent = structuredClone(value); },
  async clear() { consent = null; }
};
const auth = createNebulaAuthAdapter({ provider, consentStore });

assert.deepEqual(await auth.getSyncConsent(), { enabled: false, categories: [] });
assert.equal(await auth.getSession(), null);
assert.equal(await auth.getAccessToken(), null);
assert.equal(await auth.canSyncCategory("lectureSources"), false);

const signedIn = await auth.signIn();
assert.equal(signInCalls, 1);
assert.equal(signedIn.subject, "user_test_123");
assert.equal(await auth.getAccessToken(), "synthetic.jwt.token");
assert.deepEqual(await auth.getSyncConsent(), { enabled: false, categories: [] }, "Signing in must never enable cloud sync.");
assert.equal(await auth.canSyncCategory("lectureSources"), false, "Authenticated users still cannot sync without consent.");

await assert.rejects(
  auth.enableCloudSync({ categories: ["lectureSources"], confirmed: false }),
  /Explicit user confirmation/
);
await assert.rejects(
  auth.enableCloudSync({ categories: [], confirmed: true }),
  /Select at least one data category/
);

const enabled = await auth.enableCloudSync({
  categories: ["lectureSources", "graph", "graph"],
  confirmed: true
});
assert.deepEqual(enabled.categories, ["graph", "lectureSources"]);
assert.equal(await auth.canSyncCategory("graph"), true);
assert.equal(await auth.canSyncCategory("references"), false, "Only explicitly selected categories may sync.");

await auth.disableCloudSync();
assert.equal(await auth.canSyncCategory("graph"), false);
assert.deepEqual(await auth.getSyncConsent(), { enabled: false, categories: [] });

await auth.signOut();
assert.equal(await auth.getSession(), null);
assert.equal(await auth.getAccessToken(), null);
assert.equal(await auth.canSyncCategory("graph"), false, "Signed-out users cannot sync even if a stale consent record exists.");

assert.throws(
  () => createNebulaAuthAdapter({ provider: {}, consentStore }),
  /identity provider adapter/
);
console.log("NEBULA auth adapter contract checks passed.");
