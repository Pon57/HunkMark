const {
  test, assert, path, startExtension, createChromeApi, duplicateHunkFixture,
  controllersFor, waitFor,
} = require("./content-test-support.cjs");
const fs = require("node:fs");
const manifest = require("../manifest.json");

function inject(dom) {
  for (const file of manifest.content_scripts[0].js) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
  }
  return dom.window.HunkMarkContent.activeApp;
}

test("repeated bootstrap keeps the healthy runtime and its controls", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = controllersFor(app);
    const observer = app.observer;
    assert.equal(inject(dom), app);
    assert.equal(app.observer, observer);
    assert.deepEqual(controllersFor(app), controllers);
    assert.equal(dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length, 2);
  } finally {
    dom.window.HunkMarkContent?.activeApp?.stop();
    dom.window.close();
  }
});

test("new isolated runtime replaces a disconnected instance without losing the document or saved review state", async () => {
  const { app: oldApp, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await oldApp.setHunkViewed(controllersFor(oldApp)[0], true);
    const storage = chrome.snapshot();
    const document = dom.window.document;
    const draft = document.createElement("textarea");
    draft.value = "unsaved draft";
    document.body.append(draft);
    chrome.invalidateContext();
    delete chrome.api.runtime.id;
    oldApp.stopForInvalidatedContext();
    assert.ok(document.getElementById(oldApp.constants.RECONNECT_NOTICE_ID));

    dom.window.chrome = createChromeApi(storage).api;
    delete dom.window.HunkMarkContent;
    delete dom.window.HunkMarkCore;
    const app = inject(dom);
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(controllersFor(app).length, 2);
    });
    assert.equal(oldApp.runtimeReplaced, true);
    assert.equal(oldApp.observer, null);
    assert.equal(oldApp.reconnectNoticeController, null);
    assert.equal(oldApp.navigationStarted, false);
    assert.equal(dom.window.document, document);
    assert.equal(draft.isConnected, true);
    assert.equal(draft.value, "unsaved draft");
    assert.equal(controllersFor(app)[0].marked, true);
    assert.equal(document.querySelectorAll(".hunkmark-hunk-actions").length, 2);

    oldApp.stopForInvalidatedContext(new Error("Extension context invalidated."));
    oldApp.showReconnectNotice();
    assert.equal(document.getElementById(app.constants.RECONNECT_NOTICE_ID), null);
    const legacyNotice = document.createElement("aside");
    legacyNotice.id = app.constants.RECONNECT_NOTICE_ID;
    document.body.append(legacyNotice);
    await waitFor(() => assert.equal(legacyNotice.isConnected, false));
    assert.equal(controllersFor(app).length, 2);
  } finally {
    dom.window.HunkMarkContent?.activeApp?.stop();
    oldApp.stop();
    dom.window.close();
  }
});

test("replacement on a non-PR page keeps review observers and storage idle", async () => {
  const { app: oldApp, dom } = await startExtension("<html><body></body></html>", {}, {
    url: "https://github.com/octo/repo", waitForScope: false,
  });
  try {
    const chrome = createChromeApi();
    let reads = 0;
    const get = chrome.api.storage.local.get;
    chrome.api.storage.local.get = (...args) => { reads += 1; return get(...args); };
    dom.window.chrome = chrome.api;
    delete dom.window.HunkMarkContent;
    delete dom.window.HunkMarkCore;
    const app = inject(dom);
    assert.equal(oldApp.runtimeReplaced, true);
    assert.equal(app.stopped, true);
    assert.equal(app.observer, null);
    assert.equal(app.refreshQueued, false);
    assert.equal(reads, 0);
  } finally {
    dom.window.HunkMarkContent?.activeApp?.stop();
    oldApp.stop();
    dom.window.close();
  }
});
