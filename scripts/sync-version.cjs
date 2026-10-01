"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateProjectReleaseVersion } = require("./release-version.cjs");

const root = path.resolve(__dirname, "..");
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
validateProjectReleaseVersion(version);

if (process.env.TAGPR_NEXT_VERSION) {
  assert.equal(
    process.env.TAGPR_NEXT_VERSION,
    `v${version}`,
    "TAGPR_NEXT_VERSION does not match VERSION",
  );
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function writeJson(relative, value) {
  fs.writeFileSync(
    path.join(root, relative),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");

assert.ok(
  packageLock.packages?.[""],
  "package-lock.json is missing its root package",
);

manifest.version = version;
packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;

writeJson("manifest.json", manifest);
writeJson("package.json", packageJson);
writeJson("package-lock.json", packageLock);

console.log(`Synchronized release metadata to ${version}.`);
