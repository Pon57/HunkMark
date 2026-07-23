"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.equal(
  manifest.name,
  "HunkMark – Diff Review for GitHub",
  "Unexpected extension name",
);
assert.equal(manifest.short_name, "HunkMark", "Unexpected extension short name");
assert.equal(packageJson.name, "hunkmark", "Unexpected package name");
assert.equal(manifest.version, packageJson.version, "Manifest and package versions differ");
assert.equal(packageJson.license, "MIT", "Unexpected package license");
assert.equal(packageJson.author, "Pon", "Unexpected package author");
assert.equal(packageJson.private, true, "The npm package must remain private");
assert.equal(
  packageJson.homepage,
  "https://github.com/Pon57/HunkMark#readme",
  "Unexpected project homepage",
);
assert.deepEqual(
  packageJson.repository,
  {
    type: "git",
    url: "git+https://github.com/Pon57/HunkMark.git",
  },
  "Unexpected package repository",
);
assert.deepEqual(
  packageJson.bugs,
  { url: "https://github.com/Pon57/HunkMark/issues" },
  "Unexpected issue tracker",
);
assert.ok(manifest.name.length <= 75, "Manifest name exceeds 75 characters");
assert.ok(manifest.short_name.length <= 12, "Manifest short name exceeds 12 characters");
assert.ok(manifest.description.length <= 132, "Manifest description exceeds 132 characters");
assert.deepEqual(manifest.permissions, ["storage"], "Unexpected extension permissions");
assert.deepEqual(
  manifest.content_scripts?.[0]?.matches,
  ["https://github.com/*"],
  "Unexpected content-script host access",
);

const executableFiles = [
  ...new Set(
    manifest.content_scripts.flatMap((contentScript) => contentScript.js ?? []),
  ),
];

for (const file of [
  ...executableFiles,
  "content.css",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "CONTRIBUTING.md",
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing ${file}`);
}

assert.deepEqual(
  fs.readdirSync(path.join(root, "content")).sort(),
  executableFiles
    .filter((file) => file.startsWith("content/"))
    .map((file) => path.basename(file))
    .sort(),
  "The content module directory must contain only declared scripts",
);

function pngDimensions(file) {
  const data = fs.readFileSync(file);
  const signature = "89504e470d0a1a0a";
  assert.equal(data.subarray(0, 8).toString("hex"), signature, `${file} is not PNG`);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

for (const size of [16, 32, 48, 128]) {
  const relative = manifest.icons?.[String(size)];
  assert.ok(relative, `Missing ${size}px icon declaration`);
  assert.deepEqual(
    pngDimensions(path.join(root, relative)),
    { width: size, height: size },
    `Incorrect ${size}px icon dimensions`,
  );
}

assert.deepEqual(
  fs.readdirSync(path.join(root, "icons")).sort(),
  ["icon-128.png", "icon-16.png", "icon-32.png", "icon-48.png"],
  "The release icon directory must not contain source artwork or undeclared files",
);

for (const [relative, dimensions] of [
  ["store-assets/screenshot-main.png", { width: 1280, height: 800 }],
  ["store-assets/screenshot-filtered.png", { width: 1280, height: 800 }],
  ["store-assets/promo-small.png", { width: 440, height: 280 }],
]) {
  assert.deepEqual(
    pngDimensions(path.join(root, relative)),
    dimensions,
    `Incorrect dimensions for ${relative}`,
  );
}

const executableSource = executableFiles
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");
assert.doesNotMatch(executableSource, /\beval\s*\(/, "eval is not allowed");
assert.doesNotMatch(executableSource, /\bnew\s+Function\s*\(/, "Dynamic code is not allowed");
assert.doesNotMatch(executableSource, /https?:\/\//, "Executable code contains a remote URL");

console.log(`Release metadata is valid for ${manifest.name} ${manifest.version}.`);
