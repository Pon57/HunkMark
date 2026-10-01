"use strict";

const assert = require("node:assert/strict");

// Display metadata is allowed without pinning its values. Unrecognized keys
// must be reviewed here so new permission or execution surfaces fail closed.
const allowedManifestKeys = new Set([
  "manifest_version", "name", "short_name", "version", "version_name",
  "description", "minimum_chrome_version", "icons", "author", "homepage_url",
  "default_locale", "permissions", "content_scripts",
]);
const allowedContentScriptKeys = new Set([
  "matches", "js", "css", "run_at", "world", "all_frames",
  "match_about_blank", "match_origin_as_fallback",
]);

function validateManifestBoundary(manifest) {
  assert.ok(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "Manifest boundary: manifest must be an object",
  );
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedManifestKeys.has(key), `Manifest boundary: unsupported key ${key}`);
  }
  assert.deepEqual(manifest.permissions, ["storage"], "Manifest boundary: only storage permission is allowed");
  assert.ok(
    Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1,
    "Manifest boundary: exactly one content-script definition is required",
  );

  const script = manifest.content_scripts[0];
  assert.ok(
    script && typeof script === "object" && !Array.isArray(script),
    "Manifest boundary: content script must be an object",
  );
  for (const key of Object.keys(script)) {
    assert.ok(allowedContentScriptKeys.has(key), `Manifest boundary: unsupported content-script key ${key}`);
  }
  assert.deepEqual(script.matches, ["https://github.com/*"], "Manifest boundary: content scripts must target GitHub only");
  assert.deepEqual(script.css, ["content.css"], "Manifest boundary: only the packaged content stylesheet is allowed");
  assert.ok(
    Array.isArray(script.js) && script.js.length >= 3,
    "Manifest boundary: content-script modules are required",
  );
  assert.equal(script.js[0], "core.js", "Manifest boundary: core.js must load first");
  assert.equal(script.js.at(-1), "content.js", "Manifest boundary: content.js must load last");
  // Plain filenames exclude traversal, URL escapes, fragments and queries.
  assert.ok(
    script.js.slice(1, -1).every((file) => typeof file === "string" && /^content\/[A-Za-z0-9_-]+\.js$/.test(file)),
    "Manifest boundary: runtime modules must be JavaScript files directly inside content/",
  );
  assert.equal(new Set(script.js).size, script.js.length, "Manifest boundary: scripts must not load more than once");

  const executionDefaults = {
    run_at: "document_idle",
    world: "ISOLATED",
    all_frames: false,
    match_about_blank: false,
    match_origin_as_fallback: false,
  };
  for (const [key, expected] of Object.entries(executionDefaults)) {
    assert.ok(
      script[key] === undefined || script[key] === expected,
      `Manifest boundary: ${key} must remain ${JSON.stringify(expected)}`,
    );
  }
}

module.exports = { validateManifestBoundary };
