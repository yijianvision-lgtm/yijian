import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const html = await readFile(new URL("../ui-preview-v3-a-cosmos.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/type\s*=\s*["']importmap["']/i.test(attributes) && body.trim());
assert.ok(scripts.length >= 4, "Expected the V3-A preview page's inline JavaScript modules and scripts.");
assert.ok(html.includes("from './nebula-local.js?env=preview';"), "V3-A must load its isolated preview data environment.");
assert.ok(!html.includes("from './nebula-local.js';"), "V3-A must not import the production local database module.");
assert.ok(html.includes("from './nebula-local.js?env=preview';"), "V3-A must load its isolated preview data environment.");
assert.ok(html.includes("import('./nebula-local.js?env=source')"), "Preview snapshot import must read the production DB through the non-migrating source module.");
assert.ok(html.includes("restoreFullBackup(raw,{mode:'merge'})"), "Preview snapshot import must merge into the isolated preview DB without replacing existing preview data.");
assert.ok(html.includes("localGraphNodes[selected]?.id??window.__guanfuSelectedNodeId??null"), "The archive must resolve the selected formal node ID directly, not depend only on a mutable global.");

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
assert.ok(html.includes("document.getElementById('continuumOpenDetail').onclick=openKnowledgeArchive;"), "The core archive button must use the shared archive-opening flow.");
assert.ok(html.includes("document.getElementById('openNodeDetail').onclick=openKnowledgeArchive;"), "The selected-node archive button must use the same archive-opening flow.");
assert.ok(html.includes('class="minimap-quadrant-compass"'), "The four directions must remain represented in the minimap while retracted.");
assert.ok(html.includes('.right-panel .mini-map.quadrants-stowed .minimap-quadrant-compass{opacity:1;'), "The four-direction mini compass must appear when the guide is retracted.");
assert.ok(html.includes("minimapQuadrantReturn?.addEventListener('click',event=>{event.stopPropagation();document.getElementById('continuumFocus')?.classList.add('open');restoreFocusFromMinimap();"), "The minimap control must reopen the quadrant layer and restore the core and four directions on demand.");


assert.ok(html.includes("function retractFocusToMinimap(){"), "Both archive entry points must share one core-and-quadrant retraction action.");
assert.ok(html.includes("#continuumFocus.quadrants-retracting .continuum-core{"), "The central core point must retract with the four-direction guide.");
assert.ok(html.includes("var(--core-minimap-dx,0px)") && html.includes("var(--core-minimap-dy,0px)"), "The core point must travel toward the minimap center rather than merely disappear.");
assert.ok(html.includes("corePoint.style.setProperty('--core-minimap-dx'") && html.includes("corePoint.style.setProperty('--core-minimap-dy'"), "The core-to-minimap movement must use measured on-screen positions.");
assert.ok(html.includes("function openKnowledgeArchive(){"), "Both archive entry points must share a single archive-opening flow.");

assert.ok(html.includes("archive.scrollTop=0;") && html.includes("host.replaceChildren(safeText('p','正在打开知识档案…'));") && html.includes("archive.classList.add('open');") && html.includes("retractFocusToMinimap();") && html.includes("loadKnowledgeArchiveEvidence(nodeId,host);"), "The archive must open immediately while quadrant retraction and evidence loading continue without blocking.");
assert.ok(html.includes("renderContinuum();\n const archive=document.getElementById('nodeDetail');"), "The selected knowledge object's title, definition and structure must be refreshed before its archive opens.");
assert.ok(html.includes(".overlay.open{display:block}#nodeDetail{z-index:60!important}.overlay-head{"), "The knowledge archive must stack above the full-screen #continuumFocus layer (z-index 40).");
const archiveZIndex = Number(html.match(/#nodeDetail\{z-index:(\d+)!important\}/)?.[1] || 0);
const focusZIndexes = [...html.matchAll(/#continuumFocus\{[^}]*?z-index:(\d+)!important/g)].map(match => Number(match[1]));
assert.ok(archiveZIndex > Math.max(0, ...focusZIndexes), "The archive must have a higher stacking level than every full-screen exploration layer.");
assert.ok(!html.includes(".#nodeDetail{z-index:40}"), "The archive z-index rule must not be prefixed with an invalid class selector.");
assert.ok(html.includes(".overlay-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}"), "The archive header class must have a valid class selector.");
assert.ok(html.includes("document.querySelectorAll('.overlay.open').forEach(panel=>{if(panel!==archive)panel.classList.remove('open')});"), "Opening the archive must close any previously open overlay so it cannot cover the archive.");
assert.ok(html.includes("const ids=['dashboard','hierarchy','sources','lab','learning','review','filter-workbench','backup','globalSearch','overview','nodeDetail'];"), "The shared close action must include the knowledge archive so its Return button and Escape key both work.");
assert.ok(html.includes("host.replaceChildren(safeText('p','正在读取关联来源…'));"), "The archive must show a visible loading state while original sources are resolved.");
assert.ok(html.includes("corePoint.addEventListener('transitionend',onTransitionEnd);"), "The core-to-minimap transition must remain event-driven.");
assert.ok(html.includes("function closeKnowledgeArchive(){") && html.includes("if(b.closest('#nodeDetail'))closeKnowledgeArchive();else closeAll();"), "The archive Return button must close only the archive and preserve the collapsed universe state.");
assert.ok(html.includes("document.getElementById('continuumFocus')?.classList.remove('open');"), "Returning from the archive must reveal the 3D universe instead of leaving an empty full-screen quadrant layer.");
assert.ok(html.includes("#nodeDetail.open{animation:mindArchiveEnter .24s"), "The knowledge archive must appear with a short, non-blocking entrance animation.");
assert.ok(html.includes("document.getElementById('continuumFocus')?.classList.add('open');restoreFocusFromMinimap();"), "The minimap must reopen the quadrant layer before restoring the four directions.");
assert.ok(!html.includes("document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('open'))));"), "A duplicate global close listener must not race with the archive-specific return flow.");
assert.ok(html.includes("if(!closeKnowledgeArchive())closeAll();"), "Escape must close the archive first without closing or resetting the underlying universe.");
assert.ok(html.includes("loadKnowledgeArchiveEvidence(nodeId,host);"), "Evidence loading must be separated from the archive's immediate opening transition.");


const animateStart = html.indexOf("function animate(){");
const animateEnd = html.indexOf("animate();", animateStart);
assert.ok(animateStart >= 0 && animateEnd > animateStart, "Expected to locate the main 3D animation loop.");
const animateBody = html.slice(animateStart, animateEnd);
assert.ok(!animateBody.includes("drawMini()"), "The 2D minimap must not be redrawn on every WebGL animation frame.");
assert.ok(html.includes("innerWidth<760?1.2:1.5"), "The WebGL pixel ratio must be capped to reduce high-DPI rendering cost.");
assert.ok(animateBody.includes("camera.position.lerp(desired,.065)") && animateBody.includes("controls.target.lerp(targetWorld,.065)"), "Camera follow must respond smoothly without the previous sluggish easing.");
assert.ok(html.includes(".overlay.open{animation:mindViewEnter .42s") && html.includes("#nodeDetail.open{animation:mindArchiveEnter .24s"), "Main views and the knowledge archive must enter with a spatial transition.");
assert.ok(html.includes("#continuumFocus.open{animation:nebulaFocusIn .72s"), "The four-direction focus view must use a shorter, consistent entrance transition.");
assert.ok(html.includes("@media(prefers-reduced-motion:reduce)") && html.includes(".overlay.open,#nodeDetail.open,#continuumFocus.open,.layer-page.open{animation:none!important}"), "All added view transitions must respect reduced-motion preferences.");

console.log("Checked " + scripts.length + " inline scripts and V3-A exploration contracts.");

assert.ok(html.includes("document.getElementById('search').addEventListener('click',()=>open('globalSearch'))"), "Global search should open only after an explicit click, not merely when the page or input receives focus.");
assert.ok(!html.includes("document.getElementById('search').addEventListener('focus',()=>open('globalSearch'))"), "Global search must not auto-open on focus during page entry.");
