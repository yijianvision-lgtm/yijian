import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const [shared, isolated, local] = await Promise.all([
  read("wrangler.toml"),
  read("wrangler.test.example.toml"),
  read("wrangler.local.example.toml")
]);

// Scheduled destructive cleanup must never be enabled by the shared/default
// Worker config. Only the explicitly isolated test config may carry a Cron.
assert.doesNotMatch(shared, /^\s*\[triggers\]\s*$/m,
  "Shared/default Worker config must not enable scheduled cleanup.");
assert.doesNotMatch(shared, /^\s*crons\s*=/m,
  "Shared/default Worker config must not contain Cron triggers.");

assert.match(isolated, /^name\s*=\s*"nebula-private-test"$/m);
assert.match(isolated, /^\s*\[triggers\]\s*$/m);
assert.match(isolated, /^crons\s*=\s*\["\*\/15 \* \* \* \*"\]$/m);
assert.match(isolated, /REPLACE_WITH_TEST_D1_DATABASE_ID/);
assert.match(isolated, /REPLACE_WITH_UNIQUE_TEST_R2_BUCKET_NAME/);

// Local Miniflare tests are invoked explicitly by CI and do not need a Cron.
assert.match(local, /^name\s*=\s*"nebula-private-local"$/m);
assert.doesNotMatch(local, /^\s*\[triggers\]\s*$/m);
assert.doesNotMatch(local, /^\s*crons\s*=/m);

console.log("NEBULA Wrangler environment isolation checks passed.");
