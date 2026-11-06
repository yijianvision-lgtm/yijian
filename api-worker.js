/**
 * NEBULA private-account API.
 * Configure D1 binding DB, R2 binding PRIVATE_FILES, and OIDC/DeepSeek secrets.
 * Persistent knowledge and files must be encrypted in the browser before upload.
 */
const enc = new TextEncoder();
let jwksCache = { at: 0, keys: null };

function reply(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...cors
  }});
}
function corsFor(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "https://yijianvision-lgtm.github.io";
  if (origin && origin !== allowed) return null;
  return {
    "Access-Control-Allow-Origin": origin || allowed,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Vary": "Origin"
  };
}
function decodePart(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function getJwks(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 300000) return jwksCache.keys;
  if (!env.OIDC_JWKS_URL) throw new Error("OIDC_JWKS_URL is not configured");
  const u = new URL(env.OIDC_JWKS_URL);
  if (u.protocol !== "https:") throw new Error("OIDC JWKS URL must use HTTPS");
  const response = await fetch(u, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Unable to load OIDC signing keys");
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Invalid OIDC JWKS");
  jwksCache = { at: Date.now(), keys: data.keys };
  return data.keys;
}
async function authenticate(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token.length > 12000) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    if (header.alg !== "RS256" || !header.kid) return null;
    const jwk = (await getJwks(env)).find(k => k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig"));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud.includes(env.OIDC_AUDIENCE) : claims.aud === env.OIDC_AUDIENCE;
    if (!valid || !env.OIDC_AUDIENCE || !env.OIDC_ISSUER || !aud || claims.iss !== env.OIDC_ISSUER ||
        typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now ||
        (claims.nbf && claims.nbf > now + 30)) return null;
    return { id: claims.sub };
  } catch { return null; }
}
function validId(v) { return typeof v === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(v); }
async function jsonBody(req, max = 1600000) {
  const size = Number(req.headers.get("Content-Length") || 0);
  if (size > max) throw new Error("Request body too large");
  return await req.json();
}
async function aiAnalyze(body, env, cors) {
  if (!env.DEEPSEEK_API_KEY) return reply({ error: "AI service is not configured" }, 503, cors);
  const source = String(body.sourceText || "").slice(0, 65000);
  const userInput = String(body.userInput || "").slice(0, 12000);
  const context = Array.isArray(body.context) ? body.context.slice(0, 80) : [];
  if (!source.trim() && !userInput.trim()) return reply({ error: "Please provide a question or source material" }, 400, cors);
  const system = `你是 NEBULA 私人知识教练。根据用户提供的讲义、图片 OCR/转录文字、基础知识和问题分析。严格区分来源原文、用户观点、可验证事实和 AI 推论。不要编造事实、论文或引文。判断说法正确性，指出错误、遗漏、适用条件，并给出更准确精炼的表达。四维：前瞻(前置/起源)、顾后(后续/影响)、左顾(横向关联)、右盼(反例/限制/矛盾)。输出逻辑链。证据不足标记 needsReview。保留原始表述，不声称已修改知识库。返回 JSON：{verdict,corrected,concise,fourDimensions:{foresight,aftermath,lateral,counterview},logicChain,evidenceGaps,needsReview,quiz}。`;
  const upstream = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.DEEPSEEK_MODEL || "deepseek-v4-pro",
      messages: [{ role: "system", content: system }, { role: "user", content:
        "用户问题/口述：\n" + userInput + "\n\n讲义与基础资料：\n" + source + "\n\n已有知识上下文：\n" + JSON.stringify(context) }],
      response_format: { type: "json_object" }, max_tokens: 7000 })
  });
  const data = await upstream.json();
  if (!upstream.ok) return reply({ error: data.error?.message || "AI request failed" }, 502, cors);
  try { return reply({ ok: true, result: JSON.parse(data.choices?.[0]?.message?.content || "{}"), usage: data.usage || null }, 200, cors); }
  catch { return reply({ error: "AI returned invalid structured output" }, 502, cors); }
}
async function research(q, cors) {
  if (!q) return reply({ error: "Missing q" }, 400, cors);
  const response = await fetch("https://api.crossref.org/works?rows=8&query=" + encodeURIComponent(q.slice(0, 240)), {
    headers: { "User-Agent": "NEBULA-Knowledge/1.0" }
  });
  if (!response.ok) return reply({ error: "Research provider unavailable" }, 502, cors);
  const data = await response.json();
  const items = (data.message?.items || []).map(x => ({
    title: x.title?.[0] || "",
    authors: (x.author || []).slice(0, 5).map(a => [a.given, a.family].filter(Boolean).join(" ")),
    year: x.published?.["date-parts"]?.[0]?.[0] || null,
    doi: x.DOI || null, url: x.URL || null, type: x.type || null
  }));
  return reply({ ok: true, provider: "Crossref", items }, 200, cors);
}
export default {
  async fetch(req, env) {
    const cors = corsFor(req, env);
    if (!cors) return reply({ error: "Origin not allowed" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/v1/")) return reply({ error: "Not found" }, 404, cors);
    const user = await authenticate(req, env);
    if (!user) return reply({ error: "需要登录有效的 NEBULA 个人账户" }, 401, cors);
    try {
      if (url.pathname === "/v1/me" && req.method === "GET")
        return reply({ ok: true, privateByDefault: true, storage: "client-encrypted" }, 200, cors);

      if (url.pathname === "/v1/ai/analyze" && req.method === "POST")
        return await aiAnalyze(await jsonBody(req, 1200000), env, cors);

      if (url.pathname === "/v1/ai/mnemonic" && req.method === "POST") {
        const body = await jsonBody(req, 400000);
        const mnemonic = String(body.mnemonic || body.userInput || "").slice(0, 6000);
        if (!mnemonic.trim()) return reply({ error: "Please provide a mnemonic" }, 400, cors);
        return await aiAnalyze({ ...body, userInput:
          "请检查并优化这条记忆口诀。保留用户原文，判断准确性、遗漏和记忆性，并给出可选优化版，不要擅自替换。口诀：\n" + mnemonic,
          sourceText: String(body.sourceText || "").slice(0, 30000) }, env, cors);
      }

      if (url.pathname === "/v1/research" && req.method === "GET")
        return await research(String(url.searchParams.get("q") || "").trim(), cors);

      if (!env.DB) return reply({ error: "D1 binding DB is not configured" }, 503, cors);
      if (url.pathname === "/v1/knowledge" && req.method === "GET") {
        const rows = await env.DB.prepare("SELECT id, payload, updated_at FROM knowledge WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 500").bind(user.id).all();
        return reply({ ok: true, items: rows.results || [] }, 200, cors);
      }
      if (url.pathname === "/v1/knowledge" && req.method === "PUT") {
        const body = await jsonBody(req);
        if (!validId(body.id) || typeof body.encryptedPayload !== "string" || body.encryptedPayload.length > 1500000)
          return reply({ error: "Invalid encrypted knowledge payload" }, 400, cors);
        await env.DB.prepare("INSERT INTO knowledge (id,owner_id,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(id,owner_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at")
          .bind(body.id, user.id, body.encryptedPayload, Date.now()).run();
        return reply({ ok: true, id: body.id }, 200, cors);
      }
      if (url.pathname === "/v1/knowledge" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!validId(id)) return reply({ error: "Invalid id" }, 400, cors);
        await env.DB.prepare("DELETE FROM knowledge WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
        return reply({ ok: true, deleted: true }, 200, cors);
      }
      if (!env.PRIVATE_FILES) return reply({ error: "R2 binding PRIVATE_FILES is not configured" }, 503, cors);
      if (url.pathname === "/v1/references" && req.method === "GET") {
        const rows = await env.DB.prepare("SELECT id,name,mime,size,created_at FROM private_references WHERE owner_id = ? ORDER BY created_at DESC LIMIT 300").bind(user.id).all();
        return reply({ ok: true, items: rows.results || [] }, 200, cors);
      }
      if (url.pathname === "/v1/references" && req.method === "POST") {
        const body = await jsonBody(req, 20000);
        if (!validId(body.id) || !String(body.name || "").trim() || String(body.name).length > 240 ||
            !/^[-\w.+]+\/[\w.+-]+$/.test(body.mime || "") || !Number.isFinite(body.size) || body.size < 0 || body.size > 50 * 1024 * 1024)
          return reply({ error: "Invalid private reference metadata" }, 400, cors);
        await env.DB.prepare("INSERT INTO private_references (id,owner_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)")
          .bind(body.id, user.id, body.name, body.mime, body.size, Date.now()).run();
        return reply({ ok: true, id: body.id, private: true }, 201, cors);
      }
      const match = url.pathname.match(/^\/v1\/references\/([a-zA-Z0-9_-]{8,100})(?:\/(file))?$/);
      if (match) {
        const id = match[1];
        const row = await env.DB.prepare("SELECT id,name,mime,size FROM private_references WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
        if (!row) return reply({ error: "Not found" }, 404, cors);
        if (req.method === "PUT" && match[2] === "file") {
          if (!req.body || row.size > 50 * 1024 * 1024) return reply({ error: "Missing file or file too large" }, 413, cors);
          const limited = req.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
              this.total = (this.total || 0) + chunk.byteLength;
              if (this.total > 50 * 1024 * 1024 || this.total > row.size + 1024)
                throw new Error("Encrypted upload exceeds declared size");
              controller.enqueue(chunk);
            }
          }));
          await env.PRIVATE_FILES.put(user.id + "/" + id, limited, {
            httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
            customMetadata: { owner: user.id, referenceId: id }
          });
          return reply({ ok: true, id, encrypted: true }, 200, cors);
        }
        if (req.method === "GET" && match[2] === "file") {
          const object = await env.PRIVATE_FILES.get(user.id + "/" + id);
          if (!object) return reply({ error: "File not found" }, 404, cors);
          return new Response(object.body, { headers: { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store", "Content-Disposition": "attachment; filename=\"private-encrypted-file.bin\"" } });
        }
        if (req.method === "DELETE" && !match[2]) {
          await env.PRIVATE_FILES.delete(user.id + "/" + id);
          await env.DB.prepare("DELETE FROM private_references WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
          return reply({ ok: true, deleted: true }, 200, cors);
        }
      }
      return reply({ error: "Not found" }, 404, cors);
    } catch (error) {
      return reply({ error: String(error.message || error) }, 500, cors);
    }
  }
};