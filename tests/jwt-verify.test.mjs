import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { createJwtVerifier, deriveNebulaOwnerId } from "../nebula-jwt-verify.js";

const issuer = "https://nebula-test.clerk.accounts.dev";
const audience = "https://api.nebula.test";
const jwksUrl = "https://nebula-test.clerk.accounts.dev/.well-known/jwks.json";
const now = () => 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const signingJwk = { ...jwk, kid: "key-a", alg: "RS256", use: "sig" };

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}
function token({ header = {}, claims = {}, key = privateKey } = {}) {
  const h = b64url({ alg: "RS256", typ: "JWT", kid: "key-a", ...header });
  const p = b64url({
    iss: issuer, aud: audience, sub: "user_synthetic_123",
    exp: Math.floor(now() / 1000) + 300, ...claims
  });
  const input = h + "." + p;
  const signature = signBytes("RSA-SHA256", Buffer.from(input), key).toString("base64url");
  return input + "." + signature;
}
let jwks = { keys: [signingJwk] };
let fetchCalls = 0;
let fetchFailure = false;
const fetchImpl = async url => {
  fetchCalls += 1;
  assert.equal(url, jwksUrl, "Verifier must use only the configured trusted JWKS URL.");
  if (fetchFailure) throw new Error("synthetic JWKS outage");
  return new Response(JSON.stringify(jwks), { status: 200, headers: { "Content-Type": "application/json" } });
};
const verify = createJwtVerifier({ issuer, audience, jwksUrl, fetchImpl, now, cacheTtlMs: 60000, clockToleranceSeconds: 0 });

const valid = await verify(token());
assert.deepEqual(valid, { issuer, subject: "user_synthetic_123", expiresAt: Math.floor(now() / 1000) + 300 });
assert.equal(fetchCalls, 1);
await verify(token());
assert.equal(fetchCalls, 1, "JWKS must be cached within its TTL.");

await assert.rejects(verify(token({ claims: { exp: Math.floor(now() / 1000) - 1 } })), /Unauthorized/);
await assert.rejects(verify(token({ claims: { iss: "https://attacker.invalid" } })), /Unauthorized/);
await assert.rejects(verify(token({ claims: { aud: "other-api" } })), /Unauthorized/);
await assert.rejects(verify(token({ claims: { sub: "" } })), /Unauthorized/);
await assert.rejects(verify(token({ claims: { nbf: Math.floor(now() / 1000) + 60 } })), /Unauthorized/);
await assert.rejects(verify(token({ header: { alg: "none" } })), /Unauthorized/);
await assert.rejects(verify(token({ header: { jku: "https://attacker.invalid/jwks.json" } })), /Unauthorized/);
await assert.rejects(verify("not.a.jwt"), /Unauthorized/);

const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
await assert.rejects(verify(token({ key: wrongKey.privateKey })), /Unauthorized/);

const unknownKidToken = token({ header: { kid: "rotated-key" } });
await assert.rejects(verify(unknownKidToken), /Signing key not found/);
assert.equal(fetchCalls, 2, "Unknown kid should cause exactly one controlled JWKS refresh after the cached lookup.");

const rotatedPublic = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotatedJwk = { ...rotatedPublic.publicKey.export({ format: "jwk" }), kid: "rotated-key", alg: "RS256", use: "sig" };
jwks = { keys: [rotatedJwk] };
const rotationVerifier = createJwtVerifier({ issuer, audience, jwksUrl, fetchImpl, now, cacheTtlMs: 60000, clockToleranceSeconds: 0 });
const rotatedHeader = b64url({ alg: "RS256", typ: "JWT", kid: "rotated-key" });
const rotatedPayload = b64url({ iss: issuer, aud: audience, sub: "user_synthetic_123", exp: Math.floor(now() / 1000) + 300 });
const rotatedInput = rotatedHeader + "." + rotatedPayload;
const rotatedSignature = signBytes("RSA-SHA256", Buffer.from(rotatedInput), rotatedPublic.privateKey).toString("base64url");
assert.equal((await rotationVerifier(rotatedInput + "." + rotatedSignature)).subject, "user_synthetic_123");

fetchFailure = true;
const outageVerifier = createJwtVerifier({ issuer, audience, jwksUrl, fetchImpl, now, cacheTtlMs: 0, clockToleranceSeconds: 0 });
await assert.rejects(outageVerifier(token()), /JWKS unavailable|synthetic JWKS outage/);
fetchFailure = false;


const duplicateKidVerifier = createJwtVerifier({
  issuer, audience, jwksUrl,
  fetchImpl: async () => new Response(JSON.stringify({ keys: [signingJwk, signingJwk] }), { status: 200 }),
  now, clockToleranceSeconds: 0
});
await assert.rejects(duplicateKidVerifier(token()), /ambiguous/);

const oversizedJwksVerifier = createJwtVerifier({
  issuer, audience, jwksUrl,
  fetchImpl: async () => new Response("{}", { status: 200, headers: { "Content-Length": "2048" } }),
  maxJwksBytes: 1024, now, clockToleranceSeconds: 0
});
await assert.rejects(oversizedJwksVerifier(token()), /size limit/);

const timeoutVerifier = createJwtVerifier({
  issuer, audience, jwksUrl,
  fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }),
  jwksTimeoutMs: 10, now, clockToleranceSeconds: 0
});
await assert.rejects(timeoutVerifier(token()), /timed out/);

const weakPair = generateKeyPairSync("rsa", { modulusLength: 1024 });
const weakJwk = { ...weakPair.publicKey.export({ format: "jwk" }), kid: "weak-key", alg: "RS256", use: "sig" };
const weakVerifier = createJwtVerifier({
  issuer, audience, jwksUrl,
  fetchImpl: async () => new Response(JSON.stringify({ keys: [weakJwk] }), { status: 200 }),
  now, clockToleranceSeconds: 0
});
const weakHeader = b64url({ alg: "RS256", typ: "JWT", kid: "weak-key" });
const weakPayload = b64url({ iss: issuer, aud: audience, sub: "user_synthetic_123", exp: Math.floor(now() / 1000) + 300 });
const weakInput = weakHeader + "." + weakPayload;
const weakSignature = signBytes("RSA-SHA256", Buffer.from(weakInput), weakPair.privateKey).toString("base64url");
await assert.rejects(weakVerifier(weakInput + "." + weakSignature), /weak|unsupported/i);

const secret = "synthetic-test-secret-at-least-32-characters";
const ownerA = await deriveNebulaOwnerId({ issuer, subject: "user-a", namespaceSecret: secret });
const ownerARepeat = await deriveNebulaOwnerId({ issuer, subject: "user-a", namespaceSecret: secret });
const ownerB = await deriveNebulaOwnerId({ issuer, subject: "user-b", namespaceSecret: secret });
assert.equal(ownerA, ownerARepeat, "Owner mapping must be stable.");
assert.notEqual(ownerA, ownerB, "Distinct subjects must map to distinct owner IDs.");
assert.match(ownerA, /^own_[a-f0-9]{64}$/);
await assert.rejects(deriveNebulaOwnerId({ issuer, subject: "user-a", namespaceSecret: "short" }), /32\+ character/);

console.log("NEBULA JWT verification and owner derivation checks passed.");
