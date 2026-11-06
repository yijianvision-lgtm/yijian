/* NEBULA local-first data layer.
 * All knowledge, source files and extracted text stay in this browser's IndexedDB.
 * No login, cloud database, account service or remote file storage.
 */
const DB_NAME = "nebula_local_v2";
const DB_VERSION = 2;
const STORES = ["graph", "references", "lectureSources", "aiConversations", "assets", "meta", "history"];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) {
        if (name === "references" || name === "lectureSources" || name === "aiConversations" || name === "assets" || name === "history") db.createObjectStore(name, { keyPath: "id" });
        else db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("无法打开本地知识库"));
  });
}
async function request(store, mode, action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || new Error("本地数据库操作失败"));
  });
}
const makeId = () => "ref_" + Date.now().toString(36) + "_" + crypto.randomUUID().replace(/-/g, "");
const extOf = file => (file.name.split(".").pop() || "").toLowerCase();

async function unzip(file) {
  const JSZip = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
  return JSZip.default.loadAsync(file);
}
function xmlText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return xml.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return (doc.documentElement?.textContent || "").replace(/\s+/g, " ").trim();
}
function walkXmind(node, out, parent = null) {
  if (!node || typeof node !== "object") return;
  const title = typeof node.title === "string" ? node.title : (node.topic?.title || "");
  if (title.trim()) out.push({ title: title.trim(), parent, note: node.notes?.plain?.content || node.notes?.content || "" });
  const here = title.trim() || parent;
  const children = node.children?.attached || node.children || [];
  if (Array.isArray(children)) children.forEach(child => walkXmind(child, out, here));
}
async function parseXmind(zip) {
  const out = [];
  const jsonEntry = zip.file("content.json");
  if (jsonEntry) {
    const data = JSON.parse(await jsonEntry.async("text"));
    for (const sheet of data) walkXmind(sheet.rootTopic || sheet.root || sheet, out, null);
  } else {
    const xmlEntry = zip.file("content.xml");
    if (xmlEntry) {
      const doc = new DOMParser().parseFromString(await xmlEntry.async("text"), "application/xml");
      const walk = (el, parent) => {
        if (!el || el.nodeType !== 1) return;
        const title = el.getAttribute("title") || el.querySelector(":scope > title")?.textContent || "";
        const nextParent = title.trim() || parent;
        if (title.trim()) out.push({ title: title.trim(), parent, note: "" });
        [...el.children].filter(x => /topic/i.test(x.localName)).forEach(x => walk(x, nextParent));
      };
      doc.querySelectorAll("sheet > topic, xmap-content > sheet > topic").forEach(x => walk(x, null));
    }
  }
  return out;
}
async function parseEmmx(zip) {
  const chunks = [];
  const tree = [];
  const files = Object.values(zip.files).filter(f => !f.dir && /\.xml$/i.test(f.name));
  for (const entry of files) {
    const raw = await entry.async("text");
    const text = xmlText(raw);
    if (text) chunks.push("[" + entry.name + "]\n" + text);
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    const elements = [...doc.querySelectorAll("*")];
    for (const el of elements) {
      const name = el.getAttribute("text") || el.getAttribute("title") || el.getAttribute("label");
      if (name && name.trim() && !el.children.length) tree.push({ title: name.trim(), parent: null, sourcePart: entry.name });
    }
  }
  return { text: chunks.join("\n\n"), tree };
}
async function parseFile(file) {
  const ext = extOf(file);
  const result = { text: "", html: "", tree: [], pages: [], warnings: [] };
  if (ext === "pdf") {
    const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map(x => x.str || "").join(" ").trim();
      result.pages.push({ page: p, text });
      result.text += "[第 " + p + " 页]\n" + text + "\n";
    }
    if (!result.text.trim()) result.warnings.push("PDF 可能是扫描件，需要 OCR 才能提取文字；原 PDF 已完整保留。");
  } else if (ext === "docx") {
    const mammoth = await import("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm");
    const buffer = await file.arrayBuffer();
    const [raw, rendered] = await Promise.all([
      mammoth.extractRawText({ arrayBuffer: buffer }),
      mammoth.convertToHtml({ arrayBuffer: buffer })
    ]);
    result.text = raw.value || "";
    result.html = rendered.value || "";
    if (rendered.messages?.length) result.warnings.push(...rendered.messages.map(x => x.message));
  } else if (ext === "emmx") {
    const parsed = await parseEmmx(await unzip(file));
    result.text = parsed.text;
    result.tree = parsed.tree;
    if (!result.text) result.warnings.push("已保存 EMMX 原文件，但未识别到可提取文字的 XML 结构。");
  } else if (ext === "xmind") {
    const zip = await unzip(file);
    result.tree = await parseXmind(zip);
    result.text = result.tree.map(n => (n.parent ? n.parent + " → " : "") + n.title + (n.note ? "\n" + n.note : "")).join("\n");
    if (!result.tree.length) result.warnings.push("已保存 XMind 原文件，但未识别到当前格式的主题结构。");
  } else if (ext === "doc") {
    result.warnings.push("DOC 二进制旧格式已保存原文件。为提取正文，请在 Word 中另存为 DOCX 或 PDF。");
  } else {
    throw new Error("暂不支持 ." + ext + " 文件。支持 PDF、DOCX、DOC、EMMX、XMind。");
  }
  return result;
}

export const NEBULA_LOCAL = {
  async saveGraph(nodes, links) {
    const graph = { id: "main", nodes, links, savedAt: Date.now(), schema: 2 };
    await request("graph", "readwrite", s => s.put(graph, "main"));
    return graph.savedAt;
  },
  async loadGraph() {
    return (await request("graph", "readonly", s => s.get("main"))) || null;
  },
  async saveReference(file) {
    if (!(file instanceof File)) throw new Error("请选择有效文件");
    const id = makeId();
    const parsed = await parseFile(file);
    const item = {
      id, name: file.name, extension: extOf(file), mime: file.type || "application/octet-stream",
      size: file.size, savedAt: Date.now(), blob: file, text: parsed.text, html: parsed.html,
      tree: parsed.tree, pages: parsed.pages, warnings: parsed.warnings
    };
    item.sourceLibrary = "lecture";
    await request("lectureSources", "readwrite", s => s.put(item));
    return { ...item, blob: undefined };
  },
  async listReferences() {
    const current = await request("lectureSources", "readonly", s => s.getAll());
    const legacy = await request("references", "readonly", s => s.getAll());
    const rows = [...legacy.filter(x => !current.some(y => y.id === x.id)), ...current];
    return rows.map(({ blob, ...item }) => item).sort((a,b) => b.savedAt-a.savedAt);
  },
  async getReference(id) {
    return (await request("lectureSources", "readonly", s => s.get(id))) || (await request("references", "readonly", s => s.get(id))) || null;
  },
  async deleteReference(id) {
    await request("lectureSources", "readwrite", s => s.delete(id));
    await request("references", "readwrite", s => s.delete(id));
    const db = await openDB();
    await new Promise((resolve,reject) => {
      const tx = db.transaction("assets","readwrite");
      const store = tx.objectStore("assets");
      const q = store.openCursor();
      q.onsuccess = () => { const c=q.result; if(!c)return; if(c.value.referenceId===id)c.delete(); c.continue(); };
      tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
    });
  },
  async saveConversation(record) {
    if (!record || !(record.transcript || record.text)) throw new Error("对话内容不能为空");
    const item = {
      id: record.id || makeId(), sourceLibrary: "ai",
      title: record.title || record.name || "AI 学习对话",
      source: record.source || "manual-import",
      transcript: record.transcript || record.text,
      analysis: record.analysis || null,
      savedAt: Date.now(), fileName: record.fileName || "",
      blob: record.blob || null, metadata: record.metadata || {}
    };
    await request("aiConversations", "readwrite", s => s.put(item));
    const { blob, ...safe } = item;
    return safe;
  },
  async listConversations() {
    return (await request("aiConversations", "readonly", s => s.getAll()))
      .map(({ blob, ...item }) => item).sort((a,b) => b.savedAt-a.savedAt);
  },
  async getConversation(id) {
    return (await request("aiConversations", "readonly", s => s.get(id))) || null;
  },
  async deleteConversation(id) {
    await request("aiConversations", "readwrite", s => s.delete(id));
  },
  async saveHistory(record) {
    const item = { id: record.id || makeId(), ...record, savedAt: Date.now() };
    await request("history", "readwrite", s => s.put(item));
    return item;
  },
  async listHistory() {
    return (await request("history", "readonly", s => s.getAll())).sort((a,b)=>b.savedAt-a.savedAt);
  },
  async saveMeta(key, value) {
    return request("meta", "readwrite", s => s.put(value, key));
  },
  async loadMeta(key) {
    return request("meta", "readonly", s => s.get(key));
  },
  async chooseFolder() {
    if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持文件夹授权，请使用 Chrome/Edge 或选择单个文件。");
    const handle = await window.showDirectoryPicker({ mode: "read" });
    const permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") throw new Error("没有获得文件夹读取授权。");
    await this.saveMeta("lectureFolder", handle);
    return handle.name;
  },
  async scanFolder() {
    const handle = await this.loadMeta("lectureFolder");
    if (!handle) throw new Error("请先选择并授权讲义文件夹。");
    let permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted") permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") throw new Error("文件夹读取权限已失效，请重新授权。");
    const accepted = new Set(["pdf","docx","doc","emmx","xmind"]);
    const found = [];
    const walk = async dir => {
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind === "directory") await walk(entry);
        else if (accepted.has((name.split(".").pop() || "").toLowerCase())) found.push(await entry.getFile());
      }
    };
    await walk(handle);
    const saved = [];
    for (const file of found) saved.push(await this.saveReference(file));
    return { scanned: found.length, saved: saved.length, names: found.map(f=>f.name) };
  },
  async requestPersistentStorage() {
    if (navigator.storage?.persist) return navigator.storage.persist();
    return false;
  },
  async estimateStorage() {
    return navigator.storage?.estimate ? navigator.storage.estimate() : null;
  }
};
async function migrateLegacyReferences() {
  try {
    const legacy = await new Promise((resolve, reject) => {
      const req = indexedDB.open("nebula_memory_v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!legacy.objectStoreNames.contains("references")) { legacy.close(); return; }
    const rows = await new Promise((resolve, reject) => {
      const tx = legacy.transaction("references", "readonly");
      const req = tx.objectStore("references").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    legacy.close();
    for (const old of rows) {
      const id = "legacy_" + String(old.id || makeId()).replace(/[^a-zA-Z0-9_-]/g, "_");
      if (!(await NEBULA_LOCAL.getReference(id))) {
        await request("lectureSources", "readwrite", s => s.put({
          id, sourceLibrary: "lecture", name: old.name || "旧版参考资料", extension: String(old.type || "").toLowerCase(),
          mime: "application/octet-stream", size: old.size || old.blob?.size || 0,
          savedAt: old.savedAt || Date.now(), blob: old.blob || null, text: old.text || "",
          html: "", tree: [], pages: [], warnings: ["从旧版本地参考资料库迁移；原文件与已提取文字已保留。"]
        }));
      }
    }
  } catch (e) { console.warn("NEBULA legacy reference migration skipped:", e); }
}
globalThis.NEBULA_LOCAL = NEBULA_LOCAL;
migrateLegacyReferences().finally(() => window.dispatchEvent(new CustomEvent("nebula-local-ready")));
