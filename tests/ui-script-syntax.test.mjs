import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const html = await readFile(new URL("../ui-preview-v1.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/type\s*=\s*["']importmap["']/i.test(attributes) && body.trim());
assert.ok(scripts.length >= 4, "Expected the preview page's inline JavaScript modules and scripts.");

for (const [index, [, attributes, source]] of scripts.entries()) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8"
  });
  assert.equal(result.status, 0,
    "Inline script " + (index + 1) + " (" + attributes + ") has a syntax error:\n" + result.stderr);
}
console.log("Checked " + scripts.length + " inline scripts in ui-preview-v1.html.");
