"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const scripts = manifest.content_scripts.flatMap(
  (contentScript) => contentScript.js ?? [],
);

for (const relative of new Set(scripts)) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  new vm.Script(source, { filename: relative });
}

console.log(`Parsed ${new Set(scripts).size} extension scripts.`);
