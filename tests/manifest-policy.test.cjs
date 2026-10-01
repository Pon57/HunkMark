"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateManifestBoundary } = require("../scripts/manifest-policy.cjs");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));

test("accepts the current manifest permissions and execution scope", () => {
  assert.doesNotThrow(() => validateManifestBoundary(manifest));
});

test("does not pin display metadata or the runtime module list", () => {
  const candidate = structuredClone(manifest);
  candidate.name = "Another display name";
  candidate.description = "Updated display description";
  candidate.icons = { 128: "icons/another-icon.png" };
  candidate.version_name = "A display version";
  candidate.author = "Another author";
  candidate.homepage_url = "https://example.com/";
  candidate.default_locale = "en";
  candidate.content_scripts[0].js.splice(-1, 0, "content/new-module.js");
  assert.doesNotThrow(() => validateManifestBoundary(candidate));
});

test("accepts omitted or explicitly unchanged execution defaults", () => {
  const candidate = structuredClone(manifest);
  delete candidate.content_scripts[0].run_at;
  assert.doesNotThrow(() => validateManifestBoundary(candidate));
  Object.assign(candidate.content_scripts[0], {
    run_at: "document_idle", world: "ISOLATED", all_frames: false,
    match_about_blank: false, match_origin_as_fallback: false,
  });
  assert.doesNotThrow(() => validateManifestBoundary(candidate));
});

for (const [key, value] of Object.entries({
  host_permissions: ["<all_urls>"],
  optional_host_permissions: ["<all_urls>"],
  optional_permissions: ["tabs"],
  background: { service_worker: "content.js" },
  action: { default_popup: "popup.html" },
  web_accessible_resources: [{ resources: ["content.js"], matches: ["<all_urls>"] }],
  externally_connectable: { matches: ["https://example.com/*"] },
  sandbox: { pages: ["sandbox.html"] },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  unknown_execution_surface: {},
})) {
  test(`rejects an additional manifest key: ${key}`, () => {
    const candidate = structuredClone(manifest);
    candidate[key] = value;
    assert.throws(() => validateManifestBoundary(candidate), /Manifest boundary: unsupported key/);
  });
}

const invalidChanges = [
  ["additional permissions", (m) => m.permissions.push("tabs")],
  ["missing permissions", (m) => delete m.permissions],
  ["a second content script", (m) => m.content_scripts.push({ matches: ["<all_urls>"], js: ["content.js"] })],
  ["missing content scripts", (m) => delete m.content_scripts],
  ["a null content script", (m) => m.content_scripts[0] = null],
  ["all-site matches", (m) => m.content_scripts[0].matches = ["<all_urls>"]],
  ["extra CSS", (m) => m.content_scripts[0].css.push("other.css")],
  ["an extra root script", (m) => m.content_scripts[0].js.splice(-1, 0, "extra.js")],
  ["a traversal path", (m) => m.content_scripts[0].js.splice(-1, 0, "content/../extra.js")],
  ["an encoded path", (m) => m.content_scripts[0].js.splice(-1, 0, "content/%2e%2e%2fextra.js")],
  ["a URL fragment", (m) => m.content_scripts[0].js.splice(-1, 0, "content/app.js#extra.js")],
  ["a duplicate script", (m) => m.content_scripts[0].js.splice(-1, 0, "content/app.js")],
  ["a changed bootstrap order", (m) => m.content_scripts[0].js.reverse()],
  ["all frames", (m) => m.content_scripts[0].all_frames = true],
  ["the page execution world", (m) => m.content_scripts[0].world = "MAIN"],
  ["earlier execution", (m) => m.content_scripts[0].run_at = "document_start"],
  ["about:blank matching", (m) => m.content_scripts[0].match_about_blank = true],
  ["origin fallback matching", (m) => m.content_scripts[0].match_origin_as_fallback = true],
  ["an invalid explicit default", (m) => m.content_scripts[0].all_frames = null],
  ["an unrecognized content-script option", (m) => m.content_scripts[0].unknown_scope = true],
];
for (const [name, mutate] of invalidChanges) {
  test(`rejects ${name}`, () => {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(() => validateManifestBoundary(candidate), /Manifest boundary:/);
  });
}
