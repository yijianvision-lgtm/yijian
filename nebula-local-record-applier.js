import { parseNebulaGraphRecordId, getNebulaGraphLinkEndpoints } from "./nebula-graph-sync.js";

/**
 * Apply a server-selected remote graph version. Full snapshots remain supported;
 * stable per-node/per-link record IDs apply only the selected graph element.
 */
export function createNebulaLocalRecordApplier({ local } = {}) {
  if (!local || typeof local.saveGraph !== "function") throw new TypeError("A NEBULA_LOCAL graph writer is required.");
  async function readGraph() {
    if (typeof local.loadGraph !== "function") throw new Error("A local graph reader is required for granular graph sync.");
    const graph = await local.loadGraph();
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      throw new TypeError("The local graph does not match the reviewed graph schema.");
    }
    return graph;
  }
  return async function applyRemote({ category, recordId, payload, deleted } = {}) {
    if (category !== "graph") throw new Error("No reviewed local mapping exists for this sync category.");
    const element = parseNebulaGraphRecordId(recordId);
    if (element) {
      const graph = await readGraph();
      if (element.kind === "node") {
        if (deleted === true) {
          const nodes = graph.nodes.filter(node => String(node?.id) !== element.nodeId);
          const links = graph.links.filter(link => {
            const [source, target] = getNebulaGraphLinkEndpoints(link);
            return source !== element.nodeId && target !== element.nodeId;
          });
          await local.saveGraph(nodes, links);
          return { applied: true, deleted: true, element: "node", removedLinks: graph.links.length - links.length };
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || String(payload.id) !== element.nodeId) {
          throw new TypeError("The remote node payload does not match its stable record ID.");
        }
        const nodes = [...graph.nodes];
        const index = nodes.findIndex(node => String(node?.id) === element.nodeId);
        if (index < 0) nodes.push(payload); else nodes[index] = payload;
        await local.saveGraph(nodes, graph.links);
        return { applied: true, deleted: false, element: "node" };
      }
      const matches = link => {
        const [source, target] = getNebulaGraphLinkEndpoints(link);
        return source === element.sourceId && target === element.targetId;
      };
      if (deleted === true) {
        const links = graph.links.filter(link => !matches(link));
        await local.saveGraph(graph.nodes, links);
        return { applied: true, deleted: true, element: "link", removedLinks: graph.links.length - links.length };
      }
      if (!payload || typeof payload !== "object") throw new TypeError("The remote link payload is invalid.");
      const [source, target] = getNebulaGraphLinkEndpoints(payload);
      if (source !== element.sourceId || target !== element.targetId) throw new TypeError("The remote link payload does not match its stable record ID.");
      const links = [...graph.links];
      const index = links.findIndex(matches);
      if (index < 0) links.push(payload); else links[index] = payload;
      await local.saveGraph(graph.nodes, links);
      return { applied: true, deleted: false, element: "link" };
    }
    if (deleted === true) {
      await local.saveGraph([], []);
      return { applied: true, deleted: true };
    }
    if (!payload || typeof payload !== "object" ||
        !Array.isArray(payload.nodes) || !Array.isArray(payload.links)) {
      throw new TypeError("The remote graph snapshot does not match the local graph schema.");
    }
    await local.saveGraph(payload.nodes, payload.links);
    return { applied: true, deleted: false };
  };
}
