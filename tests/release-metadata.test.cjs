"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateProjectReleaseVersion } = require("../scripts/release-version.cjs");

const root = path.resolve(__dirname, "..");
const metadataFiles = ["manifest.json", "package.json", "package-lock.json"];

function createReleaseFixture(t, version, { metadataVersion = version } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "hunkmark-release-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const relative of metadataFiles) {
    const value = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
    value.version = metadataVersion;
    if (relative === "package-lock.json") {
      value.packages[""].version = metadataVersion;
    }
    fs.writeFileSync(path.join(fixture, relative), JSON.stringify(value));
  }
  fs.writeFileSync(path.join(fixture, "VERSION"), `${version}\n`);
  fs.mkdirSync(path.join(fixture, "scripts"));
  for (const script of ["release-version.cjs", "manifest-policy.cjs", "sync-version.cjs", "validate-release.cjs"]) {
    fs.copyFileSync(path.join(root, "scripts", script), path.join(fixture, "scripts", script));
  }
  // Validation reads the real release assets; only metadata and scripts live
  // in the fixture, so synchronization cannot modify the checkout.
  for (const relative of [
    "core.js", "content.js", "content.css", "content", "icons", "store-assets",
    "design", "LICENSE", "PRIVACY.md", "README.md", "README.ja.md", "CONTRIBUTING.md",
  ]) {
    fs.symlinkSync(path.join(root, relative), path.join(fixture, relative));
  }
  return fixture;
}

function runReleaseScript(fixture, script, tagVersion = "") {
  return spawnSync(process.execPath, [path.join(fixture, "scripts", script)], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, TAGPR_NEXT_VERSION: tagVersion },
  });
}

test("accepts three-part project versions within Chrome's limits", () => {
  for (const version of ["0.0.1", "0.1.0", "1.0.0", "3.2.0", "65535.65535.65535"]) {
    assert.doesNotThrow(() => validateProjectReleaseVersion(version), version);
  }
});

test("rejects zero, out-of-range, and malformed project versions", () => {
  for (const version of [
    "0.0.0", "65536.0.0", "1.65536.0", "1.0.65536", "01.0.0", "1.00.0",
    "1.0.00", "1.0", "1.0.0.0", "1.0.0-beta.1", "1.0.0+build", "-1.0.0", "",
  ]) {
    assert.throws(() => validateProjectReleaseVersion(version), { code: "ERR_ASSERTION" }, version);
  }
});

for (const version of ["0.0.0", "65536.0.0", "3.2.0-beta", "3.2.0.1"]) {
  test(`both release scripts reject ${version} without changing metadata`, (t) => {
    const fixture = createReleaseFixture(t, version);
    const before = metadataFiles.map((relative) =>
      fs.readFileSync(path.join(fixture, relative), "utf8"),
    );
    for (const script of ["sync-version.cjs", "validate-release.cjs"]) {
      const result = runReleaseScript(fixture, script);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0, `${script} accepted ${version}`);
      assert.match(result.stderr, /AssertionError.*VERSION/s);
      assert.deepEqual(
        metadataFiles.map((relative) => fs.readFileSync(path.join(fixture, relative), "utf8")),
        before,
      );
    }
  });
}

test("synchronizes and validates a valid release version", (t) => {
  const fixture = createReleaseFixture(t, "0.0.1", { metadataVersion: "3.2.0" });
  const sync = runReleaseScript(fixture, "sync-version.cjs", "v0.0.1");
  assert.equal(sync.error, undefined);
  assert.equal(sync.status, 0, sync.stderr);
  for (const relative of metadataFiles) {
    const value = JSON.parse(fs.readFileSync(path.join(fixture, relative), "utf8"));
    assert.equal(value.version, "0.0.1");
    if (relative === "package-lock.json") {
      assert.equal(value.packages[""].version, "0.0.1");
    }
  }
  const validation = runReleaseScript(fixture, "validate-release.cjs");
  assert.equal(validation.error, undefined);
  assert.equal(validation.status, 0, validation.stderr);
});

for (const [name, mutate] of [
  ["additional host permissions", (m) => m.host_permissions = ["<all_urls>"]],
  ["a second content script", (m) => m.content_scripts.push({ matches: ["<all_urls>"], js: ["content.js"] })],
  ["the page execution world", (m) => m.content_scripts[0].world = "MAIN"],
]) {
  test(`release validation rejects ${name}`, (t) => {
    const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
    const fixture = createReleaseFixture(t, version);
    const file = path.join(fixture, "manifest.json");
    const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(candidate);
    fs.writeFileSync(file, JSON.stringify(candidate));
    const result = runReleaseScript(fixture, "validate-release.cjs");
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Manifest boundary:/);
  });
}
