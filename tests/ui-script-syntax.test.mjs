import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const html = await readFile(new URL("../ui-preview-v3-a-cosmos.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/type\s*=\s*["']importmap["']/i.test(attributes) && body.trim());
assert.ok(scripts.length >= 4, "Expected the V3-A preview page's inline JavaScript modules and scripts.");

for (const [index, [, attributes, source]] of scripts.entries()) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8"
  });
  assert.equal(result.status, 0,
    "Inline script " + (index + 1) + " (" + attributes + ") has a syntax error:\n" + result.stderr);
}

assert.ok(!html.includes('targets(["precedes","influences"]'), "Influence relations must not be inferred as temporal order.");
assert.ok(html.includes("根节点分支"), "Returning to the root must support a new exploration branch.");
assert.ok(html.includes("focusExplorationTrail[focusCursor]={pathId:activeExplorationPathId"), "The root history cursor must be bound to its persisted exploration path.");
assert.ok(html.includes("snapshot.steps[snapshot.steps.length-1]"), "Path-tail lookup must not depend on Array.prototype.at.");
assert.ok(html.includes("quadrants-retracting"), "Entering a directional knowledge branch must retract the four-direction controls.");
assert.ok(html.includes("classList.remove('quadrants-retracting')"), "Closing the choice panel or entering a new core must restore directional controls.");

console.log("Checked " + scripts.length + " inline scripts and V3-A exploration contracts.");
