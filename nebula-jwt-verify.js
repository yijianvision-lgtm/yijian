/**
 * NEBULA provider-neutral JWT verification primitives.
 *
 * No implicit network destinations: callers must supply a fixed, trusted
 * issuer and JWKS URL from server-side configuration. Never derive either
 * value from token headers or request parameters.
 */

const textEncoder = new TextEncoder();

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid JWT encoding.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch {
    throw new Error("Invalid JWT JSON.");
  }
}

function audienceMatches(actual, expected) {
  if (typeof actual === "string") return actual === expected;
  return Array.isArray(actual) && actual.includes(expected);
}

function createJwksResolver({ jwksUrl, fetchImpl, cacheTtlMs, now }) {
  let cached = null;

  async function load(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached.keys;
    const response = await fetchImpl(jwksUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error"
    });
    if (!response || !response.ok) throw new Error("JWKS unavailable.");
    const body = await response.json();
    if (!body || !Array.isArray(body.keys) || body.keys.length > 100) {
      throw new Error("Invalid JWKS document.");
    }
    cached = {
      keys: body.keys,
      expiresAt: now() + cacheTtlMs
    };
    return cached.keys;
  }

  return async function resolve(kid) {
    let keys = await load(false);
    let key = keys.find(item => item && item.kid === kid);
    if (!key) {
      // A single forced refresh supports key rotation without accepting
      // arbitrary key URLs supplied by the token.
      keys = await load(true);
      key = keys.find(item => item && item.kid === kid);
    }
    if (!key || key.kty !== "RSA" || key.use && key.use !== "sig" ||
        key.alg && key.alg !== "RS256" || typeof key.n !== "string" || typeof key.e !== "string") {
      throw new Error("Signing key not found or unsupported.");
    }
    return key;
  };
}

export function createJwtVerifier({
  issuer,
  audience,
  jwksUrl,
  fetchImpl = fetch,
  cacheTtlMs = 5 * 60 * 1000,
  clockToleranceSeconds = 60,
  now = () => Date.now()
} = {}) {
  if (typeof issuer !== "string" || !issuer || typeof audience !== "string" || !audience ||
      typeof jwksUrl !== "string" || !/^https:\/\//.test(jwksUrl)) {
    throw new TypeError("Trusted issuer, audience, and HTTPS JWKS URL are required.");
  }
  if (typeof fetchImpl !== "function" || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 0 ||
      !Number.isFinite(clockToleranceSeconds) || clockToleranceSeconds < 0) {
    throw new TypeError("Invalid JWT verifier options.");
  }

  const resolveJwk = createJwksResolver({ jwksUrl, fetchImpl, cacheTtlMs, now });

  return async function verifyAccessToken(token) {
    if (typeof token !== "string" || token.length > 16384) throw new Error("Unauthorized.");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) throw new Error("Unauthorized.");

    const header = decodeJsonSegment(parts[0]);
    const claims = decodeJsonSegment(parts[1]);
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
        header.jku || header.x5u || header.crit) {
      throw new Error("Unauthorized.");
    }
    if (!claims || claims.iss !== issuer || !audienceMatches(claims.aud, audience) ||
        typeof claims.sub !== "string" || !claims.sub.trim() ||
        !Number.isFinite(claims.exp)) {
      throw new Error("Unauthorized.");
    }

    const nowSeconds = Math.floor(now() / 1000);
    if (claims.exp <= nowSeconds - clockToleranceSeconds ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + clockToleranceSeconds))) {
      throw new Error("Unauthorized.");
    }

    const jwk = await resolveJwk(header.kid);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(parts[2]),
      textEncoder.encode(parts[0] + "." + parts[1])
    );
    if (!valid) throw new Error("Unauthorized.");

    // Return only the claims needed by the authorization layer. Callers must
    // never accept owner_id from an unverified request body.
    return Object.freeze({ issuer: claims.iss, subject: claims.sub, expiresAt: claims.exp });
  };
}

export async function deriveNebulaOwnerId({ issuer, subject, namespaceSecret } = {}) {
  if (typeof issuer !== "string" || !issuer || typeof subject !== "string" || !subject ||
      typeof namespaceSecret !== "string" || namespaceSecret.length < 32) {
    throw new TypeError("Verified issuer, subject, and a 32+ character server secret are required.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode("NEBULA_OWNER_V1\0" + namespaceSecret + "\0" + issuer + "\0" + subject)
  );
  return "own_" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
