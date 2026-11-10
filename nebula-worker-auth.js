import { createJwtVerifier, deriveNebulaOwnerId } from "./nebula-jwt-verify.js";

const verifierCache = new Map();

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0, length = Math.max(a.length, b.length); i < length; i += 1) {
    difference |= (a[i] || 0) ^ (b[i] || 0);
  }
  return difference === 0;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] || null;
}

function parseAuthorizedParties(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("NEBULA_AUTHORIZED_PARTIES is required.");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("NEBULA_AUTHORIZED_PARTIES must be a JSON string array."); }
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error("NEBULA_AUTHORIZED_PARTIES must be a non-empty JSON string array.");
  }
  return [...new Set(value.map(item => item.trim()))].sort();
}

export function createNebulaWorkerAuthenticator({
  verifierFactory = createJwtVerifier,
  ownerDeriver = deriveNebulaOwnerId
} = {}) {
  return async function authenticateNebulaRequest(request, env = {}) {
    const mode = env.NEBULA_AUTH_MODE || "shared";
    const token = bearerToken(request);
    if (!token) return { ok: false, status: 401, error: "Unauthorized." };

    if (mode === "shared") {
      if (typeof env.NEBULA_SYNC_TOKEN !== "string" || !env.NEBULA_SYNC_TOKEN) {
        return { ok: false, status: 503, error: "Worker shared-token authentication is not configured." };
      }
      if (!constantTimeEqual(token, env.NEBULA_SYNC_TOKEN)) {
        return { ok: false, status: 401, error: "Unauthorized." };
      }
      // A deployment-wide secret authenticates a service caller, never a user.
      return { ok: true, context: Object.freeze({ kind: "shared-service" }) };
    }

    if (mode !== "clerk-jwt") {
      return { ok: false, status: 503, error: "Unsupported NEBULA_AUTH_MODE." };
    }

    const { NEBULA_JWT_ISSUER: issuer, NEBULA_JWT_AUDIENCE: audience,
      NEBULA_JWKS_URL: jwksUrl, NEBULA_OWNER_NAMESPACE_SECRET: namespaceSecret } = env;
    if (![issuer, audience, jwksUrl].every(value => typeof value === "string" && value.trim()) ||
        !/^https:\/\//.test(jwksUrl || "") ||
        typeof namespaceSecret !== "string" || namespaceSecret.length < 32) {
      return { ok: false, status: 503, error: "Clerk JWT verification or owner namespace configuration is incomplete." };
    }

    let authorizedParties;
    try { authorizedParties = parseAuthorizedParties(env.NEBULA_AUTHORIZED_PARTIES); }
    catch (error) { return { ok: false, status: 503, error: error.message }; }

    const cacheKey = JSON.stringify([issuer, audience, jwksUrl, authorizedParties]);
    let verifyAccessToken = verifierCache.get(cacheKey);
    if (!verifyAccessToken) {
      try {
        verifyAccessToken = verifierFactory({ issuer, audience, jwksUrl, authorizedParties });
        verifierCache.set(cacheKey, verifyAccessToken);
        if (verifierCache.size > 8) verifierCache.delete(verifierCache.keys().next().value);
      } catch {
        return { ok: false, status: 503, error: "JWT verifier configuration is invalid." };
      }
    }

    try {
      const verified = await verifyAccessToken(token);
      const ownerId = await ownerDeriver({
        issuer: verified.issuer,
        subject: verified.subject,
        namespaceSecret
      });
      return {
        ok: true,
        context: Object.freeze({
          kind: "user",
          issuer: verified.issuer,
          subject: verified.subject,
          ownerId,
          expiresAt: verified.expiresAt
        })
      };
    } catch (error) {
      const unavailable = /JWKS|timed out|fetch failed|network/i.test(String(error?.message || ""));
      return { ok: false, status: unavailable ? 503 : 401, error: unavailable ? "Identity verification service is unavailable." : "Unauthorized." };
    }
  };
}

export const authenticateNebulaRequest = createNebulaWorkerAuthenticator();
