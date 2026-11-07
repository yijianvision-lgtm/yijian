/* NEBULA local-first data layer.
 * All knowledge, source files and extracted text stay in this browser's IndexedDB.
 * No login, cloud database, account service or remote file storage.
 */
const DB_NAME = "nebula_local_v2";
const DB_VERSION = 5;
const STORES = ["graph", "references", "lectureSources", "aiConversations", "assets", "meta", "history", "sources", "nodeSourceLinks", "knowledgeVersions", "reviewProposals", "learningRecords", "researchSessions", "knowledgeRelations", "extractionBatches", "extractionItems", "filterCases", "filterDecisions", "frameworks", "frameworkVersions", "nodePositions", "relationEvidence"];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) {
        if (["references","lectureSources","aiConversations","assets","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations","extractionBatches","extractionItems","filterCases","filterDecisions","frameworks","frameworkVersions","nodePositions","relationEvidence"].includes(name)) db.createObjectStore(name, { keyPath: "id" });
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
    let result, settled = false;
    let tx;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { db.close(); } catch {}
      reject(error || new Error("本地数据库操作失败"));
    };
    try {
      tx = db.transaction(store, mode);
      const req = action(tx.objectStore(store));
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => fail(req.error);
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        db.close();
        resolve(result);
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error || new Error("本地数据库操作已中止"));
    } catch (error) { fail(error); }
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
migrateLegacyReferences().finally(() => { backfillSourceCatalog(); window.dispatchEvent(new CustomEvent("nebula-local-ready")); });


// --- Cognitive OS persistence layer (schema v3) ----------------------------
const COGNITIVE_STORES = ["sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations"];
const makeRecordId = prefix => (prefix || "rec") + "_" + Date.now().toString(36) + "_" + crypto.randomUUID().replace(/-/g,"");
const nowISO = () => new Date().toISOString();
const cloneJSON = value => JSON.parse(JSON.stringify(value));
const normaliseTitle = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"").trim();
function tokenSet(value) {
  const s = normaliseTitle(value), chars = Array.from(s), out = new Set();
  if (chars.length <= 2) { if (s) out.add(s); return out; }
  for (let i=0;i<chars.length-1;i++) out.add(chars[i]+chars[i+1]);
  return out;
}
function similarityScore(a,b) {
  const A=tokenSet(a),B=tokenSet(b); if(!A.size||!B.size)return 0;
  let common=0; for(const x of A)if(B.has(x))common++;
  return 2*common/(A.size+B.size);
}
async function getAllEntries(storeName) {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,"readonly"), store=tx.objectStore(storeName);
    const keys=store.getAllKeys(), values=store.getAll();
    tx.oncomplete=()=>{db.close();resolve(values.result.map((value,i)=>({key:keys.result[i],value})));};
    tx.onerror=()=>{db.close();reject(tx.error);};
    tx.onabort=()=>{db.close();reject(tx.error||new Error("读取本地数据失败"));};
  });
}
async function getAllStoresSnapshot() {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORES,"readonly"), pending={};
    for(const name of STORES) {
      const store=tx.objectStore(name);
      pending[name]={keys:store.getAllKeys(),values:store.getAll()};
    }
    tx.oncomplete=()=>{
      const snapshot={};
      for(const name of STORES) {
        const pair=pending[name];
        snapshot[name]=pair.values.result.map((value,i)=>({key:pair.keys.result[i],value}));
      }
      db.close();resolve(snapshot);
    };
    tx.onerror=()=>{db.close();reject(tx.error||new Error("创建备份快照失败"));};
    tx.onabort=()=>{db.close();reject(tx.error||new Error("备份快照事务已中止"));};
  });
}
async function putRecord(storeName, record) {
  if(!record.id) record.id=makeRecordId(storeName);
  await request(storeName,"readwrite",s=>s.put(record));
  return record;
}
async function readRecord(storeName,id) {
  return (await request(storeName,"readonly",s=>s.get(id))) || null;
}
async function deleteRecord(storeName,id) {
  await request(storeName,"readwrite",s=>s.delete(id));
}
async function encodeBackupValue(value) {
  if(value instanceof Blob) {
    const bytes=new Uint8Array(await value.arrayBuffer());
    let binary="";
    for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return {$nebulaType:"Blob",mime:value.type||"application/octet-stream",base64:btoa(binary),size:value.size};
  }
  if(value instanceof Date) return {$nebulaType:"Date",value:value.toISOString()};
  if(value instanceof ArrayBuffer) {
    const bytes=new Uint8Array(value);let binary="";
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return {$nebulaType:"ArrayBuffer",base64:btoa(binary)};
  }
  if(ArrayBuffer.isView(value)) return {$nebulaType:"TypedArray",name:value.constructor.name,values:Array.from(value)};
  if(Array.isArray(value)) return Promise.all(value.map(encodeBackupValue));
  if(value&&typeof value==="object") {
    // File System Access handles are permissions, not user content; never serialize them.
    if(typeof value.queryPermission==="function" && typeof value.getFile==="function") return {$nebulaType:"OmittedHandle"};
    const out={};
    for(const [k,v] of Object.entries(value)) out[k]=await encodeBackupValue(v);
    return out;
  }
  return value;
}
function decodeBackupValue(value) {
  if(Array.isArray(value)) return value.map(decodeBackupValue);
  if(value&&typeof value==="object") {
    if(value.$nebulaType==="Blob") {
      const binary=atob(value.base64), bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return new Blob([bytes],{type:value.mime||"application/octet-stream"});
    }
    if(value.$nebulaType==="Date") return new Date(value.value);
    if(value.$nebulaType==="ArrayBuffer") {
      const binary=atob(value.base64), bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      return bytes.buffer;
    }
    if(value.$nebulaType==="TypedArray") {
      const C=globalThis[value.name]; return typeof C==="function" ? new C(value.values) : value.values;
    }
    if(value.$nebulaType==="OmittedHandle") return undefined;
    const out={}; for(const [k,v] of Object.entries(value)){const decoded=decodeBackupValue(v);if(decoded!==undefined)out[k]=decoded;} return out;
  }
  return value;
}
async function sha256Hex(text) {
  if(!crypto.subtle) throw new Error("当前环境不支持备份完整性校验，请使用 HTTPS 或 localhost。");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
const BACKUP_LOCAL_STORAGE_KEYS = ["nebula_nodes","nebula_links","nebula_data_generation","nebula_deepseek_worker_url","nebula_sync_history"];
async function backupPayload() {
  const stores={},snapshot=await getAllStoresSnapshot();
  for(const name of STORES) {
    const rows=[];
    for(const entry of snapshot[name]||[]) {
      if(name==="meta" && entry.key==="lectureFolder") continue;
      rows.push({key:await encodeBackupValue(entry.key),value:await encodeBackupValue(entry.value)});
    }
    stores[name]=rows;
  }
  const local={};
  try { for(const key of BACKUP_LOCAL_STORAGE_KEYS) { const value=localStorage.getItem(key); if(value!==null)local[key]=value; } } catch {}
  return {format:"NEBULA_FULL_BACKUP",schemaVersion:5,exportedAt:nowISO(),stores,localStorage:local,
    manifest:Object.fromEntries(Object.entries(stores).map(([k,v])=>[k,{records:v.length}])),
    notes:["原始讲义与 AI 对话分别备份，包含原始文件 Blob。","仅备份非敏感的 NEBULA 本地设置；访问令牌和 API 密钥不会导出。","本地文件夹授权句柄不会导出，恢复后需重新授权。"]};
}
async function makeFullBackup() {
  const payload=await backupPayload();
  const canonical=JSON.stringify(payload);
  const backup={...payload,integrity:{algorithm:"SHA-256",digest:await sha256Hex(canonical)}};
  const json=JSON.stringify(backup);
  return {blob:new Blob([json],{type:"application/vnd.nebula.backup+json"}),fileName:"nebula-full-backup-"+new Date().toISOString().slice(0,10)+".json",bytes:new Blob([json]).size,manifest:payload.manifest};
}
async function validateFullBackup(input) {
  const parsed=typeof input==="string"?JSON.parse(input):input;
  if(!parsed||parsed.format!=="NEBULA_FULL_BACKUP"||!parsed.stores||typeof parsed.stores!=="object"||![3,4,5].includes(Number(parsed.schemaVersion))) throw new Error("这不是有效或受支持的 NEBULA 完整备份文件。");
  const supported=new Set(STORES);
  for(const [name,rows] of Object.entries(parsed.stores)) {
    if(!supported.has(name)||!Array.isArray(rows)) throw new Error("备份包含不支持的数据表："+name);
    for(const row of rows) if(!row||!("key" in row)||!("value" in row)) throw new Error("备份记录结构不完整："+name);
  }
  if(parsed.integrity?.algorithm==="SHA-256") {
    const {integrity,...payload}=parsed;
    const actual=await sha256Hex(JSON.stringify(payload));
    if(actual!==integrity.digest) throw new Error("备份完整性校验失败：文件可能损坏或被修改。");
  } else throw new Error("备份缺少有效的 SHA-256 完整性校验。");
  return parsed;
}
async function previewFullBackup(fileOrObject) {
  const raw=typeof fileOrObject?.text==="function"?await fileOrObject.text():fileOrObject;
  const parsed=await validateFullBackup(raw);
  const manifest=Object.fromEntries(Object.entries(parsed.stores).map(([k,v])=>[k,v.length]));
  return {valid:true,exportedAt:parsed.exportedAt,schemaVersion:parsed.schemaVersion,manifest,totalRecords:Object.values(manifest).reduce((a,b)=>a+b,0)};
}
async function restoreFullBackup(fileOrObject, options={}) {
  const raw=typeof fileOrObject?.text==="function"?await fileOrObject.text():fileOrObject;
  const parsed=await validateFullBackup(raw);
  const mode=options.mode||"merge";
  if(!["replace","merge"].includes(mode)) throw new Error("恢复模式只能是 replace 或 merge。");
  const storeNames=mode==="replace"?STORES:Object.keys(parsed.stores).filter(n=>STORES.includes(n));
  const db=await openDB();
  const restored={};
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(storeNames,"readwrite");
    for(const name of storeNames) {
      const store=tx.objectStore(name), rows=parsed.stores[name]||[];
      restored[name]={imported:0,skipped:0};
      if(mode==="replace") store.clear();
      for(const row of rows) {
        const key=decodeBackupValue(row.key), value=decodeBackupValue(row.value);
        if(name==="meta" && key==="lectureFolder") continue;
        if(mode==="replace") {
          if(store.keyPath) store.put(value); else store.put(value,key);
          restored[name].imported++;
        } else if(name==="graph" && key==="main") {
          const get=store.get(key);
          get.onsuccess=()=>{
            const current=get.result;
            if(!current) { store.put(value,key); restored[name].imported++; return; }
            const unique=(a,b)=>{const map=new Map();for(const item of [...(a||[]),...(b||[])])if(item?.id!=null&&!map.has(String(item.id)))map.set(String(item.id),item);return [...map.values()];};
            store.put({...value,...current,nodes:unique(current.nodes,value.nodes),links:unique(current.links,value.links),savedAt:Date.now()},key);
            restored[name].imported++;
          };
        } else {
          const lookup=store.keyPath?store.get(value?.[store.keyPath]):store.get(key);
          lookup.onsuccess=()=>{
            if(lookup.result===undefined) {
              if(store.keyPath)store.put(value);else store.put(value,key);
              restored[name].imported++;
            } else restored[name].skipped++;
          };
        }
      }
    }
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||new Error("恢复失败，数据库事务已回滚。"));
    tx.onabort=()=>reject(tx.error||new Error("恢复已中止，数据库事务已回滚。"));
  }).finally(()=>db.close());
  let localStorageSynced=true;
  if(mode==="replace" && typeof localStorage!=="undefined" && Number(parsed.schemaVersion)>=4 && Object.prototype.hasOwnProperty.call(parsed,"localStorage")) {
    try {
      const saved=parsed.localStorage&&typeof parsed.localStorage==="object"?parsed.localStorage:{};
      for(const key of BACKUP_LOCAL_STORAGE_KEYS) {
        if(Object.prototype.hasOwnProperty.call(saved,key))localStorage.setItem(key,String(saved[key]));
        else localStorage.removeItem(key);
      }
    } catch(error) { localStorageSynced=false; console.warn("NEBULA restored IndexedDB successfully; legacy localStorage cache could not be synchronized:",error); }
  }
  return {mode,restoredStores:storeNames,restored,manifest:Object.fromEntries(Object.entries(parsed.stores).map(([k,v])=>[k,v.length])),localStorageSynced,folderPermission:"需重新授权"};
}
async function createKnowledgeProposal(record) {
  const allowed=new Set(["create","update","merge","split","reparent","relation"]);
  if(!record||!allowed.has(record.proposalType)) throw new Error("不支持的建议类型。");
  return putRecord("reviewProposals",{...record,id:record.id||makeRecordId("proposal"),status:"pending",createdAt:Date.now(),reviewedAt:null});
}
async function applyKnowledgeProposal(id, decision, reviewerNote="") {
  const proposal=await readRecord("reviewProposals",id);
  if(!proposal) throw new Error("找不到这条待审核建议。");
  if(proposal.status!=="pending") throw new Error("这条建议已经审核过。");
  if(decision!=="accept"&&decision!=="reject") throw new Error("审核决定无效。");
  if(decision==="reject") {
    proposal.status="rejected";proposal.reviewerNote=reviewerNote;proposal.reviewedAt=Date.now();
    await putRecord("reviewProposals",proposal);return proposal;
  }
  const graph=await NEBULA_LOCAL.loadGraph();
  const nodes=Array.isArray(graph?.nodes)?graph.nodes:[], links=Array.isArray(graph?.links)?graph.links:[];
  const before=proposal.targetNodeId?nodes.find(n=>String(n.id)===String(proposal.targetNodeId)):null;
  const snapshot=proposal.proposedSnapshot||{};
  const validateParent=(nodeId,parentId)=>{
    if(parentId==null||parentId==="")return;
    if(String(parentId)===String(nodeId))throw new Error("知识节点不能成为自己的上级。");
    let cursor=nodes.find(n=>String(n.id)===String(parentId)),visited=new Set();
    if(!cursor)throw new Error("上级节点不存在，未应用建议。");
    while(cursor){
      if(String(cursor.id)===String(nodeId))throw new Error("检测到父子层级循环，未应用建议。");
      if(visited.has(String(cursor.id)))throw new Error("现有知识层级已存在循环，需先修复。");
      visited.add(String(cursor.id));cursor=nodes.find(n=>String(n.id)===String(cursor.parentId));
    }
  };
  let resultingNodeId=proposal.targetNodeId||snapshot.id||makeRecordId("node");
  if(proposal.proposalType==="create") {
    if(nodes.some(n=>String(n.id)===String(resultingNodeId))) throw new Error("目标节点 ID 已存在，未应用建议。");
    validateParent(resultingNodeId,snapshot.parentId);
    const created={...snapshot,id:resultingNodeId};
    const version={id:makeRecordId("version"),nodeId:resultingNodeId,versionNumber:1,contentSnapshot:cloneJSON(created),changeReason:proposal.reasoning||"用户审核通过的 AI 建议",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:null};
    await putRecord("knowledgeVersions",version);created.currentVersionId=version.id;nodes.push(created);
  } else if(proposal.proposalType==="update"||proposal.proposalType==="reparent") {
    if(!before) throw new Error("找不到目标节点，未应用建议。");
    validateParent(before.id,Object.prototype.hasOwnProperty.call(snapshot,"parentId")?snapshot.parentId:before.parentId);
    const version={id:makeRecordId("version"),nodeId:before.id,versionNumber:(await getAllEntries("knowledgeVersions")).filter(x=>x.value.nodeId===before.id).length+1,contentSnapshot:cloneJSON(before),changeReason:proposal.reasoning||"审核通过的 AI 建议",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:before.currentVersionId||null};
    await putRecord("knowledgeVersions",version);
    const index=nodes.findIndex(n=>String(n.id)===String(before.id));
    nodes[index]={...before,...snapshot,id:before.id,currentVersionId:version.id,updatedAt:Date.now()};
    const afterVersion={id:makeRecordId("version"),nodeId:before.id,versionNumber:version.versionNumber+1,contentSnapshot:cloneJSON(nodes[index]),changeReason:"审核通过后的新版本",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:version.id};
    await putRecord("knowledgeVersions",afterVersion);nodes[index].currentVersionId=afterVersion.id;
  } else if(proposal.proposalType==="relation") {
    const relation={id:makeRecordId("relation"),sourceNodeId:proposal.sourceNodeId||proposal.targetNodeId,targetNodeId:proposal.relatedNodeId||snapshot.targetNodeId,type:snapshot.type||"related",label:snapshot.label||"",rationale:proposal.reasoning||"",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now()};
    const knownNodeIds=new Set(nodes.map(n=>String(n.id)));
    if(!relation.sourceNodeId||!relation.targetNodeId||String(relation.sourceNodeId)===String(relation.targetNodeId)||!knownNodeIds.has(String(relation.sourceNodeId))||!knownNodeIds.has(String(relation.targetNodeId))) throw new Error("关系两端节点无效或不存在，未应用建议。");
    await putRecord("knowledgeRelations",relation).catch(async()=>{throw new Error("关系记录写入失败。");});
  } else if(proposal.proposalType==="merge") {
    if(!before) throw new Error("合并建议缺少保留目标节点。");
    const sourceIds=[...new Set((proposal.sourceNodeIds||proposal.mergeNodeIds||snapshot.sourceNodeIds||[]).map(String))].filter(id=>id!==String(before.id));
    if(!sourceIds.length) throw new Error("合并建议必须明确 sourceNodeIds，未执行任何更改。");
    const sources=sourceIds.map(id=>nodes.find(n=>String(n.id)===id));
    if(sources.some(n=>!n)) throw new Error("合并来源节点有缺失，未执行任何更改。");
    const allVersions=(await getAllEntries("knowledgeVersions")).map(x=>x.value);
    for(const n of [before,...sources]) {
      const prior=allVersions.filter(v=>String(v.nodeId)===String(n.id)).sort((a,b)=>a.versionNumber-b.versionNumber).at(-1);
      await putRecord("knowledgeVersions",{id:makeRecordId("version"),nodeId:n.id,versionNumber:(prior?.versionNumber||0)+1,contentSnapshot:cloneJSON(n),changeReason:"合并前自动留档",evidenceSourceIds:[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:prior?.id||null});
    }
    const sourceSet=new Set(sourceIds), mergedSnapshot={...snapshot};delete mergedSnapshot.sourceNodeIds;
    let ancestorId=before.parentId,ancestorSeen=new Set();
    while(ancestorId!=null&&!ancestorSeen.has(String(ancestorId))){if(sourceSet.has(String(ancestorId)))throw new Error("不能把目标节点合并进自己的祖先节点，否则会形成循环层级。");ancestorSeen.add(String(ancestorId));ancestorId=nodes.find(n=>String(n.id)===String(ancestorId))?.parentId;}
    const updatedTarget={...before,...mergedSnapshot,id:before.id,updatedAt:Date.now(),mergedFrom:sourceIds};
    const remap=id=>sourceSet.has(String(id))?before.id:id;
    for(const n of nodes) if(sourceSet.has(String(n.parentId))) n.parentId=before.id;
    const remappedLinks=[];
    for(const link of links) {
      let next;
      if(Array.isArray(link)) next=[remap(link[0]),remap(link[1])];
      else if(link&&typeof link==="object") next={...link,source:remap(link.source??link.from),target:remap(link.target??link.to),from:link.from==null?link.from:remap(link.from),to:link.to==null?link.to:remap(link.to)};
      else continue;
      const a=Array.isArray(next)?next[0]:(next.source??next.from),b=Array.isArray(next)?next[1]:(next.target??next.to);
      if(String(a)!==String(b)&&!remappedLinks.some(x=>JSON.stringify(x)===JSON.stringify(next)))remappedLinks.push(next);
    }
    links.splice(0,links.length,...remappedLinks);
    const evidence=await request("nodeSourceLinks","readonly",s=>s.getAll());
    for(const row of evidence.filter(x=>sourceSet.has(String(x.nodeId)))) {
      const duplicate=evidence.some(x=>String(x.nodeId)===String(before.id)&&x.sourceId===row.sourceId&&x.evidenceLocator===row.evidenceLocator);
      if(!duplicate)await putRecord("nodeSourceLinks",{...row,id:makeRecordId("evidence"),nodeId:before.id,linkedAt:Date.now()});
      await deleteRecord("nodeSourceLinks",row.id);
    }
    const relations=await request("knowledgeRelations","readonly",s=>s.getAll());
    for(const relation of relations) {
      const nextSource=remap(relation.sourceNodeId),nextTarget=remap(relation.targetNodeId);
      if(nextSource!==relation.sourceNodeId||nextTarget!==relation.targetNodeId) {
        if(String(nextSource)===String(nextTarget)) await deleteRecord("knowledgeRelations",relation.id);
        else await putRecord("knowledgeRelations",{...relation,sourceNodeId:nextSource,targetNodeId:nextTarget,updatedAt:Date.now()});
      }
    }
    const index=nodes.findIndex(n=>String(n.id)===String(before.id));nodes[index]=updatedTarget;
    for(let i=nodes.length-1;i>=0;i--)if(sourceSet.has(String(nodes[i].id)))nodes.splice(i,1);
    resultingNodeId=before.id;
    const latest=allVersions.filter(v=>String(v.nodeId)===String(before.id)).sort((a,b)=>a.versionNumber-b.versionNumber).at(-1);
    const afterVersion=await putRecord("knowledgeVersions",{id:makeRecordId("version"),nodeId:before.id,versionNumber:(latest?.versionNumber||0)+2,contentSnapshot:cloneJSON(updatedTarget),changeReason:"合并后的知识版本",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:latest?.id||null});
    updatedTarget.currentVersionId=afterVersion.id;
  } else if(proposal.proposalType==="split") {
    if(!before) throw new Error("拆分建议缺少原始节点。");
    const proposed=proposal.proposedNodes||snapshot.nodes;
    if(!Array.isArray(proposed)||proposed.length<2) throw new Error("拆分建议必须提供至少两个 proposedNodes，未执行任何更改。");
    const prior=(await getAllEntries("knowledgeVersions")).map(x=>x.value).filter(v=>String(v.nodeId)===String(before.id)).sort((a,b)=>a.versionNumber-b.versionNumber).at(-1);
    await putRecord("knowledgeVersions",{id:makeRecordId("version"),nodeId:before.id,versionNumber:(prior?.versionNumber||0)+1,contentSnapshot:cloneJSON(before),changeReason:"拆分前自动留档",evidenceSourceIds:[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:prior?.id||null});
    const splitNodes=proposed.map((item,i)=>({...item,id:i===0?before.id:(item.id&&!nodes.some(n=>String(n.id)===String(item.id))?item.id:makeRecordId("node")),parentId:item.parentId??before.parentId??null,level:item.level??before.level??1,createdAt:item.createdAt||Date.now(),updatedAt:Date.now()}));
    const index=nodes.findIndex(n=>String(n.id)===String(before.id));nodes.splice(index,1,splitNodes[0],...splitNodes.slice(1));
    for(const item of splitNodes) {
      const priorRows=(await getAllEntries("knowledgeVersions")).map(x=>x.value).filter(v=>String(v.nodeId)===String(item.id));
      const latest=priorRows.sort((a,b)=>a.versionNumber-b.versionNumber).at(-1);
      const version=await putRecord("knowledgeVersions",{id:makeRecordId("version"),nodeId:item.id,versionNumber:(latest?.versionNumber||0)+1,contentSnapshot:cloneJSON(item),changeReason:"审核通过的知识拆分",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:latest?.id||null});
      item.currentVersionId=version.id;
    }
    resultingNodeId=before.id;
  }
  await NEBULA_LOCAL.saveGraph(nodes,links);
  if(resultingNodeId&&Array.isArray(proposal.evidenceSourceIds)&&proposal.evidenceSourceIds.length) {
    try {
      const knownSources=new Set((await NEBULA_LOCAL.listSources()).map(x=>String(x.id)));
      const existingEvidence=await NEBULA_LOCAL.listNodeSources(resultingNodeId);
      const linked=new Set(existingEvidence.map(x=>String(x.sourceId)));
      for(const sourceId of proposal.evidenceSourceIds)if(knownSources.has(String(sourceId))&&!linked.has(String(sourceId)))await NEBULA_LOCAL.linkNodeSource({nodeId:resultingNodeId,sourceId,evidenceType:"ai-review-evidence"});
    } catch(error) { proposal.evidenceLinkWarning=String(error.message||error); }
  }
  proposal.status="accepted";proposal.reviewerNote=reviewerNote;proposal.reviewedAt=Date.now();proposal.resultingNodeId=resultingNodeId;
  await putRecord("reviewProposals",proposal);
  await NEBULA_LOCAL.saveHistory({type:"proposal-applied",proposalId:id,nodeId:resultingNodeId,reason:proposal.reasoning||"",at:Date.now()});
  return proposal;
}
async function duplicateCandidates(nodes, options={}) {
  const threshold=Number(options.threshold??0.78), limit=Number(options.limit??100), out=[];
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) {
    const a=nodes[i],b=nodes[j],score=similarityScore(a.coreWord||a.name,b.coreWord||b.name);
    if(score>=threshold) out.push({leftId:a.id,rightId:b.id,leftTitle:a.name,rightTitle:b.name,score:Number(score.toFixed(3)),decisionRequired:true});
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,limit);
}
Object.assign(NEBULA_LOCAL,{
  async exportFullBackup(){return makeFullBackup();},
  async previewFullBackup(input){return previewFullBackup(input);},
  async restoreFullBackup(input,options){return restoreFullBackup(input,options);},
  async saveSource(record){
    const types=new Set(["lecture","ai_conversation","paper","personal_note","web"]);
    if(!record||!types.has(record.sourceType))throw new Error("来源类型无效。");
    return putRecord("sources",{...record,id:record.id||makeRecordId("source"),createdAt:record.createdAt||Date.now(),updatedAt:Date.now()});
  },
  async getSource(id){return readRecord("sources",id);},
  async listSources(){return (await request("sources","readonly",s=>s.getAll())).sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt));},
  async linkNodeSource(record){
    if(!record?.nodeId||!record?.sourceId)throw new Error("节点与来源 ID 均为必填。");
    const graph=await this.loadGraph();
    if(!(graph?.nodes||[]).some(n=>String(n.id)===String(record.nodeId)))throw new Error("目标知识节点不存在，不能建立来源关联。");
    if(!(await this.getSource(record.sourceId)))throw new Error("来源记录不存在，不能建立来源关联。");
    const exists=(await request("nodeSourceLinks","readonly",s=>s.getAll())).find(x=>String(x.nodeId)===String(record.nodeId)&&String(x.sourceId)===String(record.sourceId)&&x.evidenceLocator===record.evidenceLocator);
    if(exists)return exists;
    return putRecord("nodeSourceLinks",{...record,id:makeRecordId("evidence"),linkedAt:Date.now()});
  },
  async unlinkNodeSource(id){return deleteRecord("nodeSourceLinks",id);},
  async listNodeSources(nodeId){return (await request("nodeSourceLinks","readonly",s=>s.getAll())).filter(x=>x.nodeId===nodeId);},
  async listSourceNodes(sourceId){return (await request("nodeSourceLinks","readonly",s=>s.getAll())).filter(x=>x.sourceId===sourceId);},
  async createProposal(record){return createKnowledgeProposal(record);},
  async listProposals(status){const rows=await request("reviewProposals","readonly",s=>s.getAll());return rows.filter(x=>!status||x.status===status).sort((a,b)=>b.createdAt-a.createdAt);},
  async applyProposal(id,decision,reviewerNote){return applyKnowledgeProposal(id,decision,reviewerNote);},
  async deleteProposal(id){return deleteRecord("reviewProposals",id)},
  async listNodeVersions(nodeId){return (await request("knowledgeVersions","readonly",s=>s.getAll())).filter(x=>x.nodeId===nodeId).sort((a,b)=>a.versionNumber-b.versionNumber);},
  async saveNodeVersion(node,reason="用户编辑",createdBy="user"){
    if(!node?.id)throw new Error("节点 ID 缺失，无法建立版本。");
    const rows=(await request("knowledgeVersions","readonly",s=>s.getAll())).filter(x=>String(x.nodeId)===String(node.id)).sort((a,b)=>a.versionNumber-b.versionNumber);
    const latest=rows.at(-1),snapshot=cloneJSON(node);
    const comparable=x=>JSON.stringify({name:x.name,coreWord:x.coreWord,desc:x.desc,before:x.before,after:x.after,left:x.left,right:x.right,parentId:x.parentId,status:x.status,confidence:x.confidence});
    if(latest&&comparable(latest.contentSnapshot)===comparable(snapshot))return latest;
    const version={id:makeRecordId("version"),nodeId:node.id,versionNumber:(latest?.versionNumber||0)+1,contentSnapshot:snapshot,changeReason:reason,evidenceSourceIds:[],createdAt:Date.now(),createdBy,supersedesVersionId:latest?.id||null};
    await putRecord("knowledgeVersions",version);node.currentVersionId=version.id;return version;
  },
  async saveLearningRecord(record){
    if(!record?.nodeId||!record?.activityType)throw new Error("学习记录缺少节点或活动类型。");
    const now=record.createdAt||Date.now(),activity=String(record.activityType).toLowerCase();
    const scheduled=["recall","active-recall","oral-recall","quiz","mnemonic","flashcard"].some(x=>activity.includes(x));
    let schedule=null;
    if(scheduled){
      const history=(await this.listLearningRecords(record.nodeId)).filter(x=>x.schedule).sort((a,b)=>b.createdAt-a.createdAt),prior=history[0]?.schedule||{};
      let quality=Number(record.quality??record.score??3);if(quality>=0&&quality<=1)quality*=5;quality=Math.max(0,Math.min(5,Math.round(quality)));
      const repetitions=quality<3?0:(Number(prior.repetitions)||0)+1;
      const intervalDays=quality<3?1:repetitions===1?1:repetitions===2?3:Math.max(1,Math.round((Number(prior.intervalDays)||3)*(Number(prior.easeFactor)||2.5)));
      const easeFactor=Math.max(1.3,(Number(prior.easeFactor)||2.5)+(0.1-(5-quality)*(0.08+(5-quality)*0.02)));
      schedule={quality,repetitions,intervalDays,easeFactor,nextReviewAt:now+intervalDays*86400000};
    }
    return putRecord("learningRecords",{...record,id:record.id||makeRecordId("learn"),createdAt:now,...(schedule?{schedule}: {})});
  },
  async listLearningRecords(nodeId){const rows=await request("learningRecords","readonly",s=>s.getAll());return rows.filter(x=>!nodeId||x.nodeId===nodeId).sort((a,b)=>b.createdAt-a.createdAt);},
  async saveResearchSession(record){return putRecord("researchSessions",{...record,id:record.id||makeRecordId("research"),updatedAt:Date.now(),createdAt:record.createdAt||Date.now()});},
  async listResearchSessions(){return (await request("researchSessions","readonly",s=>s.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt);},
  async findDuplicateCandidates(nodes,options){return duplicateCandidates(nodes||[],options||{});},
  async detectKnowledgeGaps(nodeId){
    const graph=await this.loadGraph(),nodes=graph?.nodes||[];
    const targets=nodeId?nodes.filter(n=>String(n.id)===String(nodeId)):nodes;
    const [links,learning]=await Promise.all([request("nodeSourceLinks","readonly",s=>s.getAll()),this.listLearningRecords()]);
    const gaps=[];
    for(const node of targets){
      const evidence=links.filter(x=>String(x.nodeId)===String(node.id));
      const records=learning.filter(x=>String(x.nodeId)===String(node.id));
      const missing=[];
      const check=(key,label)=>{if(!String(node[key]||"").trim())missing.push({key,label});};
      check("desc","核心定义与解释");
      check("mechanism","运行机制与因果过程");
      check("before","起源、前置条件与背景");
      check("after","后续影响与演化");
      check("left","横向关联与跨领域联系");
      check("right","反例、限制与竞争解释");
      if(!Array.isArray(node.examples)||!node.examples.length)missing.push({key:"examples",label:"具体案例"});
      if(!Array.isArray(node.counterexamples)||!node.counterexamples.length)missing.push({key:"counterexamples",label:"反例或边界案例"});
      if(!evidence.length)missing.push({key:"evidence",label:"可追溯来源与证据定位"});
      if(node.needsReview||node.status==="needs_review")missing.push({key:"verification",label:"事实核验"});
      if(!records.length)missing.push({key:"recall",label:"主动回忆与口头复述记录"});
      if(!records.some(x=>["application","transfer","case-analysis"].includes(x.activityType)))missing.push({key:"transfer",label:"迁移应用与案例分析记录"});
      if(missing.length)gaps.push({nodeId:node.id,title:node.name||node.coreWord||String(node.id),missing,missingCount:missing.length,priority:(node.needsReview||node.status==="needs_review"?4:0)+Math.min(missing.length,8),evidenceCount:evidence.length,learningCount:records.length});
    }
    return gaps.sort((a,b)=>b.priority-a.priority||b.missingCount-a.missingCount);
  },
  async buildLearningQueue(limit=30){
    const graph=await this.loadGraph(),nodes=graph?.nodes||[],gaps=await this.detectKnowledgeGaps(),records=await this.listLearningRecords(),now=Date.now();
    const byId=new Map(nodes.map(n=>[String(n.id),n])),gapMap=new Map(gaps.map(g=>[String(g.nodeId),g])),dueMap=new Map();
    for(const record of records)if(record.schedule?.nextReviewAt<=now){const key=String(record.nodeId),old=dueMap.get(key);if(!old||record.schedule.nextReviewAt<old.schedule.nextReviewAt)dueMap.set(key,record);}
    for(const [nodeId,record] of dueMap)if(!gapMap.has(nodeId)){const node=byId.get(nodeId);if(node)gapMap.set(nodeId,{nodeId,title:node.name||node.coreWord||nodeId,missing:[],missingCount:0,priority:2,evidenceCount:0,learningCount:records.filter(x=>String(x.nodeId)===nodeId).length});}
    return [...gapMap.values()].map(g=>{const due=dueMap.get(String(g.nodeId));const structural=g.missing.some(x=>x.key==="verification"||x.key==="evidence")?"核验来源与事实":g.missing.some(x=>x.key==="recall")?"进行主动回忆与口头复述":g.missing.some(x=>x.key==="transfer")?"完成一个迁移应用案例":"补齐知识结构缺口";return {node:byId.get(String(g.nodeId)),...g,dueForReview:!!due,nextReviewAt:due?.schedule?.nextReviewAt||null,priority:g.priority+(due?2:0),nextAction:due?"进行间隔复习（已到期）":structural};}).sort((a,b)=>b.priority-a.priority||b.missingCount-a.missingCount).slice(0,Math.max(1,Math.min(200,Number(limit)||30)));
  },
  async getCognitiveDashboard(){
    const [sources,proposals,learning,research,graph,gaps]=await Promise.all([this.listSources(),this.listProposals("pending"),this.listLearningRecords(),this.listResearchSessions(),this.loadGraph(),this.detectKnowledgeGaps()]);
    const nodes=graph?.nodes||[];
    return {nodeCount:nodes.length,sourceCount:sources.length,pendingReviews:proposals.length,learningRecords:learning.length,researchSessions:research.length,needsReviewCount:nodes.filter(n=>n.needsReview||n.status==="needs_review").length,knowledgeGapCount:gaps.length,missingEvidenceCount:gaps.filter(g=>g.missing.some(x=>x.key==="evidence")).length,dueReviewCount:learning.filter(x=>x.schedule?.nextReviewAt<=Date.now()).length,generatedAt:Date.now()};
  }
});

// Source catalog adapters: original files and conversations remain in their own stores.
const originalSaveReference = NEBULA_LOCAL.saveReference.bind(NEBULA_LOCAL);
const originalSaveConversation = NEBULA_LOCAL.saveConversation.bind(NEBULA_LOCAL);
async function sha256BufferHex(buffer) {
  const digest=await crypto.subtle.digest("SHA-256",buffer);
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
NEBULA_LOCAL.saveReference = async function(file) {
  const fileHash=await sha256BufferHex(await file.arrayBuffer());
  const previous=(await this.listReferences()).find(x=>x.fileHash===fileHash);
  if(previous) return {...previous,duplicate:true,blob:undefined};
  const item=await originalSaveReference(file);
  const stored=await this.getReference(item.id);
  stored.fileHash=fileHash;
  await request("lectureSources","readwrite",s=>s.put(stored));
  item.fileHash=fileHash;
  await this.saveSource({id:"src_"+item.id,sourceType:"lecture",title:item.name,referenceId:item.id,fileName:item.name,mime:item.mime,size:item.size,fileHash,parserWarnings:item.warnings||[],createdAt:item.savedAt});
  return item;
};
NEBULA_LOCAL.saveConversation = async function(record) {
  const transcript=String(record?.transcript||record?.text||"");
  const contentHash=await sha256Hex(transcript);
  const previous=(await this.listConversations()).find(x=>x.contentHash===contentHash);
  if(previous && !record?.id) return {...previous,duplicate:true};
  const item=await originalSaveConversation(record);
  const stored=await this.getConversation(item.id);
  stored.contentHash=contentHash;
  await request("aiConversations","readwrite",s=>s.put(stored));
  item.contentHash=contentHash;
  await this.saveSource({id:"src_"+item.id,sourceType:"ai_conversation",title:item.title,referenceId:item.id,fileName:item.fileName||"",origin:item.source||"manual-import",contentHash,createdAt:item.savedAt||Date.now()});
  return item;
};
Object.assign(NEBULA_LOCAL,{
  async saveKnowledgeRelation(record) {
    if(!record?.sourceNodeId||!record?.targetNodeId||String(record.sourceNodeId)===String(record.targetNodeId))throw new Error("关系两端节点必须有效且不能相同。");
    const graph=await this.loadGraph(),ids=new Set((graph?.nodes||[]).map(n=>String(n.id)));
    if(!ids.has(String(record.sourceNodeId))||!ids.has(String(record.targetNodeId)))throw new Error("关系引用了不存在的知识节点。");
    return putRecord("knowledgeRelations",{...record,id:record.id||makeRecordId("relation"),createdAt:record.createdAt||Date.now()});
  },
  async listKnowledgeRelations(nodeId) {
    const rows=await request("knowledgeRelations","readonly",s=>s.getAll());
    return rows.filter(x=>!nodeId||x.sourceNodeId===nodeId||x.targetNodeId===nodeId);
  },
  async deleteKnowledgeRelation(id){return deleteRecord("knowledgeRelations",id);}
});

async function backfillSourceCatalog() {
  try {
    const [lectures,conversations,known]=await Promise.all([NEBULA_LOCAL.listReferences(),NEBULA_LOCAL.listConversations(),NEBULA_LOCAL.listSources()]);
    const ids=new Set(known.map(x=>x.id));
    for(const item of lectures) {
      const id="src_"+item.id;
      if(!ids.has(id)) await NEBULA_LOCAL.saveSource({id,sourceType:"lecture",title:item.name,referenceId:item.id,fileName:item.name,mime:item.mime,size:item.size,parserWarnings:item.warnings||[],createdAt:item.savedAt||Date.now()});
    }
    for(const item of conversations) {
      const id="src_"+item.id;
      if(!ids.has(id)) await NEBULA_LOCAL.saveSource({id,sourceType:"ai_conversation",title:item.title,referenceId:item.id,fileName:item.fileName||"",origin:item.source||"manual-import",createdAt:item.savedAt||Date.now()});
    }
  } catch(error) { console.warn("NEBULA source catalog backfill deferred:",error); }
}
backfillSourceCatalog();

async function callNebulaWorker(endpoint,token,path,options={}) {
  if(!endpoint||!token)throw new Error("请先填写 Worker 地址和访问令牌。");
  let parsed;
  try { parsed=new URL(String(endpoint).trim()); } catch { throw new Error("Worker 地址不是有效 URL。"); }
  if(parsed.protocol!=="https:" && !["localhost","127.0.0.1"].includes(parsed.hostname))throw new Error("出于安全考虑，访问令牌和知识内容只能发送到 HTTPS Worker。");
  if(parsed.username||parsed.password)throw new Error("Worker 地址不能包含用户名或密码。");
  const base=parsed.origin+parsed.pathname.replace(/\/+$/,"").replace(/\/(analyze|coach|mnemonic|research|share)$/,"");
  const url=base+path;
  const headers={"Authorization":"Bearer "+token};
  if(options.body!==undefined)headers["Content-Type"]="application/json";
  const response=await fetch(url,{method:options.method||"POST",headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
  let data;try{data=await response.json();}catch{throw new Error("Worker 返回了无法识别的响应。");}
  if(!response.ok)throw new Error(data.error||("Worker 请求失败（"+response.status+"）"));
  return data;
}
Object.assign(NEBULA_LOCAL,{
  async analyzeConversation(endpoint,token,text,existingNodes=[]) {
    if(!String(text||"").trim())throw new Error("待分析对话不能为空。");
    return callNebulaWorker(endpoint,token,"/analyze",{body:{text:String(text).slice(0,90000),existingNodes:existingNodes.slice(0,300)}});
  },
  async coachKnowledge(endpoint,token,payload) {
    return callNebulaWorker(endpoint,token,"/coach",{body:payload||{}});
  },
  async checkMnemonic(endpoint,token,payload) {
    return callNebulaWorker(endpoint,token,"/mnemonic",{body:payload||{}});
  },
  async proposeCoachReview(endpoint,token,payload={}){
    const result=await this.coachKnowledge(endpoint,token,payload);
    const graph=await this.loadGraph(),nodes=graph?.nodes||[];
    const target=payload.nodeId?nodes.find(n=>String(n.id)===String(payload.nodeId)):null;
    const four=result.result?.fourDimensions||result.fourDimensions||{};
    const analysis=result.result||result;
    const concise=analysis.concise||analysis.corrected;
    const proposedSnapshot=target?{...target,coachAnalysis:analysis,needsReview:!!analysis.needsReview||target.needsReview,...(typeof concise==="string"?{desc:concise}:{}),...(typeof four.foresight==="string"?{before:four.foresight}:{}),...(typeof four.aftermath==="string"?{after:four.aftermath}:{}),...(typeof four.lateral==="string"?{left:four.lateral}:{}),...(typeof four.counterview==="string"?{right:four.counterview}:{})}:{name:String(payload.title||payload.userInput||payload.answer||"待命名知识").slice(0,100),desc:typeof concise==="string"?concise:"AI 学习教练生成的候选知识，需人工核验。",coachAnalysis:analysis,needsReview:true};
    const proposal=await this.createProposal({proposalType:target?"update":"create",targetNodeId:target?.id||null,proposedSnapshot,reasoning:"AI 学习教练建议；审核前不会修改正式知识。",evidenceSourceIds:Array.isArray(payload.evidenceSourceIds)?payload.evidenceSourceIds:[],analysis});
    return {proposal,analysis};
  },
  async proposeMnemonicReview(endpoint,token,payload={}){
    if(!payload.nodeId)throw new Error("口诀审核必须关联一个知识节点。");
    const result=await this.checkMnemonic(endpoint,token,payload);
    const analysis=result.result||result,graph=await this.loadGraph();
    const node=(graph?.nodes||[]).find(n=>String(n.id)===String(payload.nodeId));
    if(!node)throw new Error("找不到口诀所属的知识节点。");
    const proposal=await this.createProposal({proposalType:"update",targetNodeId:node.id,proposedSnapshot:{...node,mnemonicReview:analysis,mnemonicSuggestion:analysis.suggestedVersion||"",mnemonicOriginal:analysis.original||payload.mnemonic||""},reasoning:"AI 口诀核验结果；保留原口诀，仅将建议版本作为候选。",evidenceSourceIds:Array.isArray(payload.evidenceSourceIds)?payload.evidenceSourceIds:[],analysis});
    return {proposal,analysis};
  },
  async searchResearch(endpoint,token,query) {
    if(!String(query||"").trim())throw new Error("请输入论文检索关键词。");
    return callNebulaWorker(endpoint,token,"/research?q="+encodeURIComponent(String(query).slice(0,240)),{method:"GET"});
  },
  async fetchDeepSeekShare(endpoint,token,shareUrl) {
    return callNebulaWorker(endpoint,token,"/share",{body:{url:shareUrl}});
  },
  async getNodeEvidence(nodeId) {
    const links=await this.listNodeSources(nodeId);
    const result=[];
    for(const link of links) result.push({link,source:await this.getSource(link.sourceId)});
    return result;
  },
  async getSourceContent(sourceId) {
    const source=await this.getSource(sourceId);
    if(!source)return null;
    if(source.sourceType==="lecture")return {source,record:await this.getReference(source.referenceId)};
    if(source.sourceType==="ai_conversation")return {source,record:await this.getConversation(source.referenceId)};
    return {source,record:null};
  }
});


// --- Guanfu Mind P1: extraction, filtering and framework records (schema v5) ---
const FILTER_STATUSES = new Set(["received","extracting","extracted","filtering","needs_review","approved","rejected","failed","archived"]);
const FILTER_TRANSITIONS = {
  received: new Set(["extracting","failed","archived"]),
  extracting: new Set(["extracted","failed","archived"]),
  extracted: new Set(["filtering","needs_review","failed","archived"]),
  filtering: new Set(["needs_review","failed","archived"]),
  needs_review: new Set(["filtering","approved","rejected","archived"]),
  approved: new Set(["archived"]),
  rejected: new Set(["filtering","archived"]),
  failed: new Set(["received","archived"]),
  archived: new Set()
};
const requireId = (value,label) => {
  if(value===undefined||value===null||String(value).trim()==="") throw new Error(label+" ID 为必填项。");
  return String(value);
};
const requireText = (value,label,max=20000) => {
  const text=String(value??"").trim();
  if(!text) throw new Error(label+"不能为空。");
  if(text.length>max) throw new Error(label+"长度超出限制。");
  return text;
};
const cleanRecord = record => {
  if(!record||typeof record!=="object"||Array.isArray(record)) throw new Error("记录格式无效。");
  return {...record};
};
async function createManagedRecord(store,record,prefix,required=[]) {
  const item=cleanRecord(record);
  for(const [key,label] of required) requireId(item[key],label);
  const now=Date.now();
  item.id=item.id?requireId(item.id,"记录"):makeRecordId(prefix);
  item.createdAt=Number(item.createdAt)||now;
  item.updatedAt=now;
  await putRecord(store,item);
  return item;
}
async function updateManagedRecord(store,id,patch,allowedFields) {
  const current=await readRecord(store,requireId(id,"记录"));
  if(!current) throw new Error("找不到要更新的记录。");
  const changes=cleanRecord(patch);
  for(const key of Object.keys(changes)) if(!allowedFields.includes(key)) throw new Error("不允许更新字段："+key);
  const next={...current,...changes,id:current.id,createdAt:current.createdAt,updatedAt:Date.now()};
  await putRecord(store,next);
  return next;
}
async function transitionFilterRecord(store,id,nextStatus,patch={}) {
  if(!FILTER_STATUSES.has(nextStatus)) throw new Error("过滤状态无效。");
  const current=await readRecord(store,requireId(id,"记录"));
  if(!current) throw new Error("找不到过滤记录。");
  if(current.status!==nextStatus&&!FILTER_TRANSITIONS[current.status]?.has(nextStatus)) throw new Error("不允许从 "+current.status+" 直接变更为 "+nextStatus+"。");
  const changes=cleanRecord(patch);
  if(["id","createdAt","status","updatedAt"].some(key=>Object.prototype.hasOwnProperty.call(changes,key))) throw new Error("状态变更补丁不能覆盖系统字段。");
  const next={...current,...changes,status:nextStatus,updatedAt:Date.now()};
  await putRecord(store,next);
  return next;
}
function splitExtractionText(value,maxLength=1100) {
  const normalized=String(value||"").replace(/\r/g,"\n").replace(/[ \t]+/g," ").trim();
  if(!normalized) return [];
  const paragraphs=normalized.split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);
  const units=paragraphs.flatMap(paragraph=>{
    if(paragraph.length<=maxLength) return [paragraph];
    const sentences=paragraph.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    const chunks=[];let current="";
    for(const sentence of sentences.length?sentences:[paragraph]) {
      if(current && (current.length+sentence.length+1)>maxLength) {chunks.push(current);current=sentence;}
      else current+=(current?" ":"")+sentence;
    }
    if(current) chunks.push(current);
    return chunks;
  });
  return units;
}
function buildReferenceExtractionCandidates(reference) {
  const candidates=[];
  const tree=Array.isArray(reference.tree)?reference.tree:[];
  if(tree.length) {
    for(let i=0;i<tree.length;i++) {
      const node=tree[i]||{},title=String(node.title||"").trim(),note=String(node.note||"").trim();
      const content=[title,note].filter(Boolean).join("\n");
      if(!content) continue;
      candidates.push({title:title||"思维导图主题 "+(i+1),content,excerpt:content.slice(0,700),candidateType:"topic",
        locator:{kind:"topic",topicIndex:i,topicPath:[node.parent,title].filter(Boolean),sourcePart:node.sourcePart||null},
        parserMetadata:{structure:"mindmap",sourcePart:node.sourcePart||null}});
    }
    return candidates;
  }
  const pages=Array.isArray(reference.pages)?reference.pages:[];
  if(pages.length) {
    for(const page of pages) {
      const pageNo=Number(page.page)||null;
      const chunks=splitExtractionText(page.text);
      chunks.forEach((content,index)=>candidates.push({
        title:"第 "+(pageNo||"?")+" 页 · 片段 "+(index+1),content,excerpt:content.slice(0,700),candidateType:"page_chunk",
        locator:{kind:"pdf_page",page:pageNo,chunk:index+1},parserMetadata:{structure:"pdf_page"}
      }));
    }
    return candidates;
  }
  let structured=[];
  if(reference.html && typeof DOMParser!=="undefined") {
    const doc=new DOMParser().parseFromString(reference.html,"text/html");
    structured=[...doc.body.querySelectorAll("h1,h2,h3,h4,p,li")].map((el,index)=>({
      title:/^h[1-4]$/i.test(el.tagName)?el.textContent.trim():"段落 "+(index+1),
      content:(el.textContent||"").trim(),kind:/^h[1-4]$/i.test(el.tagName)?"heading":"paragraph",index
    })).filter(x=>x.content);
  }
  if(structured.length) {
    structured.forEach(item=>{
      const chunks=splitExtractionText(item.content);
      chunks.forEach((content,index)=>candidates.push({
        title:item.title+(chunks.length>1?" · "+(index+1):""),content,excerpt:content.slice(0,700),candidateType:item.kind,
        locator:{kind:"document_block",blockIndex:item.index,blockType:item.kind,chunk:index+1},
        parserMetadata:{structure:"docx_html"}
      }));
    });
    return candidates;
  }
  const chunks=splitExtractionText(reference.text);
  chunks.forEach((content,index)=>candidates.push({
    title:"正文片段 "+(index+1),content,excerpt:content.slice(0,700),candidateType:"text_chunk",
    locator:{kind:"text_offset",chunk:index+1},parserMetadata:{structure:"plain_text"}
  }));
  return candidates;
}

Object.assign(NEBULA_LOCAL,{
  async createExtractionBatch(record) {
    const item=cleanRecord(record);
    if(item.sourceId && !(await this.getSource(item.sourceId))) throw new Error("提取批次引用的来源不存在。");
    item.status=item.status||"received";
    if(!FILTER_STATUSES.has(item.status)) throw new Error("提取批次状态无效。");
    return createManagedRecord("extractionBatches",{...item,stats:item.stats||{total:0,completed:0,failed:0},warnings:Array.isArray(item.warnings)?item.warnings:[]},"extract",[]);
  },
  async createExtractionFromParsedSource(input) {
    const data=cleanRecord(input);
    const sourceId=requireId(data.sourceId,"来源");
    const referenceId=requireId(data.referenceId,"原始资料");
    if(!(await this.getSource(sourceId))) throw new Error("提取来源记录不存在。");
    const reference={name:data.name||"未命名资料",text:data.text||"",html:data.html||"",tree:data.tree||[],pages:data.pages||[],warnings:data.warnings||[]};
    const candidates=buildReferenceExtractionCandidates(reference);
    const seen=new Set(),unique=[];
    for(const candidate of candidates) {
      const normalized=String(candidate.content).toLowerCase().replace(/\s+/g," ").trim();
      if(!normalized||seen.has(normalized)) continue;
      seen.add(normalized);unique.push(candidate);
    }
    const batch=await this.createExtractionBatch({
      sourceId,referenceId,sourceName:reference.name,parserVersion:"nebula-extract-v1",
      status:"received",startedAt:Date.now(),warnings:[...reference.warnings],
      stats:{total:unique.length,completed:0,failed:0}
    });
    await this.updateExtractionBatch(batch.id,{status:"extracting"});
    try {
      const items=[];
      for(const candidate of unique) {
        items.push(await this.createExtractionItem({
          ...candidate,batchId:batch.id,sourceId,referenceId,
          quality:{status:"unreviewed",characterCount:candidate.content.length},
          status:"extracted"
        }));
      }
      let filterCase=null;
      if(items.length) filterCase=await this.createFilterCase({
        inputItemIds:items.map(x=>x.id),sourceId,batchId:batch.id,
        currentStage:"dedupe",status:"extracted",summary:"由资料接入流程自动生成，等待辨异与定位"
      });
      const completed=await this.updateExtractionBatch(batch.id,{
        status:"extracted",completedAt:Date.now(),stats:{total:unique.length,completed:items.length,failed:0},
        extractionItemIds:items.map(x=>x.id),filterCaseId:filterCase?.id||null
      });
      return {...completed,items,filterCase};
    } catch(error) {
      await this.updateExtractionBatch(batch.id,{status:"failed",completedAt:Date.now(),lastError:error.message,stats:{total:unique.length,completed:0,failed:unique.length}});
      throw error;
    }
  },
  async getExtractionBatch(id){return readRecord("extractionBatches",id);},
  async listExtractionBatches(sourceId){return (await request("extractionBatches","readonly",s=>s.getAll())).filter(x=>!sourceId||String(x.sourceId)===String(sourceId)).sort((a,b)=>b.createdAt-a.createdAt);},
  async updateExtractionBatch(id,patch={}) {
    const current=await readRecord("extractionBatches",id);
    if(!current) throw new Error("找不到提取批次。");
    const changes=cleanRecord(patch);
    const nextStatus=changes.status||current.status;delete changes.status;
    const next=await transitionFilterRecord("extractionBatches",id,nextStatus,changes);
    return next;
  },
  async createExtractionItem(record) {
    const item=cleanRecord(record);
    item.batchId=requireId(item.batchId,"提取批次");
    const batch=await this.getExtractionBatch(item.batchId);
    if(!batch) throw new Error("提取候选必须属于一个已存在的提取批次。");
    if(item.sourceId && !(await this.getSource(item.sourceId))) throw new Error("提取候选引用的来源不存在。");
    item.status=item.status||"extracted";
    if(!FILTER_STATUSES.has(item.status)) throw new Error("提取候选状态无效。");
    return createManagedRecord("extractionItems",{...item,excerpt:String(item.excerpt||""),locator:item.locator||null},"item",[]);
  },
  async getExtractionItem(id){return readRecord("extractionItems",id);},
  async listExtractionItems(batchId){return (await request("extractionItems","readonly",s=>s.getAll())).filter(x=>!batchId||String(x.batchId)===String(batchId)).sort((a,b)=>a.createdAt-b.createdAt);},
  async updateExtractionItem(id,patch={}) {
    const allowed=["title","content","normalizedContent","excerpt","locator","candidateType","quality","parserMetadata","warnings","sourceId"];
    const changes=cleanRecord(patch),current=await readRecord("extractionItems",id);
    if(!current) throw new Error("找不到提取候选。");
    const nextStatus=changes.status||current.status;delete changes.status;
    for(const key of Object.keys(changes)) if(!allowed.includes(key)) throw new Error("不允许更新提取候选字段："+key);
    if(changes.sourceId && !(await this.getSource(changes.sourceId))) throw new Error("提取候选引用的来源不存在。");
    return transitionFilterRecord("extractionItems",id,nextStatus,changes);
  },
  async createFilterCase(record) {
    const item=cleanRecord(record);
    const ids=[...new Set((item.inputItemIds||[]).map(x=>requireId(x,"提取候选")))];
    if(!ids.length) throw new Error("过滤任务至少需要一个提取候选。");
    for(const id of ids) if(!(await this.getExtractionItem(id))) throw new Error("过滤任务引用了不存在的提取候选："+id);
    item.inputItemIds=ids;
    // A filter case is created only after its input extraction items exist.
    item.status=item.status||"extracted";
    if(!FILTER_STATUSES.has(item.status)) throw new Error("过滤任务状态无效。");
    item.currentStage=item.currentStage||"dedupe";
    item.proposedNodeIds=Array.isArray(item.proposedNodeIds)?item.proposedNodeIds:[];
    return createManagedRecord("filterCases",item,"filter",[]);
  },
  async getFilterCase(id){return readRecord("filterCases",id);},
  async listFilterCases(status) {return (await request("filterCases","readonly",s=>s.getAll())).filter(x=>!status||x.status===status).sort((a,b)=>b.updatedAt-a.updatedAt);},
  async updateFilterCase(id,patch={}) {
    const changes=cleanRecord(patch),current=await readRecord("filterCases",id);
    if(!current) throw new Error("找不到过滤任务。");
    const nextStatus=changes.status||current.status;delete changes.status;
    const allowed=["currentStage","inputItemIds","candidateNodeId","proposedNodeIds","duplicateCandidates","locationSuggestions","relationSuggestions","evidenceGaps","conflicts","summary","reviewProposalId","lastError","dedupeAnalyzedAt","dedupeThreshold","completedAt","completionSummary"];
    for(const key of Object.keys(changes)) if(!allowed.includes(key)) throw new Error("不允许更新过滤任务字段："+key);
    if(changes.inputItemIds) {
      changes.inputItemIds=[...new Set(changes.inputItemIds.map(x=>requireId(x,"提取候选")))];
      for(const itemId of changes.inputItemIds) if(!(await this.getExtractionItem(itemId))) throw new Error("过滤任务引用了不存在的提取候选："+itemId);
    }
    return transitionFilterRecord("filterCases",id,nextStatus,changes);
  },
  async appendFilterDecision(record) {
    const item=cleanRecord(record);
    item.filterCaseId=requireId(item.filterCaseId,"过滤任务");
    if(!(await this.getFilterCase(item.filterCaseId))) throw new Error("决策引用的过滤任务不存在。");
    const types=new Set(["dedupe","classify","locate","relate","verify","accept","reject","defer","edit"]);
    if(!types.has(item.decisionType)) throw new Error("过滤决策类型无效。");
    item.actor=item.actor||"user";
    item.evidenceIds=Array.isArray(item.evidenceIds)?[...new Set(item.evidenceIds.map(String))]:[];
    return createManagedRecord("filterDecisions",item,"decision",[]);
  },
  async listFilterDecisions(filterCaseId) {return (await request("filterDecisions","readonly",s=>s.getAll())).filter(x=>!filterCaseId||String(x.filterCaseId)===String(filterCaseId)).sort((a,b)=>a.createdAt-b.createdAt);},
  async createFramework(record) {
    const item=cleanRecord(record);
    item.title=requireText(item.title,"框架名称",300);
    item.rootNodeIds=Array.isArray(item.rootNodeIds)?[...new Set(item.rootNodeIds.map(String))]:[];
    item.status=item.status||"active";
    const saved=await createManagedRecord("frameworks",item,"framework",[]);
    const version=await this.saveFrameworkVersion({frameworkId:saved.id,snapshot:{...saved},changeSummary:"创建框架",createdBy:"user"});
    saved.versionId=version.id;
    await putRecord("frameworks",{...saved,updatedAt:Date.now()});
    return {...saved,versionId:version.id};
  },
  async getFramework(id){return readRecord("frameworks",id);},
  async listFrameworks(){return (await request("frameworks","readonly",s=>s.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt);},
  async updateFramework(id,patch={}) {
    const allowed=["title","description","rootNodeIds","status","metadata"];
    const next=await updateManagedRecord("frameworks",id,patch,allowed);
    const version=await this.saveFrameworkVersion({frameworkId:next.id,snapshot:{...next},changeSummary:"更新框架",createdBy:"user"});
    const saved={...next,versionId:version.id,updatedAt:Date.now()};
    await putRecord("frameworks",saved);
    return saved;
  },
  async saveFrameworkVersion(record) {
    const item=cleanRecord(record);
    item.frameworkId=requireId(item.frameworkId,"框架");
    if(!(await this.getFramework(item.frameworkId))) throw new Error("框架版本引用的框架不存在。");
    if(!item.snapshot||typeof item.snapshot!=="object") throw new Error("框架版本必须保存完整快照。");
    return createManagedRecord("frameworkVersions",item,"framework_version",[]);
  },
  async listFrameworkVersions(frameworkId) {return (await request("frameworkVersions","readonly",s=>s.getAll())).filter(x=>String(x.frameworkId)===String(frameworkId)).sort((a,b)=>a.createdAt-b.createdAt);},
  async saveNodePosition(record) {
    const item=cleanRecord(record);
    item.nodeId=requireId(item.nodeId,"知识节点");
    item.frameworkId=requireId(item.frameworkId,"框架");
    if(!(await this.getFramework(item.frameworkId))) throw new Error("节点位置引用的框架不存在。");
    return putRecord("nodePositions",{...item,id:item.frameworkId+"::"+item.nodeId,updatedAt:Date.now()});
  },
  async getNodePosition(frameworkId,nodeId){return readRecord("nodePositions",String(frameworkId)+"::"+String(nodeId));},
  async listNodePositions(frameworkId){return (await request("nodePositions","readonly",s=>s.getAll())).filter(x=>!frameworkId||String(x.frameworkId)===String(frameworkId));},
  async createRelationEvidence(record) {
    const item=cleanRecord(record);
    item.relationId=requireId(item.relationId,"知识关系");
    const relations=await request("knowledgeRelations","readonly",s=>s.getAll());
    if(!relations.some(x=>String(x.id)===String(item.relationId))) throw new Error("证据引用的知识关系不存在。");
    if(item.sourceId && !(await this.getSource(item.sourceId))) throw new Error("关系证据引用的来源不存在。");
    item.reviewStatus=item.reviewStatus||"proposed";
    if(!["proposed","confirmed","disputed","unknown"].includes(item.reviewStatus)) throw new Error("关系证据状态无效。");
    return createManagedRecord("relationEvidence",item,"relation_evidence",[]);
  },
  async listRelationEvidence(relationId) {return (await request("relationEvidence","readonly",s=>s.getAll())).filter(x=>!relationId||String(x.relationId)===String(relationId)).sort((a,b)=>a.createdAt-b.createdAt);}
});


// Automatically route newly saved original materials into the extraction queue.
// The original binary remains untouched in lectureSources; extracted records are separate candidates.
const saveReferenceBeforeExtraction = NEBULA_LOCAL.saveReference.bind(NEBULA_LOCAL);
NEBULA_LOCAL.saveReference = async function(file) {
  const saved=await saveReferenceBeforeExtraction(file);
  if(saved.duplicate) return saved;
  const sourceId="src_"+saved.id;
  try {
    if(!(await this.getSource(sourceId))) await this.saveSource({
      id:sourceId,sourceType:"lecture",title:saved.name,referenceId:saved.id,
      fileName:saved.name,mime:saved.mime,size:saved.size,
      parserWarnings:saved.warnings||[],createdAt:saved.savedAt||Date.now()
    });
    const pipeline=await this.createExtractionFromParsedSource({
      sourceId,referenceId:saved.id,name:saved.name,text:saved.text,html:saved.html,
      tree:saved.tree,pages:saved.pages,warnings:saved.warnings
    });
    return {...saved,extractionBatchId:pipeline.id,extractionItemCount:pipeline.items.length,filterCaseId:pipeline.filterCase?.id||null,
      extractionStatus:pipeline.status};
  } catch(error) {
    return {...saved,extractionStatus:"failed",extractionError:error.message};
  }
};


// Deterministic candidate comparison: suggestions only, never an automatic merge.
function extractionTokenSet(value) {
  const text=String(value||"").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  const tokens=new Set(text.match(/[a-z0-9]{2,}/g)||[]);
  const compact=text.replace(/\s+/g,"");
  const chars=Array.from(compact);
  for(let i=0;i<chars.length-1;i++) tokens.add(chars[i]+chars[i+1]);
  return tokens;
}
function extractionDice(a,b) {
  if(!a.size&&!b.size) return 1;
  let intersection=0;
  for(const token of a) if(b.has(token)) intersection++;
  const union=a.size+b.size-intersection;
  return union?2*intersection/(a.size+b.size):0;
}
Object.assign(NEBULA_LOCAL,{
  async analyzeFilterCaseDuplicates(filterCaseId,options={}) {
    const filterCase=await this.getFilterCase(filterCaseId);
    if(!filterCase) throw new Error("找不到过滤任务。");
    if(!["extracted","filtering","needs_review"].includes(filterCase.status)) throw new Error("当前过滤任务状态不允许执行重复辨异。");
    const items=[];
    for(const id of filterCase.inputItemIds||[]) {
      const item=await this.getExtractionItem(id);
      if(item) items.push(item);
    }
    const threshold=Math.max(0.55,Math.min(0.98,Number(options.threshold)||0.78));
    const tokenCache=new Map(items.map(item=>[item.id,extractionTokenSet(item.normalizedContent||item.content||item.excerpt)]));
    const pairs=[];
    for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) {
      const a=items[i],b=items[j];
      const textA=String(a.normalizedContent||a.content||a.excerpt||"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
      const textB=String(b.normalizedContent||b.content||b.excerpt||"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
      if(!textA||!textB) continue;
      const exact=textA===textB;
      const lengthRatio=Math.min(textA.length,textB.length)/Math.max(textA.length,textB.length);
      const similarity=exact?1:extractionDice(tokenCache.get(a.id),tokenCache.get(b.id));
      if(exact||(Math.min(textA.length,textB.length)>=30&&lengthRatio>=0.65&&similarity>=threshold)) {
        pairs.push({
          itemIds:[a.id,b.id],score:Number(similarity.toFixed(4)),
          matchType:exact?"exact":"near_duplicate",
          titles:[a.title||"",b.title||""],
          sourceLocators:[a.locator||null,b.locator||null],
          status:"proposed"
        });
      }
    }
    const nextStatus=filterCase.status==="extracted"?"filtering":filterCase.status;
    const updated=await this.updateFilterCase(filterCaseId,{
      status:nextStatus,currentStage:"dedupe_review",duplicateCandidates:pairs,
      dedupeAnalyzedAt:Date.now(),dedupeThreshold:threshold
    });
    for(const pair of pairs) {
      await this.appendFilterDecision({
        filterCaseId,decisionType:"dedupe",actor:"system",
        before:{itemIds:pair.itemIds},after:{matchType:pair.matchType,score:pair.score},
        rationale:pair.matchType==="exact"?"规范化文本完全一致，作为重复候选提交人工核对。":"文本片段相似度达到候选阈值，作为近似重复提交人工核对。",
        evidenceIds:pair.itemIds
      });
    }
    return {filterCase:updated,pairs,comparedItems:items.length,threshold};
  },
  async recordFilterDuplicateDecision(filterCaseId,itemIds,action,rationale="") {
    const filterCase=await this.getFilterCase(filterCaseId);
    if(!filterCase) throw new Error("找不到过滤任务。");
    const ids=[...new Set((itemIds||[]).map(String))];
    if(ids.length!==2) throw new Error("重复辨异决策必须对应两个候选项。");
    const pair=(filterCase.duplicateCandidates||[]).find(x=>x.itemIds?.length===2&&ids.every(id=>x.itemIds.includes(id)));
    if(!pair) throw new Error("这两个候选项不在当前重复候选列表中。");
    if(!["mark_duplicate","keep_separate","defer"].includes(action)) throw new Error("重复辨异决策无效。");
    const decision=await this.appendFilterDecision({
      filterCaseId,decisionType:"dedupe",actor:"user",before:{itemIds:ids,matchType:pair.matchType,score:pair.score},
      after:{action},rationale:String(rationale||"用户确认重复辨异结果。"),evidenceIds:ids
    });
    const duplicateCandidates=(filterCase.duplicateCandidates||[]).map(x=>
      x.itemIds?.length===2&&ids.every(id=>x.itemIds.includes(id))?{...x,resolution:action,resolvedAt:Date.now(),decisionId:decision.id}:x
    );
    await this.updateFilterCase(filterCaseId,{duplicateCandidates});
    return decision;
  }
});


// Four-dimensional placement and relation suggestions.
// This engine is deterministic and evidence-aware: it proposes, never writes into the formal graph.
function mindTextTokens(value) {
  const text=String(value||"").normalize("NFKC").toLowerCase();
  const tokens=new Set(text.match(/[a-z0-9]{2,}/g)||[]);
  const compact=text.replace(/[^\p{L}\p{N}]/gu,"");
  const chars=Array.from(compact);
  for(let i=0;i<chars.length-1;i++) tokens.add(chars[i]+chars[i+1]);
  return tokens;
}
function mindDice(a,b) {
  if(!a.size||!b.size) return 0;
  let overlap=0;for(const token of a)if(b.has(token))overlap++;
  return 2*overlap/(a.size+b.size);
}
function mindEraHints(value) {
  const text=String(value||"");
  const hints=text.match(/(?:公元前\s*)?\d{1,4}\s*(?:年|世纪)|(?:新石器时代|夏商周|春秋|战国|秦汉|汉代|魏晋|南北朝|隋唐|宋代|元代|明代|清代|当代|近现代)/g)||[];
  return [...new Set(hints.map(x=>x.replace(/\s+/g,"")))];
}
function mindSpatialHints(value) {
  const vocab=["哲学","历史","艺术","绘画","政治","经济","社会","心理","科学","技术","医学","教育","文学","宗教","地理","建筑","设计","管理","认知","语言"];
  const text=String(value||"");
  return vocab.filter(x=>text.includes(x));
}
Object.assign(NEBULA_LOCAL,{
  async suggestFilterCaseLocations(filterCaseId,options={}) {
    const filterCase=await this.getFilterCase(filterCaseId);
    if(!filterCase) throw new Error("找不到过滤任务。");
    if(!["filtering","needs_review"].includes(filterCase.status)) throw new Error("请先完成提取和重复辨异，再进行四维定位。");
    const graph=await this.loadGraph(),nodes=Array.isArray(graph?.nodes)?graph.nodes:[];
    const suggestions=[];
    const minScore=Math.max(.12,Math.min(.8,Number(options.minScore)||.2));
    for(const itemId of filterCase.inputItemIds||[]) {
      const item=await this.getExtractionItem(itemId);if(!item)continue;
      const content=[item.title,item.content,item.excerpt].filter(Boolean).join("\n");
      const tokens=mindTextTokens(content);
      const source=item.sourceId?await this.getSource(item.sourceId):null;
      const topicPath=item.locator?.topicPath||[];
      const parentHint=topicPath.length>1?topicPath.at(-2):null;
      const parentMatches=nodes.map(node=>({
        node,score:parentHint?mindDice(mindTextTokens(parentHint),mindTextTokens(node.name||node.coreWord)):mindDice(tokens,mindTextTokens([node.name,node.coreWord,node.desc].join(" ")))
      })).filter(x=>x.score>=minScore).sort((a,b)=>b.score-a.score).slice(0,4);
      for(const match of parentMatches) suggestions.push({
        itemId,dimension:"lineage",kind:"parent_candidate",targetNodeId:match.node.id,
        targetTitle:match.node.name||match.node.coreWord,score:Number(match.score.toFixed(4)),
        confidence:match.score>=.55?"medium":"low",
        reasoning:parentHint?"原始主题树提供了父主题线索，与现有节点名称进行文本匹配。":"候选内容与该节点的标题/核心词/说明存在词项重合，建议人工核对层级。",
        evidence:{sourceId:item.sourceId||null,referenceId:item.referenceId||null,locator:item.locator||null,excerpt:item.excerpt||item.content?.slice(0,300)||""},
        uncertainty:"文本匹配不能证明父子关系；需核对定义范围与框架层级。"
      });
      const candidateEra=mindEraHints([item.title,content].join(" "));
      const timeMatches=nodes.map(node=>{
        const nodeEra=mindEraHints([node.date,node.knowledgeTime,node.name,node.desc].join(" "));
        const shared=candidateEra.filter(x=>nodeEra.includes(x));
        return {node,shared};
      }).filter(x=>x.shared.length);
      for(const match of timeMatches.slice(0,4)) suggestions.push({
        itemId,dimension:"time",kind:"temporal_neighbor",targetNodeId:match.node.id,
        targetTitle:match.node.name,score:.62,confidence:"medium",
        reasoning:"候选文本与现有节点包含相同的明确时代/时间词："+match.shared.join("、")+"。",
        evidence:{sourceId:item.sourceId||null,referenceId:item.referenceId||null,locator:item.locator||null,excerpt:item.excerpt||""},
        uncertainty:"时代词相同不等于先后、因果或同一时期；需核对具体时间范围。"
      });
      const candidateDomains=mindSpatialHints(content);
      for(const node of nodes) {
        const nodeDomains=mindSpatialHints([node.domain,node.domainPath,node.name,node.desc].join(" "));
        const shared=candidateDomains.filter(x=>nodeDomains.includes(x));
        if(shared.length) suggestions.push({
          itemId,dimension:"space",kind:"domain_neighbor",targetNodeId:node.id,targetTitle:node.name,
          score:.58,confidence:"medium",reasoning:"候选与现有节点出现相同领域词："+shared.join("、")+"。",
          evidence:{sourceId:item.sourceId||null,referenceId:item.referenceId||null,locator:item.locator||null,excerpt:item.excerpt||""},
          uncertainty:"领域词仅是分类线索，不能代替领域归属审核。"
        });
      }
      const related=nodes.map(node=>({node,score:mindDice(tokens,mindTextTokens([node.name,node.coreWord,node.desc].join(" ")))}))
        .filter(x=>x.score>=Math.max(.32,minScore+.12)&&x.node.id!==item.targetNodeId)
        .sort((a,b)=>b.score-a.score).slice(0,5);
      for(const match of related) {
        const sameParent=nodes.some(n=>n.id===match.node.id&&n.parentId===item.parentId);
        suggestions.push({
          itemId,dimension:"horizontal",kind:"related_concept",targetNodeId:match.node.id,
          targetTitle:match.node.name||match.node.coreWord,score:Number(match.score.toFixed(4)),
          confidence:match.score>=.58?"medium":"low",
          reasoning:"候选文本与该节点存在主题词项重合；建议检查是否属于同级、跨分支或跨领域关系。",
          relationType:"related",evidence:{sourceId:item.sourceId||null,referenceId:item.referenceId||null,locator:item.locator||null,excerpt:item.excerpt||""},
          uncertainty:"相似词项不代表语义关系，需确认关联类型及方向。"
        });
      }
      if(!parentMatches.length&&!candidateEra.length&&!candidateDomains.length&&!related.length) {
        suggestions.push({itemId,dimension:"lineage",kind:"unplaced",confidence:"unknown",score:0,
          reasoning:"现有框架中没有足够证据支持自动定位，建议先保留为待归位候选。",
          evidence:{sourceId:item.sourceId||null,referenceId:item.referenceId||null,locator:item.locator||null},
          uncertainty:"不能据此断言知识无归属；需要补充上下文或由用户创建框架位置。"});
      }
    }
    const updated=await this.updateFilterCase(filterCaseId,{
      status:filterCase.status==="filtering"?"needs_review":filterCase.status,
      currentStage:"four_dimension_review",locationSuggestions:suggestions,
      relationSuggestions:suggestions.filter(x=>x.dimension==="horizontal"),
      evidenceGaps:suggestions.filter(x=>x.confidence==="unknown").map(x=>({itemId:x.itemId,reason:x.reasoning}))
    });
    for(const suggestion of suggestions) await this.appendFilterDecision({
      filterCaseId,decisionType:suggestion.dimension==="horizontal"?"relate":"locate",actor:"system",
      before:{itemId:suggestion.itemId},after:{kind:suggestion.kind,targetNodeId:suggestion.targetNodeId||null,score:suggestion.score},
      rationale:suggestion.reasoning,evidenceIds:[suggestion.evidence?.sourceId,suggestion.evidence?.referenceId].filter(Boolean)
    });
    return {filterCase:updated,suggestions,summary:{
      lineage:suggestions.filter(x=>x.dimension==="lineage").length,
      time:suggestions.filter(x=>x.dimension==="time").length,
      space:suggestions.filter(x=>x.dimension==="space").length,
      horizontal:suggestions.filter(x=>x.dimension==="horizontal").length,
      unplaced:suggestions.filter(x=>x.kind==="unplaced").length
    }};
  },
  async createFilterSuggestionProposal(filterCaseId,suggestionIndex) {
    const filterCase=await this.getFilterCase(filterCaseId);
    const suggestion=filterCase?.locationSuggestions?.[Number(suggestionIndex)];
    if(!suggestion) throw new Error("找不到这条定位建议。");
    const item=await this.getExtractionItem(suggestion.itemId);
    if(!item) throw new Error("提取候选已不存在。");
    const graph=await this.loadGraph(),nodes=graph?.nodes||[];
    const target=nodes.find(n=>String(n.id)===String(suggestion.targetNodeId));
    const evidenceSourceIds=item.sourceId?[item.sourceId]:[];
    if(suggestion.kind==="related_concept") throw new Error("横向关系需要两个已存在的正式知识节点。请先审核并建立候选节点，再创建关系提案。");
    if(suggestion.kind==="parent_candidate"&&target) {
      return this.createProposal({
        proposalType:"create",targetNodeId:null,
        proposedSnapshot:{id:"node_"+makeRecordId("candidate"),name:item.title||"待命名知识点",
          desc:item.content||item.excerpt||"",parentId:target.id,level:(Number(target.level)||1)+1,
          date:item.knowledgeTime||"未标注",needsReview:true,originType:"extraction_candidate"},
        reasoning:suggestion.reasoning+" "+suggestion.uncertainty,
        evidenceSourceIds,filterCaseId,extractionItemId:item.id,evidence:suggestion.evidence
      });
    }
    throw new Error("该建议暂不支持直接生成审核提案；请先补充定位信息。");
  },
  async applyFilterCaseProposal(proposalId,decision,reviewerNote="") {
    const proposal=await this.listProposals("pending").then(rows=>rows.find(x=>x.id===proposalId));
    if(!proposal) throw new Error("找不到待审核的过滤提案。");
    const result=await this.applyProposal(proposalId,decision,reviewerNote);
    if(proposal.filterCaseId) {
      const fc=await this.getFilterCase(proposal.filterCaseId);
      if(fc) await this.appendFilterDecision({filterCaseId:fc.id,decisionType:decision==="accept"?"accept":"reject",actor:"user",
        before:{proposalId,extractionItemId:proposal.extractionItemId||null},
        after:{decision,proposalType:proposal.proposalType},
        rationale:reviewerNote||(decision==="accept"?"用户确认过滤提案。":"用户拒绝该过滤提案。"),
        evidenceIds:proposal.evidenceSourceIds||[]});
    }
    if(decision!=="accept") return result;
    const graph=await this.loadGraph();
    if(proposal.proposalType==="create") {
      const nodeId=proposal.proposedSnapshot?.id||proposal.targetNodeId;
      for(const sourceId of proposal.evidenceSourceIds||[]) {
        if(sourceId&&nodeId) await this.linkNodeSource({nodeId,sourceId,evidenceLocator:proposal.evidence?.locator||null,
          excerpt:proposal.evidence?.excerpt||"",relation:"origin"});
      }
      if(proposal.filterCaseId&&proposal.extractionItemId) {
        await this.appendFilterDecision({filterCaseId:proposal.filterCaseId,decisionType:"locate",actor:"user",
          before:{itemId:proposal.extractionItemId,proposalId},after:{action:"placed",nodeId},
          rationale:reviewerNote||"用户确认候选知识点的框架位置。",evidenceIds:proposal.evidenceSourceIds||[]});
      }
    }
    return {...result,graph};
  }
});

Object.assign(NEBULA_LOCAL,{
  async createKnowledgeRelationProposal(sourceNodeId,targetNodeId,record={}) {
    const graph=await this.loadGraph(),nodes=graph?.nodes||[];
    const source=nodes.find(n=>String(n.id)===String(sourceNodeId));
    const target=nodes.find(n=>String(n.id)===String(targetNodeId));
    if(!source||!target||String(source.id)===String(target.id)) throw new Error("横向关系必须连接两个不同的正式知识节点。");
    const evidenceSourceIds=[...new Set((record.evidenceSourceIds||[]).map(String))];
    for(const id of evidenceSourceIds) if(!(await this.getSource(id))) throw new Error("关系证据来源不存在："+id);
    return this.createProposal({
      proposalType:"relation",sourceNodeId:source.id,relatedNodeId:target.id,
      proposedSnapshot:{type:record.type||"related",label:record.label||"待确认的横向关联"},
      reasoning:String(record.reasoning||"用户发起的关系审核提案。"),
      evidenceSourceIds,evidence:record.evidence||null
    });
  },
  async applyKnowledgeRelationProposal(proposalId,decision,reviewerNote="") {
    const proposal=(await this.listProposals("pending")).find(x=>String(x.id)===String(proposalId));
    if(!proposal||proposal.proposalType!=="relation") throw new Error("找不到待审核的关系提案。");
    const result=await this.applyProposal(proposalId,decision,reviewerNote);
    if(decision!=="accept") return result;
    const relations=await this.listKnowledgeRelations(proposal.sourceNodeId);
    const relation=relations.filter(x=>String(x.targetNodeId)===String(proposal.relatedNodeId)).sort((a,b)=>b.createdAt-a.createdAt)[0];
    if(relation) for(const sourceId of proposal.evidenceSourceIds||[]) {
      await this.createRelationEvidence({
        relationId:relation.id,sourceId,excerpt:proposal.evidence?.excerpt||"",
        locator:proposal.evidence?.locator||null,reviewStatus:"confirmed",
        rationale:reviewerNote||proposal.reasoning
      });
    }
    return {...result,relation:relation||null};
  }
});

Object.assign(NEBULA_LOCAL,{
  async recordFilterItemDisposition(filterCaseId,itemId,action,rationale="") {
    const filterCase=await this.getFilterCase(filterCaseId);
    if(!filterCase) throw new Error("找不到过滤任务。");
    if(!(filterCase.inputItemIds||[]).includes(itemId)) throw new Error("该候选不属于当前过滤任务。");
    if(!["keep_unplaced","reject_candidate","defer"].includes(action)) throw new Error("候选处理决定无效。");
    return this.appendFilterDecision({
      filterCaseId,decisionType:action==="reject_candidate"?"reject":"locate",actor:"user",
      before:{itemId},after:{action},rationale:String(rationale||"用户记录候选处理决定。"),
      evidenceIds:[(await this.getExtractionItem(itemId))?.sourceId].filter(Boolean)
    });
  },
  async finalizeFilterCase(filterCaseId) {
    const filterCase=await this.getFilterCase(filterCaseId);
    if(!filterCase) throw new Error("找不到过滤任务。");
    if(filterCase.status!=="needs_review") throw new Error("过滤任务必须处于待审核状态才能完成归位。");
    const [decisions,proposals]=await Promise.all([this.listFilterDecisions(filterCaseId),this.listProposals("pending")]);
    const pending=proposals.filter(p=>p.filterCaseId===filterCaseId);
    if(pending.length) throw new Error("仍有 "+pending.length+" 条审核提案未处理。");
    const unresolved=[];
    for(const itemId of filterCase.inputItemIds||[]) {
      const latest=decisions.filter(d=>d.actor==="user"&&d.before?.itemId===itemId&&
        ["locate","reject"].includes(d.decisionType)).sort((a,b)=>b.createdAt-a.createdAt)[0];
      if(!latest||!["placed","keep_unplaced","reject_candidate"].includes(latest.after?.action)) unresolved.push(itemId);
    }
    if(unresolved.length) throw new Error("仍有 "+unresolved.length+" 个候选未作出最终处理决定。");
    const rejected=(filterCase.inputItemIds||[]).every(itemId=>{
      const latest=decisions.filter(d=>d.actor==="user"&&d.before?.itemId===itemId&&["locate","reject"].includes(d.decisionType)).sort((a,b)=>b.createdAt-a.createdAt)[0];
      return latest?.after?.action==="reject_candidate";
    });
    const status=rejected?"rejected":"approved";
    const updated=await this.updateFilterCase(filterCaseId,{status,currentStage:"completed",completedAt:Date.now(),completionSummary:{
      total:(filterCase.inputItemIds||[]).length,unplaced:decisions.filter(d=>d.actor==="user"&&d.after?.action==="keep_unplaced").length,
      rejected:decisions.filter(d=>d.actor==="user"&&d.after?.action==="reject_candidate").length
    }});
    await this.appendFilterDecision({filterCaseId,decisionType:status==="approved"?"accept":"reject",actor:"user",
      before:{status:"needs_review"},after:{status},rationale:"所有提取候选均已逐项处理，过滤案件完成。",evidenceIds:[]});
    return updated;
  }
});
