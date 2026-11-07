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
assert.ok(html.includes("b.onclick=()=>{focusCursor=k;const entry=focusExplorationTrail[k];activeExplorationPathId=entry?.pathId||null;activeExplorationStepId=entry?.stepId||null;selectNode(idx,false)};"), "Clicking a trail breadcrumb must restore its matching persisted path cursor.");

assert.ok(html.includes("quadrants-retracting"), "Entering a directional knowledge branch must retract the four-direction controls.");
assert.ok(html.includes("classList.remove('quadrants-retracting')"), "Closing the choice panel or entering a new core must restore directional controls.");
assert.ok(html.includes('id="minimapQuadrantReturn"'), "The minimap must provide a way to reopen four-direction exploration.");
assert.ok(html.includes(".right-panel .mini-map.quadrants-stowed .minimap-quadrant-return{opacity:1;pointer-events:auto}"), "The minimap return control must be available while the four-direction guide is stowed.");
assert.ok(html.includes("transform:scale(.12)!important;"), "Retracted quadrants must shrink while fading.");
const selectNodeBody = html.match(/function selectNode\(i,append=true\)\{([\s\S]*?)\}const directionPrompts/);
assert.ok(selectNodeBody, "Expected to locate selectNode implementation.");
assert.ok(!selectNodeBody[1].includes("classList.add('quadrants-retracting')"), "Selecting a core node must preserve the four-direction guide; retraction belongs to the explicit knowledge-archive action.");
assert.ok(selectNodeBody[1].includes("restoreFocusFromMinimap()"), "Selecting a new exploration core must restore its four-direction guide and clear the minimap state.");
assert.ok(html.includes("document.getElementById('continuumOpenDetail').onclick=async()=>{\n retractFocusToMinimap();"), "Opening the knowledge archive from the core must retract both the guide and core point into the minimap.");
assert.ok(html.includes("document.getElementById('openNodeDetail').onclick=()=>{retractFocusToMinimap();"), "Opening the selected node archive must retract both the guide and core point into the minimap.");
assert.ok(html.includes('class="minimap-quadrant-compass"'), "The four directions must remain represented in the minimap while retracted.");
assert.ok(html.includes('.right-panel .mini-map.quadrants-stowed .minimap-quadrant-compass{opacity:1;'), "The four-direction mini compass must appear when the guide is retracted.");
assert.ok(html.includes("minimapQuadrantReturn?.addEventListener('click',event=>{event.stopPropagation();restoreFocusFromMinimap();"), "The minimap control must restore the core and four directions on demand.");


assert.ok(html.includes("function retractFocusToMinimap(){"), "Both archive entry points must share one core-and-quadrant retraction action.");
assert.ok(html.includes("#continuumFocus.quadrants-retracting .continuum-core{"), "The central core point must retract with the four-direction guide.");
assert.ok(html.includes("var(--core-minimap-dx,0px)") && html.includes("var(--core-minimap-dy,0px)"), "The core point must travel toward the minimap center rather than merely disappear.");
assert.ok(html.includes("corePoint.style.setProperty('--core-minimap-dx'") && html.includes("corePoint.style.setProperty('--core-minimap-dy'"), "The core-to-minimap movement must use measured on-screen positions.");
assert.ok((html.split("retractFocusToMinimap();").length - 1) === 2, "Both full-archive entry points must use the same retraction action.");
console.log("Checked " + scripts.length + " inline scripts and V3-A exploration contracts.");

assert.ok(html.includes("document.getElementById('search').addEventListener('click',()=>open('globalSearch'))"), "Global search should open only after an explicit click, not merely when the page or input receives focus.");
assert.ok(!html.includes("document.getElementById('search').addEventListener('focus',()=>open('globalSearch'))"), "Global search must not auto-open on focus during page entry.");
