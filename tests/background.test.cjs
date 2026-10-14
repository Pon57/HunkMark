"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const manifest = require("../manifest.json");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");

function startWorker({ tabs = [{ id: 1 }], prepare = async () => [{ documentId: "document-1", result: true }] } = {}) {
  const hooks = {};
  const calls = [];
  const chrome = {
    runtime: {
      getManifest: () => structuredClone(manifest),
      onInstalled: { addListener: (fn) => { hooks.installed = fn; } },
    },
    action: { onClicked: { addListener: (fn) => { hooks.clicked = fn; } } },
    tabs: { async query(options) { calls.push(["query", options]); return tabs; } },
    scripting: {
      async executeScript(options) {
        calls.push(["execute", options]);
        return options.func ? prepare(options) : [];
      },
      async removeCSS(options) { calls.push(["removeCSS", options]); },
      async insertCSS(options) { calls.push(["insertCSS", options]); },
    },
  };
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(source, context);
  return { calls, hooks, prepareReconnect: vm.runInContext("prepareReconnect", context) };
}

test("reconnects matching tabs on update using only packaged scripts and one prepared document", async () => {
  const { calls, hooks } = startWorker();
  await hooks.installed({ reason: "update" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["query", { url: ["https://github.com/*"] }]);
  const preparation = calls[1][1];
  assert.equal(preparation.world, "ISOLATED");
  assert.equal(preparation.target.tabId, 1);
  assert.equal(preparation.args[0], manifest.version);
  for (const [, options] of calls.slice(2)) {
    assert.deepEqual(JSON.parse(JSON.stringify(options.target)), { tabId: 1, documentIds: ["document-1"] });
  }
  assert.deepEqual(calls.map(([type]) => type), ["query", "execute", "removeCSS", "insertCSS", "execute"]);
  assert.deepEqual(calls[3][1].files, manifest.content_scripts[0].css);
  assert.deepEqual(calls[4][1].files, manifest.content_scripts[0].js);
  assert.equal(calls[4][1].world, "ISOLATED");
});

test("does no work for unrelated lifecycle events or toolbar clicks outside GitHub", async () => {
  const { calls, hooks } = startWorker();
  await hooks.installed({ reason: "chrome_update" });
  for (const url of [undefined, "https://example.com/", "http://github.com/", "https://github.com.example.com/"]) {
    hooks.clicked({ id: 1, url });
  }
  assert.equal(calls.length, 0);
});

test("skips healthy runtimes and missing documents", async () => {
  for (const result of [[{ documentId: "doc", result: false }], [], [{ result: true }]]) {
    const { calls, hooks } = startWorker({ prepare: async () => result });
    await hooks.installed({ reason: "install" });
    assert.deepEqual(calls.map(([type]) => type), ["query", "execute"]);
  }
});

test("coalesces concurrent toolbar requests but allows retry after failure", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  const { calls, hooks } = startWorker({ prepare: async () => {
    attempts += 1;
    if (attempts === 1) {
      await gate;
      throw new Error("Document navigated away");
    }
    return [{ result: true, documentId: "new-document" }];
  } });
  const tab = { id: 1, url: "https://github.com/octo/repo/pull/123/files" };
  hooks.clicked(tab);
  hooks.clicked(tab);
  assert.equal(attempts, 1);
  release();
  await new Promise(setImmediate);
  hooks.clicked(tab);
  await new Promise(setImmediate);
  assert.equal(attempts, 2);
  assert.equal(calls.filter(([type]) => type === "insertCSS").length, 1);
});

test("one inaccessible tab does not prevent reconnecting other GitHub tabs", async () => {
  const { calls, hooks } = startWorker({ tabs: [{ id: 1 }, { id: 2 }], prepare: async ({ target }) => {
    if (target.tabId === 1) throw new Error("Cannot access contents of the page");
    return [{ result: true, documentId: "second-document" }];
  } });
  await hooks.installed({ reason: "update" });
  const injection = calls.find(([type, options]) => type === "execute" && options.files);
  assert.equal(injection[1].target.tabId, 2);
});

test("preparation checks the live origin, reuses healthy runtimes, and yields for old observers", async () => {
  const { prepareReconnect } = startWorker();
  for (const url of ["https://example.com/", "https://github.com/octo/repo"]) {
    const dom = new JSDOM("<html><body></body></html>", { url, runScripts: "outside-only" });
    try {
      const prepare = dom.window.eval(`(${prepareReconnect.toString()})`);
      let stopped = 0;
      let replaced = 0;
      let mutations = 0;
      dom.window.document.addEventListener("hunkmark:replace-runtime", () => { replaced += 1; });
      const observer = new dom.window.MutationObserver(() => { mutations += 1; });
      observer.observe(dom.window.document.documentElement, { childList: true });
      const app = {
        runtimeVersion: manifest.version,
        navigationStarted: true,
        isExtensionContextInvalidated: () => false,
        stop() { stopped += 1; },
      };
      dom.window.HunkMarkContent = { activeApp: app };
      assert.equal(await prepare(manifest.version), false);
      assert.equal(stopped, 0);
      app.isExtensionContextInvalidated = () => true;
      const github = url.startsWith("https://github.com/");
      assert.equal(await prepare(manifest.version), github);
      assert.equal(stopped, Number(github));
      assert.equal(replaced, Number(github));
      assert.equal(mutations, Number(github));
      assert.equal(dom.window.document.documentElement.childNodes.length, 2);
      observer.disconnect();
    } finally {
      dom.window.close();
    }
  }
});
