import assert from "node:assert/strict";
import { createNebulaWorkerAuthenticator } from "../nebula-worker-auth.js";

const request = token => new Request("https://worker.test/chat", {
  method: "POST",
  headers: token ? { Authorization: "Bearer " + token } : {}
});

const authenticate = createNebulaWorkerAuthenticator();
const shared = await authenticate(request("shared-secret"), { NEBULA_SYNC_TOKEN: "shared-secret" });
assert.equal(shared.ok, true);
assert.equal(shared.context.kind, "shared-service");
assert.equal(Object.hasOwn(shared.context, "ownerId"), false, "Shared service tokens must never create a user owner identity.");

assert.deepEqual(await authenticate(request("wrong"), { NEBULA_SYNC_TOKEN: "shared-secret" }), {
  ok: false, status: 401, error: "Unauthorized."
});
assert.equal((await authenticate(request("anything"), {})).status, 503, "Missing shared-token configuration must fail closed.");
assert.equal((await authenticate(request("anything"), { NEBULA_AUTH_MODE: "unsupported" })).status, 503);

const incompleteJwt = await authenticate(request("synthetic-jwt"), {
  NEBULA_AUTH_MODE: "clerk-jwt",
  NEBULA_JWT_ISSUER: "https://issuer.example",
  NEBULA_JWT_AUDIENCE: "nebula-api",
  NEBULA_JWKS_URL: "https://issuer.example/.well-known/jwks.json"
});
assert.equal(incompleteJwt.status, 503, "JWT mode must fail closed without the server-side owner namespace secret and authorized party allowlist.");

let verifierCalls = 0;
let ownerInputs = null;
const jwtAuthenticator = createNebulaWorkerAuthenticator({
  verifierFactory: options => {
    verifierCalls += 1;
    assert.equal(options.issuer, "https://synthetic-issuer.example");
    assert.deepEqual(options.authorizedParties, ["https://preview.example"]);
    return async token => {
      assert.equal(token, "valid-synthetic-token");
      return { issuer: options.issuer, subject: "synthetic-user-a", expiresAt: 2000000000 };
    };
  },
  ownerDeriver: async input => {
    ownerInputs = input;
    return "own_synthetic_a";
  }
});
const jwtEnv = {
  NEBULA_AUTH_MODE: "clerk-jwt",
  NEBULA_JWT_ISSUER: "https://synthetic-issuer.example",
  NEBULA_JWT_AUDIENCE: "nebula-api",
  NEBULA_JWKS_URL: "https://synthetic-issuer.example/.well-known/jwks.json",
  NEBULA_AUTHORIZED_PARTIES: JSON.stringify(["https://preview.example"]),
  NEBULA_OWNER_NAMESPACE_SECRET: "synthetic-only-namespace-secret-which-is-long-enough"
};
const jwtRequest = request("valid-synthetic-token");
const first = await jwtAuthenticator(jwtRequest, jwtEnv);
const second = await jwtAuthenticator(jwtRequest, jwtEnv);
assert.equal(first.ok, true);
assert.equal(first.context.kind, "user");
assert.equal(first.context.ownerId, "own_synthetic_a");
assert.equal(second.context.ownerId, "own_synthetic_a");
assert.equal(verifierCalls, 1, "Verifier instances should be cached per trusted issuer/audience/JWKS/party configuration.");
assert.deepEqual(ownerInputs, {
  issuer: "https://synthetic-issuer.example",
  subject: "synthetic-user-a",
  namespaceSecret: jwtEnv.NEBULA_OWNER_NAMESPACE_SECRET
});
assert.equal(Object.isFrozen(first.context), true);

const malformedPartyConfig = await jwtAuthenticator(jwtRequest, {
  ...jwtEnv, NEBULA_AUTHORIZED_PARTIES: "not-json"
});
assert.equal(malformedPartyConfig.status, 503, "Malformed authorized-party configuration must fail closed.");

console.log("NEBULA Worker identity middleware tests passed.");
