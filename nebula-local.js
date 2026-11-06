/* NEBULA local-first data layer.
 * All knowledge, source files and extracted text stay in this browser's IndexedDB.
 * No login, cloud database, account service or remote file storage.
 */
const DB_NAME = "nebula_local_v2";
const DB_VERSION = 4;
const STORES = ["graph", "references", "lectureSources", "aiConversations", "assets", "meta", "history", "sources", "nodeSourceLinks", "knowledgeVersions", "reviewProposals", "learningRecords", "researchSessions", "knowledgeRelations"];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) {
        if (["references","lectureSources","aiConversations","assets","history","sources","nodeSourceLinks","knowledgeVersions","reviewProposals","learningRecords","researchSessions","knowledgeRelations"].includes(name)) db.createObjectStore(name, { keyPath: "id" });
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
    tx.oncomplete=()=>resolve(values.result.map((value,i)=>({key:keys.result[i],value})));
    tx.onerror=()=>reject(tx.error);
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
async function backupPayload() {
  const stores={};
  for(const name of STORES) {
    const entries=await getAllEntries(name), rows=[];
    for(const entry of entries) {
      if(name==="meta" && entry.key==="lectureFolder") continue;
      rows.push({key:await encodeBackupValue(entry.key),value:await encodeBackupValue(entry.value)});
    }
    stores[name]=rows;
  }
  return {format:"NEBULA_FULL_BACKUP",schemaVersion:3,exportedAt:nowISO(),stores,
    manifest:Object.fromEntries(Object.entries(stores).map(([k,v])=>[k,{records:v.length}])),
    notes:["原始讲义与 AI 对话分别备份。","本地文件夹授权句柄不会导出，恢复后需重新授权。"]};
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
  if(!parsed||parsed.format!=="NEBULA_FULL_BACKUP"||!parsed.stores||typeof parsed.stores!=="object") throw new Error("这不是有效的 NEBULA 完整备份文件。");
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
  const mode=options.mode||"replace";
  if(!["replace","merge"].includes(mode)) throw new Error("恢复模式只能是 replace 或 merge。");
  const db=await openDB();
  const storeNames=Object.keys(parsed.stores).filter(n=>STORES.includes(n));
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeNames,"readwrite");
    for(const name of storeNames) {
      const store=tx.objectStore(name);
      if(mode==="replace") store.clear();
      for(const row of parsed.stores[name]) {
        const key=decodeBackupValue(row.key), value=decodeBackupValue(row.value);
        if(name==="meta" && key==="lectureFolder") continue;
        if(store.keyPath) store.put(value);
        else store.put(value,key);
      }
    }
    tx.oncomplete=()=>resolve({mode,restoredStores:storeNames,manifest:Object.fromEntries(Object.entries(parsed.stores).map(([k,v])=>[k,v.length]))});
    tx.onerror=()=>reject(tx.error||new Error("恢复失败，原数据库事务已回滚。"));
    tx.onabort=()=>reject(tx.error||new Error("恢复已中止，原数据库事务已回滚。"));
  });
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
  let resultingNodeId=proposal.targetNodeId||snapshot.id||makeRecordId("node");
  if(proposal.proposalType==="create") {
    if(nodes.some(n=>String(n.id)===String(resultingNodeId))) throw new Error("目标节点 ID 已存在，未应用建议。");
    nodes.push({...snapshot,id:resultingNodeId});
  } else if(proposal.proposalType==="update"||proposal.proposalType==="reparent") {
    if(!before) throw new Error("找不到目标节点，未应用建议。");
    const version={id:makeRecordId("version"),nodeId:before.id,versionNumber:(await getAllEntries("knowledgeVersions")).filter(x=>x.value.nodeId===before.id).length+1,contentSnapshot:cloneJSON(before),changeReason:proposal.reasoning||"审核通过的 AI 建议",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:before.currentVersionId||null};
    await putRecord("knowledgeVersions",version);
    const index=nodes.findIndex(n=>String(n.id)===String(before.id));
    nodes[index]={...before,...snapshot,id:before.id,currentVersionId:version.id,updatedAt:Date.now()};
    const afterVersion={id:makeRecordId("version"),nodeId:before.id,versionNumber:version.versionNumber+1,contentSnapshot:cloneJSON(nodes[index]),changeReason:"审核通过后的新版本",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now(),createdBy:"user-approved-ai",supersedesVersionId:version.id};
    await putRecord("knowledgeVersions",afterVersion);nodes[index].currentVersionId=afterVersion.id;
  } else if(proposal.proposalType==="relation") {
    const relation={id:makeRecordId("relation"),sourceNodeId:proposal.sourceNodeId||proposal.targetNodeId,targetNodeId:proposal.relatedNodeId||snapshot.targetNodeId,type:snapshot.type||"related",label:snapshot.label||"",rationale:proposal.reasoning||"",evidenceSourceIds:proposal.evidenceSourceIds||[],createdAt:Date.now()};
    if(!relation.sourceNodeId||!relation.targetNodeId||relation.sourceNodeId===relation.targetNodeId) throw new Error("关系两端节点无效，未应用建议。");
    await putRecord("knowledgeRelations",relation).catch(async()=>{throw new Error("关系记录写入失败。");});
  } else {
    throw new Error("合并/拆分需要明确的节点映射与来源迁移，当前版本暂不自动执行；建议仍保持待审核状态。");
  }
  await NEBULA_LOCAL.saveGraph(nodes,links);
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
    const exists=(await request("nodeSourceLinks","readonly",s=>s.getAll())).find(x=>x.nodeId===record.nodeId&&x.sourceId===record.sourceId&&x.evidenceLocator===record.evidenceLocator);
    if(exists)return exists;
    return putRecord("nodeSourceLinks",{...record,id:makeRecordId("evidence"),linkedAt:Date.now()});
  },
  async unlinkNodeSource(id){return deleteRecord("nodeSourceLinks",id);},
  async listNodeSources(nodeId){return (await request("nodeSourceLinks","readonly",s=>s.getAll())).filter(x=>x.nodeId===nodeId);},
  async listSourceNodes(sourceId){return (await request("nodeSourceLinks","readonly",s=>s.getAll())).filter(x=>x.sourceId===sourceId);},
  async createProposal(record){return createKnowledgeProposal(record);},
  async listProposals(status){const rows=await request("reviewProposals","readonly",s=>s.getAll());return rows.filter(x=>!status||x.status===status).sort((a,b)=>b.createdAt-a.createdAt);},
  async applyProposal(id,decision,reviewerNote){return applyKnowledgeProposal(id,decision,reviewerNote);},
  async listNodeVersions(nodeId){return (await request("knowledgeVersions","readonly",s=>s.getAll())).filter(x=>x.nodeId===nodeId).sort((a,b)=>a.versionNumber-b.versionNumber);},
  async saveLearningRecord(record){
    if(!record?.nodeId||!record?.activityType)throw new Error("学习记录缺少节点或活动类型。");
    return putRecord("learningRecords",{...record,id:record.id||makeRecordId("learn"),createdAt:record.createdAt||Date.now()});
  },
  async listLearningRecords(nodeId){const rows=await request("learningRecords","readonly",s=>s.getAll());return rows.filter(x=>!nodeId||x.nodeId===nodeId).sort((a,b)=>b.createdAt-a.createdAt);},
  async saveResearchSession(record){return putRecord("researchSessions",{...record,id:record.id||makeRecordId("research"),updatedAt:Date.now(),createdAt:record.createdAt||Date.now()});},
  async listResearchSessions(){return (await request("researchSessions","readonly",s=>s.getAll())).sort((a,b)=>b.updatedAt-a.updatedAt);},
  async findDuplicateCandidates(nodes,options){return duplicateCandidates(nodes||[],options||{});},
  async getCognitiveDashboard(){
    const [sources,proposals,learning,research,graph]=await Promise.all([this.listSources(),this.listProposals("pending"),this.listLearningRecords(),this.listResearchSessions(),this.loadGraph()]);
    const nodes=graph?.nodes||[];
    return {nodeCount:nodes.length,sourceCount:sources.length,pendingReviews:proposals.length,learningRecords:learning.length,researchSessions:research.length,needsReviewCount:nodes.filter(n=>n.needsReview||n.status==="needs_review").length,generatedAt:Date.now()};
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
    if(!record?.sourceNodeId||!record?.targetNodeId||record.sourceNodeId===record.targetNodeId)throw new Error("关系两端节点必须有效且不能相同。");
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
  const base=String(endpoint).trim().replace(/\/+$/,"").replace(/\/(analyze|coach|mnemonic|research|share)$/,"");
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
