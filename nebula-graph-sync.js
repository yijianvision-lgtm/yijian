const NODE_PREFIX = "graph-node:";
const LINK_PREFIX = "graph-link:";
const RECORD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function encodeId(value) {
  if (value === null || value === undefined || String(value).length === 0) throw new TypeError("A graph element ID is required.");
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return encoded;
}
function decodeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid encoded graph element ID.");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function assertRecordId(value) {
  if (value.length > 128 || !RECORD_ID_PATTERN.test(value)) throw new RangeError("Graph element ID exceeds the sync record ID limit.");
  return value;
}
export function createNebulaGraphNodeRecordId(nodeId) {
  return assertRecordId(NODE_PREFIX + encodeId(nodeId));
}
export function createNebulaGraphLinkRecordId(sourceId, targetId) {
  return assertRecordId(LINK_PREFIX + encodeId(sourceId) + ":" + encodeId(targetId));
}
export function parseNebulaGraphRecordId(recordId) {
  if (typeof recordId !== "string") return null;
  if (recordId.startsWith(NODE_PREFIX)) return Object.freeze({ kind: "node", nodeId: decodeId(recordId.slice(NODE_PREFIX.length)) });
  if (recordId.startsWith(LINK_PREFIX)) {
    const pair = recordId.slice(LINK_PREFIX.length).split(":");
    if (pair.length !== 2) throw new TypeError("Invalid graph link record ID.");
    return Object.freeze({ kind: "link", sourceId: decodeId(pair[0]), targetId: decodeId(pair[1]) });
  }
  return null;
}
export function getNebulaGraphLinkEndpoints(link) {
  if (Array.isArray(link) && link.length === 2) return [String(link[0]), String(link[1])];
  if (!link || typeof link !== "object") throw new TypeError("Unsupported graph link shape; refusing a partial deletion.");
  const source = link.source ?? link.from ?? link.sourceNodeId;
  const target = link.target ?? link.to ?? link.targetNodeId;
  if (source === undefined || target === undefined) throw new TypeError("Graph link endpoints are required for safe deletion.");
  return [String(source), String(target)];
}
export function buildNebulaGraphNodeDeleteOperations(graph, nodeId) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new TypeError("A valid local graph is required.");
  const id = String(nodeId);
  if (!graph.nodes.some(node => String(node?.id) === id)) throw new Error("The target graph node does not exist.");
  const linked = new Set();
  for (const link of graph.links) {
    const [source, target] = getNebulaGraphLinkEndpoints(link);
    if (source === id || target === id) linked.add(createNebulaGraphLinkRecordId(source, target));
  }
  const operations = [...linked].map(recordId => Object.freeze({ category: "graph", recordId, kind: "delete" }));
  operations.push(Object.freeze({ category: "graph", recordId: createNebulaGraphNodeRecordId(id), kind: "delete" }));
  return Object.freeze(operations);
}
export function buildNebulaGraphLinkDeleteOperation(sourceId, targetId) {
  return Object.freeze({ category: "graph", recordId: createNebulaGraphLinkRecordId(sourceId, targetId), kind: "delete" });
}
