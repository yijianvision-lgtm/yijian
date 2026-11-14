/**
 * Apply a server-selected remote records version to NEBULA's local schema.
 * Only the graph category is mapped today; unknown categories fail closed.
 */
export function createNebulaLocalRecordApplier({ local } = {}) {
  if (!local || typeof local.saveGraph !== "function") throw new TypeError("A NEBULA_LOCAL graph writer is required.");
  return async function applyRemote({ category, payload, deleted } = {}) {
    if (category !== "graph") throw new Error("No reviewed local mapping exists for this sync category.");
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
