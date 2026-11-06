/**
 * NEBULA private-account API foundation.
 *
 * Bindings:
 *   DB: Cloudflare D1 database (schema: migrations/0001_private_data.sql)
 *   PRIVATE_FILES: Cloudflare R2 bucket
 * Secrets:
 *   OIDC_JWKS_URL, OIDC_ISSUER, OIDC_AUDIENCE, DEEPSEEK_API_KEY
 * Vars:
 *   ALLOWED_ORIGIN=https://yijianvision-lgtm.github.io
 *
 * All persistent payloads/files are expected to be client-side encrypted.
 * AI requests are transient and are not persisted by this Worker.
 */
const encoder = new TextEncoder();
let jwksCache = { at: 0, keys: null };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function b64url(input) {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  return atob(s + "=".repeat((4 - s.length % 4) % 4));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function getJwks(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 300000) return jwksCache.keys;
  if (!env.OIDC_JWKS_URL) throw new Error("OIDC_JWKS_URL is not configured");
  const u = new URL(env.OIDC_JWKS_URL);
  if (u.protocol !== "https:") throw new Error("JWKS URL must use HTTPS");
  const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Unable to load identity provider signing keys");
  const data = await res.json();
  if (!Array.isArray(data.keys)) throw new Error("Invalid JWKS document");
  jwksCache = { at: Date.now(), keys: data.keys };
  return data.keys;
}
async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token.length > 12000) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64url(parts[0]));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(b64url(parts[1]), c => c.charCodeAt(0))));
    if (header.alg !== "RS256" || !header.kid) return null;
    const keys = await getJwks(env);
    const jwk = keys.find(k => k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig"));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(b64url(parts[2]), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, encoder.encode(parts[0] + "." + parts[1]));
    const now = Math.floor(Date.now() / 1000);
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(env.OIDC_AUDIENCE) : claims.aud === env.OIDC_AUDIENCE;
    if (!valid || !env.OIDC_AUDIENCE || !env.OIDC_ISSUER || !audOk || claims.iss !== env.OIDC_ISSUER || typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 30)) return null;
    return { id: String(claims.sub), email: claims.email || null };
  } catch { return null; }
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "https://yijianvision-lgtm.github.io";
  if (origin && origin !== allowed) return null;
  return {
    "Access-Control-Allow-Origin": origin || allowed,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Vary": "Origin"
  };
}
function safeId(value) {
  return /^[a-zA-Z0-9_-]{8,100}$/.test(value || "");
}
async function requireDb(env) {
  if (!env.DB || !env.PRIVATE_FILES) throw new Error("D1 binding DB and R2 binding PRIVATE_FILES are required");
}
async function aiAnalyze(body, env, cors) {
  if (!env.DEEPSEEK_API_KEY) return json({ error: "AI service is not configured" }, 503, cors);
  const source = String(body.sourceText || "").slice(0, 65000);
  const userInput = String(body.userInput || "").slice(0, 12000);
  const context = Array.isArray(body.context) ? body.context.slice(0, 80) : [];
  if (!source.trim() && !userInput.trim()) return json({ error: "Please provide a question or source material" }, 400, cors);
  const system = `你是 NEBULA 的私人知识教练。根据用户提供的讲义、图片 OCR/转录文字、基础知识和问题进行分析。严格区分：来源原文、用户观点、可验证事实、AI 推论。不要把推论伪装成事实，不要编造论文或引文。判断用户说法正确性，指出错误、遗漏、适用条件，并给出更准确精炼的表达。按四维输出：前瞻(前置/起源)、顾后(后续/影响)、左顾(横向关联)、右盼(反例/限制/矛盾)，并输出逻辑链。对证据不足之处标记 needsReview。保留原始表述，不得声称已修改用户知识库。输出 JSON：{verdict, corrected, concise, fourDimensions:{foresight,aftermath,lateral,counterview},logicChain:[...],evidenceGaps:[...],needsReview:boolean,quiz:[...]}。`;
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-v4-pro",
      messages: [
        { role: "system", content: system },
        { role: "user", content: "用户问题/口述：\n" + userInput + "\n\n讲义与基础资料：\n" + source + "\n\n已有知识上下文：\n" + JSON.stringify(context) }
      ],
      response_format: { type: "json_object" },
      max_tokens: 7000
    })
  });
  const data = await response.json();
  if (!response.ok) return json({ error: data.error?.message || "AI request failed" }, 502, cors);
  try { return json({ ok: true, result: JSON.parse(data.choices?.[0]?.message?.content || "{}"), usage: data.usage || null }, 200, cors); }
  catch { return json({ error: "AI returned invalid structured output; retry with less content" }, 502, cors); }
}
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) return json({ error: "Not found" }, 404);
    const user = await authenticate(request, env);
    if (!user) return json({ error: "需要登录有效的 NEBULA 个人账户" }, 401, cors);
    try {
      await requireDb(env);
      if (url.pathname === "/v1/me" && request.method === "GET") {
        return json({ ok: true, accountId: user.id, privateByDefault: true, storage: "encrypted-client-payload" }, 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: String(error.message || error) }, 500, cors);
    }
  }
};