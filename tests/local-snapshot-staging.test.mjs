import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";

globalThis.crypto ||= webcrypto;
globalThis.window = { dispatchEvent() {} };
await import("../nebula-local.js?env=source");

const local = globalThis.NEBULA_LOCAL;
const original = {
  nodes: [{ id: "old-root", title: "Existing private graph" }],
  links: []
};
await local.saveGraph(original.nodes, original.links);
const firstPage = {
  nodes: [{ id: "new-root", title: "New root" }],
  links: []
};
const secondPage = {
  nodes: [{ id: "new-child", title: "New child" }],
  links: [{ source: "new-root", target: "new-child", relation: "supports" }]
};
const complete = {
  nodes: [...firstPage.nodes, ...secondPage.nodes],
  links: [...firstPage.links, ...secondPage.links]
};
const manifest = await local.getGraphSnapshotChecksum(complete.nodes, complete.links);

// 1. Normal path: sequential staging, idempotent replay, checksum validation,
// one atomic graph replacement, and removal of staging artifacts.
await local.beginGraphSnapshot({
  snapshotId: "snapshot-normal",
  expectedChunks: 2,
  expectedChecksum: manifest,
  now: 1000
});
assert.deepEqual(await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-normal", index: 0, ...firstPage, now: 1100
}), { staged: true, replayed: false, stagedChunks: 1 });
assert.deepEqual(await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-normal", index: 0, ...firstPage, now: 1200
}), { staged: false, replayed: true, stagedChunks: 1 },
"Replaying the exact same page must be idempotent.");
await assert.rejects(local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-normal", index: 2, ...secondPage, now: 1300
}), /rejected|aborted/i, "A client cannot skip a snapshot page.");
await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-normal", index: 1, ...secondPage, now: 1400
});
const committed = await local.commitGraphSnapshot({ snapshotId: "snapshot-normal", now: 1500 });
assert.equal(committed.committed, true);
assert.equal(committed.nodeCount, 2);
assert.equal(committed.linkCount, 1);
assert.deepEqual((await local.loadGraph()).nodes, complete.nodes);
assert.deepEqual((await local.loadGraph()).links, complete.links);
assert.deepEqual(await local.recoverGraphSnapshots({ now: 1600 }), { pending: [], cleaned: 0 },
  "Successful commit must remove session and page staging rows.");

// 2. Interrupted transfer: after only one of two pages, commit must fail
// closed and the previous live graph must remain byte-for-byte equivalent.
const stableBeforeInterrupt = await local.loadGraph();
const partialManifest = await local.getGraphSnapshotChecksum(complete.nodes, complete.links);
await local.beginGraphSnapshot({
  snapshotId: "snapshot-interrupted",
  expectedChunks: 2,
  expectedChecksum: partialManifest,
  now: 2000
});
await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-interrupted", index: 0, ...firstPage, now: 2100
});
await assert.rejects(local.commitGraphSnapshot({
  snapshotId: "snapshot-interrupted", now: 2200
}), /incomplete/i);
assert.deepEqual(await local.loadGraph(), stableBeforeInterrupt,
  "An incomplete page transfer must never modify the live graph.");
const recovery = await local.recoverGraphSnapshots({ now: 2300 });
assert.deepEqual(recovery.pending, [{
  snapshotId: "snapshot-interrupted",
  stagedChunks: 1,
  expectedChunks: 2,
  createdAt: 2000,
  expiresAt: 86402000,
  status: "staging"
}], "Recovery must report a resumable, non-expired staging session.");
await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-interrupted", index: 1, ...secondPage, now: 2400
});
await local.commitGraphSnapshot({ snapshotId: "snapshot-interrupted", now: 2500 });
assert.deepEqual(await local.loadGraph(), complete,
  "A resumed transfer may commit only after all pages pass integrity validation.");

// 3. Invalid manifest: data remains staged for diagnosis/retry, but live graph
// is unchanged. Explicit abort then removes all state for that failed session.
const stableBeforeInvalid = await local.loadGraph();
await local.beginGraphSnapshot({
  snapshotId: "snapshot-invalid",
  expectedChunks: 1,
  expectedChecksum: "0".repeat(64),
  now: 3000
});
await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-invalid", index: 0, ...firstPage, now: 3100
});
await assert.rejects(local.commitGraphSnapshot({
  snapshotId: "snapshot-invalid", now: 3200
}), /manifest checksum mismatch/i);
assert.deepEqual(await local.loadGraph(), stableBeforeInvalid,
  "A failed integrity check must not replace the live graph.");
assert.deepEqual(await local.abortGraphSnapshot("snapshot-invalid"),
  { aborted: true, snapshotId: "snapshot-invalid" });
assert.deepEqual(await local.abortGraphSnapshot("snapshot-invalid"),
  { aborted: false, snapshotId: "snapshot-invalid" },
  "Abort is idempotent when the staging session is already gone.");

// 4. Expired sessions are cleaned during recovery; this does not touch the graph.
await local.beginGraphSnapshot({
  snapshotId: "snapshot-expired",
  expectedChunks: 1,
  expectedChecksum: manifest,
  now: 4000,
  ttlMs: 1000
});
await local.stageGraphSnapshotChunk({
  snapshotId: "snapshot-expired", index: 0, ...firstPage, now: 4100
});
const beforeExpiryCleanup = await local.loadGraph();
const cleanup = await local.recoverGraphSnapshots({ now: 6000 });
assert.equal(cleanup.cleaned, 1);
assert.deepEqual(cleanup.pending, []);
assert.deepEqual(await local.loadGraph(), beforeExpiryCleanup,
  "Expired staging cleanup must not mutate live graph data.");
await assert.rejects(local.commitGraphSnapshot({
  snapshotId: "snapshot-expired", now: 6000
}), /missing|not staging/i);

console.log("NEBULA IndexedDB atomic graph snapshot staging tests passed.");
