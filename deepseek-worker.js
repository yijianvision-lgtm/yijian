/**
 * NEBULA × DeepSeek bridge — deploy as a Cloudflare Worker.
 * Set secret: DEEPSEEK_API_KEY
 * Optional vars: DEEPSEEK_MODEL=deepseek-v4-pro
 * Endpoint: POST /analyze  { text, existingNodes? }
 */
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname !== "/analyze" || request.method !== "POST")
      return new Response(JSON.stringify({ error: "POST /analyze only" }), { status: 404, headers: cors });
    if (!env.DEEPSEEK_API_KEY)
      return new Response(JSON.stringify({ error: "Worker secret DEEPSEEK_API_KEY is not configured." }), { status: 503, headers: cors });
    try {
      const body = await request.json();
      const text = String(body.text || "").slice(0, 90000);
      if (!text.trim()) return new Response(JSON.stringify({ error: "No conversation text supplied." }), { status: 400, headers: cors });
      const existing = Array.isArray(body.existingNodes) ? body.existingNodes.slice(0, 300).map(n => ({ id:n.id, name:n.name, coreWord:n.coreWord, desc:n.desc, parentId:n.parentId })) : [];
      const system = `你是 NEBULA 知识图谱整理引擎。用户提供的是从 DeepSeek 对话导出的知识内容，不是要求你编造补全。
严格要求：
1. 只提取来源文本明确表达的知识；不确定标记 needsReview=true，不得臆造事实。
2. 保留原始语义和来源；区分宏观/中观/微观，层级深度不限；parentId 必须指向同一批或已有节点 id。
3. 将语义相同的知识合并到已有节点；近似但不同的概念保留独立节点并用 links 关联。不要只凭标题相似强行合并。
4. 每个节点输出 coreWord、name、desc、parentId、before、after、left、right、date、sourceNote、needsReview。
5. links 表示横向/因果/对比等非父子关系，格式 {source,target,type,label}。
6. 返回纯 JSON，结构为 {"nodes":[...],"links":[...],"mergeSuggestions":[...],"uncertain":[...]}。 `;
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.DEEPSEEK_MODEL || "deepseek-v4-pro",
          messages: [
            { role:"system", content:system },
            { role:"user", content:"已有知识节点（只用于去重与关系匹配）：\n"+JSON.stringify(existing)+"\n\n待分析的 DeepSeek 历史对话/笔记：\n"+text }
          ],
          response_format: { type:"json_object" },
          max_tokens: 12000,
          stream: false
        })
      });
      const data = await response.json();
      if (!response.ok) return new Response(JSON.stringify({ error: data.error?.message || "DeepSeek API request failed", status:response.status }), { status:502, headers:cors });
      const raw = data.choices?.[0]?.message?.content || "{}";
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error("DeepSeek returned invalid JSON; please retry with a smaller export."); }
      return new Response(JSON.stringify({ ok:true, result, usage:data.usage || null }), { headers:cors });
    } catch (error) {
      return new Response(JSON.stringify({ error:String(error.message || error) }), { status:500, headers:cors });
    }
  }
};
