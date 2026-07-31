"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../core.js");
const LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v1";
const LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE = "hunkmark:v2";

async function lineReviewContextFingerprint(options) {
  const blockFingerprint =
    await Core.lineReviewBlockFingerprint(options);
  return Core.lineReviewContextFingerprint({
    blockFingerprint,
    blockLineIndex: options.blockLineIndex,
  });
}

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const extensionScripts = manifest.content_scripts[0].js;

function withViewerMeta(html, viewerLogin) {
  return html.replace(
    "<html>",
    `<html><head><meta name="user-login" content="${viewerLogin}"></head>`,
  );
}

function createChromeApi(initial = {}) {
  const data = { ...structuredClone(initial) };
  const listeners = new Set();
  let contextInvalidated = false;
  let nextRemoveError = null;
  let nextSetError = null;

  function requireValidContext() {
    if (contextInvalidated) {
      throw new Error("Extension context invalidated.");
    }
  }

  function emit(changes) {
    if (Object.keys(changes).length === 0) {
      return;
    }
    listeners.forEach((listener) => listener(changes, "local"));
  }

  const local = {
    async get(keys) {
      requireValidContext();
      if (keys === null || keys === undefined) {
        return structuredClone(data);
      }
      if (typeof keys === "string") {
        return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => key in data)
            .map((key) => [key, structuredClone(data[key])]),
        );
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          key in data ? structuredClone(data[key]) : fallback,
        ]),
      );
    },

    async set(values) {
      requireValidContext();
      if (nextSetError) {
        const error = nextSetError;
        nextSetError = null;
        throw error;
      }
      const changes = {};
      Object.entries(values).forEach(([key, value]) => {
        const oldValue = data[key];
        data[key] = structuredClone(value);
        changes[key] = {
          oldValue: structuredClone(oldValue),
          newValue: structuredClone(value),
        };
      });
      emit(changes);
    },

    async remove(keys) {
      requireValidContext();
      if (nextRemoveError) {
        const error = nextRemoveError;
        nextRemoveError = null;
        throw error;
      }
      const changes = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => {
        if (!(key in data)) {
          return;
        }
        changes[key] = {
          oldValue: structuredClone(data[key]),
          newValue: undefined,
        };
        delete data[key];
      });
      emit(changes);
    },
  };

  return {
    api: {
      runtime: {
        id: "test-hunkmark-extension",
      },
      storage: {
        local,
        onChanged: {
          addListener(listener) {
            requireValidContext();
            listeners.add(listener);
          },
          removeListener(listener) {
            requireValidContext();
            listeners.delete(listener);
          },
        },
      },
    },
    snapshot() {
      return structuredClone(data);
    },
    failNextSet(message = "storage write failed") {
      nextSetError = new Error(message);
    },
    failNextRemove(message = "storage removal failed") {
      nextRemoveError = new Error(message);
    },
    invalidateContext() {
      contextInvalidated = true;
    },
  };
}

function createExclusiveLockManager() {
  const queues = new Map();
  const requests = [];

  return {
    requests,
    async request(name, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const mode = options?.mode ?? "exclusive";
      requests.push({ mode, name });

      const previous = queues.get(name) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve) => {
        release = resolve;
      });
      queues.set(name, current);
      await previous;

      try {
        return await callback({ mode, name });
      } finally {
        release();
        if (queues.get(name) === current) {
          queues.delete(name);
        }
      }
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installContentStyles(dom) {
  const style = dom.window.document.createElement("style");
  style.textContent = fs.readFileSync(path.join(root, "content.css"), "utf8");
  dom.window.document.head.append(style);
  return style;
}

function holdReviewStorageLock(app, lockManager) {
  const started = createDeferred();
  const gate = createDeferred();
  const promise = lockManager.request(
    app.reviewStorageLockName(),
    { mode: "exclusive" },
    async () => {
      started.resolve();
      await gate.promise;
    },
  );
  return {
    promise,
    release: gate.resolve,
    started: started.promise,
  };
}

function delayReviewStorageSet(
  app,
  targetWrite,
  { failureMessage = null } = {},
) {
  const original =
    app.setReviewStorageValuesUnlocked.bind(app);
  const started = createDeferred();
  const gate = createDeferred();
  let writeCount = 0;
  app.setReviewStorageValuesUnlocked = async (values) => {
    writeCount += 1;
    if (writeCount === targetWrite) {
      started.resolve();
      await gate.promise;
      if (failureMessage) {
        throw new Error(failureMessage);
      }
    }
    return original(values);
  };
  return {
    release: gate.resolve,
    started: started.promise,
  };
}

function delayReviewStorageRead(app) {
  const original = app.getLocalStorage.bind(app);
  const started = createDeferred();
  const gate = createDeferred();
  app.getLocalStorage = async (keys) => {
    if (
      Array.isArray(keys) &&
      keys.some((key) => key.endsWith(":collapsed"))
    ) {
      started.resolve();
      await gate.promise;
    }
    return original(keys);
  };
  return { release: gate.resolve, started: started.promise };
}

function recordCachedDiscoveryRoots(app) {
  const roots = [];
  const discoverCachedHunks = app.discoverCachedHunks.bind(app);
  app.discoverCachedHunks = (searchRoot) => {
    roots.push(searchRoot);
    return discoverCachedHunks(searchRoot);
  };
  return roots;
}

function controllersFor(app) {
  return Array.from(app.controllersByRow.values());
}

function controllerAt(app, index = 0) {
  const controller = controllersFor(app)[index];
  assert.ok(controller, `Expected controller at index ${index}`);
  return controller;
}

function stopExtensions(...extensions) {
  extensions.forEach(({ app, dom }) => {
    app.stop();
    dom.window.close();
  });
}

async function startSharedExtensions(html) {
  const chrome = createChromeApi();
  const locks = createExclusiveLockManager();
  const options = { chromeInstance: chrome, lockManager: locks };
  const first = await startExtension(html, {}, options);
  const second = await startExtension(html, {}, options);
  return { chrome, first, locks, second };
}

async function startLockedExtension(
  html = commitSelectionFixture(),
  initialStorage = {},
  options = {},
) {
  const chrome = createChromeApi(initialStorage);
  const locks = createExclusiveLockManager();
  const extension = await startExtension(html, {}, {
    ...options,
    chromeInstance: chrome,
    lockManager: locks,
  });
  return { ...extension, locks };
}

async function seedOfficialSuppression(app, key) {
  const scope = app.officialViewedSuppressionScope();
  const updatedAt = Date.now();
  await app.setReviewStorage(
    { [key]: { suppressed: true, updatedAt } },
    scope,
    updatedAt,
  );
  await waitFor(() => {
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
  });
  return scope;
}

async function seedSharedOfficialSuppression(tabA, tabB, key) {
  const scope = await seedOfficialSuppression(tabA.app, key);
  await waitFor(() => {
    assert.equal(tabB.app.officialViewedSyncSuppressed.has(key), true);
  });
  return scope;
}

function officialViewedContext(app, index = 0) {
  const controllers = controllersFor(app);
  const controller = controllers[index];
  assert.ok(controller, `Expected controller at index ${index}`);
  return {
    control: app.officialViewedControlForFile(controller.fileElement),
    controller,
    controllers,
    fileElement: controller.fileElement,
    filePath: controller.filePath,
    key: controller.officialSuppressionKey,
    scope: app.officialViewedSuppressionScope(),
  };
}

async function officialFileContext(app, dom) {
  const fileElement = dom.window.document.querySelector(".js-file");
  assert.ok(fileElement, "Expected a GitHub file container");
  const filePath = app.resolveFilePath(fileElement, 0);
  const scope = app.officialViewedSuppressionScope();
  return {
    control: app.officialViewedControlForFile(fileElement),
    fileElement,
    filePath,
    key: await app.officialViewedSuppressionKey(filePath, scope),
    scope,
  };
}

function captureWarnings(dom) {
  const warnings = [];
  dom.window.console.warn = (...args) => warnings.push(args);
  return warnings;
}

function changeCheckbox(dom, input, checked = true) {
  input.checked = checked;
  input.dispatchEvent(
    new dom.window.Event("change", { bubbles: true }),
  );
}

function lineControls(dom) {
  return dom.window.document.querySelectorAll(".hunkmark-line-control");
}

function setOfficialViewed(control, viewed) {
  control.setAttribute("aria-label", viewed ? "Viewed" : "Not Viewed");
  control.setAttribute("aria-pressed", String(viewed));
}

function respondToOfficialClicks(control, viewedAfterClick) {
  let clicks = 0;
  control.addEventListener("click", () => {
    clicks += 1;
    const viewed = viewedAfterClick === "toggle"
      ? control.getAttribute("aria-pressed") !== "true"
      : viewedAfterClick;
    setOfficialViewed(control, viewed);
  });
  return () => clicks;
}

function assertOfficialIntentSettled(app, key) {
  assert.equal(
    app.officialViewedReconcileGenerationByKey.has(key),
    false,
  );
  assert.equal(
    app.officialViewedStorageIntentGenerationByKey.has(key),
    false,
  );
}

async function waitFor(assertion, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function assertFileRevealState(dom, fileElement, contentElement, restoring) {
  assert.equal(
    fileElement.classList.contains("hunkmark-file-reveal-restoring"),
    restoring,
  );
  assert.equal(
    fileElement.firstElementChild.classList.contains(
      "hunkmark-file-reveal-restore-header",
    ),
    restoring,
  );
  assert.equal(
    dom.window.getComputedStyle(contentElement).display === "none",
    restoring,
  );
}

async function startExtension(
  html,
  initialStorage = {},
  {
    chromeInstance = null,
    digestInputSizes = null,
    lockManager = null,
    url = "https://github.com/octo/repo/pull/123/files",
    waitForScope = true,
  } = {},
) {
  const chrome = chromeInstance ?? createChromeApi(initialStorage);
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url,
  });
  Object.defineProperty(dom.window, "crypto", {
    configurable: true,
    value: digestInputSizes
      ? {
          subtle: {
            digest(algorithm, input) {
              digestInputSizes.push(input.byteLength);
              return globalThis.crypto.subtle.digest(algorithm, input);
            },
          },
        }
      : globalThis.crypto,
  });
  dom.window.TextEncoder = globalThis.TextEncoder;
  dom.window.chrome = chrome.api;
  if (lockManager) {
    Object.defineProperty(dom.window.navigator, "locks", {
      configurable: true,
      value: lockManager,
    });
  }
  dom.window.ResizeObserver = class ResizeObserver {
    observe() {}
    disconnect() {}
  };

  extensionScripts.forEach((relative) => {
    dom.window.eval(fs.readFileSync(path.join(root, relative), "utf8"));
  });

  if (waitForScope) {
    await waitFor(() => {
      const app = dom.window.HunkMarkContent.activeApp;
      assert.ok(app.currentScope);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
    });
  }
  return { chrome, dom, app: dom.window.HunkMarkContent.activeApp };
}

function duplicateHunkFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/example.js">
        <div class="file-header"><span class="file-info">src/example.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+return null;</td></tr>
          <tr><td class="blob-code-hunk">@@ -50 +50 @@</td></tr>
          <tr><td class="blob-num">50</td><td class="blob-code-addition">+return null;</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function largeChangedBlockFixture(lineCount = 200, lineWidth = 96) {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const prefix = `+line-${String(index).padStart(4, "0")}-`;
    const text = `${prefix}${"x".repeat(lineWidth - prefix.length)}`;
    return `<tr><td class="blob-code-addition">${text}</td></tr>`;
  }).join("");
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/large.js">
        <div class="file-header"><span class="file-info">src/large.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1,0 +1,${lineCount} @@</td></tr>
          ${lines}
        </tbody></table>
      </div>
    </body></html>`;
}

function mergeableHunkFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/merge.js">
        <div class="file-header"><span class="file-info">src/merge.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
          <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
          <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
          <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function commitSelectionFixture({ withOfficialControl = true } = {}) {
  const officialControl = withOfficialControl
    ? '<button aria-label="Not Viewed" aria-pressed="false">Viewed</button>'
    : "";
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/selection.js">
        <div class="file-header">
          <span class="file-info">src/selection.js</span>
          ${officialControl}
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function initiallyViewedCommitSelectionFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/selection.js">
        <div class="file-header">
          <span class="file-info">src/selection.js</span>
          <button aria-label="Viewed" aria-pressed="true">Viewed</button>
        </div>
      </div>
    </body></html>`;
}

function loadDiffPlaceholderHtml() {
  return `<div class="load-diff-container">
    <div class="load-diff-placeholder">
      <div class="loading-skeleton">Loading preview</div>
      <button>Load Diff</button>
      <span class="load-diff-message">Large diffs are not rendered by default.</span>
    </div>
  </div>`;
}

function loadDiffFixture({ loaded = false } = {}) {
  const content = loaded
    ? `<table><tbody>
        <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
        <tr><td class="blob-num">1</td><td class="blob-code-addition">+loaded</td></tr>
      </tbody></table>`
    : loadDiffPlaceholderHtml();
  return `<!doctype html>
    <html><body>
      <div id="diff-large" class="js-file" data-file-path="src/large-diff.js">
        <div class="file-header"><span class="file-info">src/large-diff.js</span></div>
        <div class="diff-body">${content}</div>
      </div>
    </body></html>`;
}

function hiddenLargeDiffFixture(
  controlHtml,
  { includeHiddenPlaceholder = false } = {},
) {
  const content = includeHiddenPlaceholder
    ? `<div class="diff-body" hidden>${loadDiffPlaceholderHtml()}</div>`
    : "";
  return `<!doctype html>
    <html><body>
      <div id="diff-large" class="js-file" data-file-path="src/large-diff.js">
        <div class="file-header">
          <span class="file-info">src/large-diff.js</span>
          ${controlHtml}
        </div>
        ${content}
      </div>
    </body></html>`;
}

function nonHunkDiffFixture(
  controlHtml = "",
  { hidden = false } = {},
) {
  return `<!doctype html>
    <html><body>
      <div id="diff-binary" class="js-file" data-file-path="assets/logo.png">
        <div class="file-header">
          <span class="file-info">assets/logo.png</span>
          ${controlHtml}
        </div>
        <div class="diff-body"${hidden ? " hidden" : ""}>
          <div class="binary-diff">Binary file not shown.</div>
        </div>
      </div>
    </body></html>`;
}

function evolvingCommitFixture(updated = false, officialViewed = null) {
  const officialControl =
    officialViewed === null
      ? ""
      : `<button aria-label="${officialViewed ? "Viewed" : "Not Viewed"}" aria-pressed="${officialViewed}">Viewed</button>`;
  const changedRows = updated
    ? `<tr><td class="blob-num">0</td><td class="blob-code-context">before stable</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-addition">+new</td></tr>
       <tr><td class="blob-num">3</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">4</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">5</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">6</td><td class="blob-code-context">after repeats</td></tr>`
    : `<tr><td class="blob-num">0</td><td class="blob-code-context">before stable</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">3</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">4</td><td class="blob-code-context">after repeats</td></tr>`;
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/evolving.js">
        <div class="file-header">
          <span class="file-info">src/evolving.js</span>
          ${officialControl}
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1,${updated ? 5 : 3} @@</td></tr>
          ${changedRows}
        </tbody></table>
      </div>
    </body></html>`;
}

function replacePageBody(dom, html) {
  const replacement = new JSDOM(html);
  const nodes = Array.from(replacement.window.document.body.childNodes, (node) =>
    dom.window.document.importNode(node, true),
  );
  dom.window.document.body.replaceChildren(...nodes);
  replacement.window.close();
  dom.window.document.dispatchEvent(new dom.window.Event("turbo:load"));
}

function replaceMergeFixtureRows(document, merged) {
  const tbody = document.querySelector("tbody");
  tbody.innerHTML = merged
    ? `<tr><td class="blob-code-hunk">@@ -1,10 +1,10 @@</td></tr>
       <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
       <tr data-test-context><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
       <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
       <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
       <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>`
    : `<tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
       <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
       <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
       <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
       <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
       <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>`;
}

function splitFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/split.js">
        <div class="file-header">
          <span class="file-info">src/split.js</span>
          <button aria-label="Not Viewed" aria-pressed="false">Viewed</button>
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr>
            <td class="blob-num">1</td>
            <td class="blob-code-deletion" data-diff-side="left">-oldValue</td>
            <td class="blob-num">1</td>
            <td class="blob-code-addition" data-diff-side="right">+newValue</td>
          </tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function dragFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/drag.js">
        <div class="file-header"><span class="file-info">src/drag.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1,3 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-num">2</td><td class="blob-code-addition">+second</td></tr>
          <tr><td class="blob-num">3</td><td class="blob-code-addition">+third</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function modernGridFixture() {
  return `<!doctype html>
    <html><body>
      <section class="position-relative">
        <div class="Diff-module__diffHeaderWrapper__VTI5w">
          <div class="DiffFileHeader-module__diff-file-header__UuNN4">
            <div class="d-flex overflow-hidden DiffFileHeader-module__file-path-section__ZcmB1">
              <h3 class="DiffFileHeader-module__file-name__VVXpg DiffFileHeader-module__file-name-truncate__NBVtv">
                <a href="#diff-modern"><code>src/modern.ts</code></a>
              </h3>
            </div>
            <button aria-label="Not Viewed" aria-pressed="false">Viewed</button>
            <button aria-labelledby="modern-file-toggle-label">Collapse</button>
            <span id="modern-file-toggle-label">Collapse file</span>
          </div>
        </div>
        <div role="row">
          <div role="gridcell" class="diff-hunk-cell" style="padding-right: 16px">@@ -4 +4,2 @@ render()</div>
        </div>
        <div role="row" data-line-type="deletion">
          <div role="gridcell" class="diff-text-cell left-side-diff-cell" data-line-anchor="diff-modernL4" style="line-height: 24px; padding-right: 24px">
            <code class="deletion" data-diff-side="left">-old</code>
          </div>
        </div>
        <div role="row" data-line-type="addition">
          <div role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-modernR4" style="line-height: 24px; padding-right: 24px">
            <button aria-label="Add a line comment" style="background-color: rgb(31, 111, 235)">+</button>
            <code class="addition" data-diff-side="right"><span style="background-color: rgb(46, 160, 67)">+import</span><br>long.package.name<br>Type</code>
          </div>
        </div>
      </section>
    </body></html>`;
}

function contextualLineFixture({
  after = "after();",
  before = "before();",
  header = "@@ -10,3 +10,4 @@ function checkAccess() {",
  line = "+return true;",
  officialControl = false,
  signedOut = false,
  unresolved = false,
} = {}) {
  return `<!doctype html>
    <html><body>
      ${
        signedOut
          ? '<header><a href="/login?return_to=%2Focto%2Frepo">Sign in</a></header>'
          : ""
      }
      <div class="js-file" data-file-path="src/context.js">
        <div class="file-header">
          <span class="file-info">src/context.js</span>
          ${
            officialControl
              ? '<button aria-label="Not Viewed" aria-pressed="false">Viewed</button>'
              : ""
          }
        </div>
        ${
          unresolved
            ? '<div class="js-diff-load-container"><button>Load more lines</button></div>'
            : ""
        }
        <table><tbody>
          <tr><td class="blob-code-hunk">${header}</td></tr>
          <tr><td class="blob-num">9</td><td class="blob-code-context">${before}</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">${line}</td></tr>
          <tr><td class="blob-num">11</td><td class="blob-code-context">${after}</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

test("places per-file progress beside the file name", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileInfo = dom.window.document.querySelector(".file-info");
    await waitFor(() => {
      assert.match(
        fileInfo.querySelector(":scope > .hunkmark-file-progress").textContent,
        /Hunks 0\/2 · Lines 0\/2/,
      );
    });
    assert.equal(
      dom.window.document.querySelector(
        ".file-header > .hunkmark-file-progress",
      ),
      null,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("boots on a pull request and isolates duplicate lines in separate hunks", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      const controls = lineControls(dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });

    const controls = lineControls(dom);
    const firstController = Array.from(app.controllersByRow.values())[0];
    controls[0].click();

    await waitFor(() => {
      assert.equal(controls[0].getAttribute("aria-pressed"), "true");
      assert.equal(controls[1].getAttribute("aria-pressed"), "false");
      assert.equal(firstController.marked, true);
      assert.equal(firstController.collapsed, true);
      assert.equal(
        Object.keys(chrome.snapshot()).filter((key) =>
          key.includes(":line:"),
        ).length,
        1,
      );
    });
    assert.equal(
      firstController.lines[0].element.classList.contains(
        "hunkmark-line-viewed",
      ),
      true,
    );
    assert.equal(
      firstController.lines[0].element.previousElementSibling.classList.contains(
        "hunkmark-line-viewed",
      ),
      false,
    );
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 1 \/ 2/,
    );

    const storedLineKeys = Object.keys(chrome.snapshot()).filter((key) =>
      key.includes(":line:"),
    );
    assert.equal(storedLineKeys.length, 1);
    assert.equal(
      chrome.snapshot()[firstController.collapsedKey].autoCollapsed,
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bounds hashing and line-control DOM for a large changed block", async () => {
  const digestInputSizes = [];
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(),
    {},
    { digestInputSizes },
  );
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    assert.equal(controller.lines.length, 200);
    assert.equal(
      controller.lines.every(
        (line) =>
          line.control.tagName === "BUTTON" &&
          line.control.childElementCount === 0,
      ),
      true,
    );
    assert.equal(
      digestInputSizes.filter((size) => size > 10_000).length,
      2,
    );
    assert.equal(
      digestInputSizes.reduce((total, size) => total + size, 0) < 500_000,
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("links split diff sides and syncs GitHub's official Viewed control", async () => {
  const { app, dom } = await startExtension(splitFixture());
  try {
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-pressed", "true");
    });

    await waitFor(() => {
      const controls = lineControls(dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });
    const controls = lineControls(dom);
    controls[0].click();

    await waitFor(() => {
      assert.equal(controls[0].getAttribute("aria-pressed"), "true");
      assert.equal(controls[1].getAttribute("aria-pressed"), "true");
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not redraw review controls for storage changes that preserve visible state", async () => {
  const { app, chrome, dom } = await startExtension(
    commitSelectionFixture(),
  );
  try {
    const { controller, key } = officialViewedContext(app);
    let appearanceUpdates = 0;
    let progressUpdates = 0;
    app.applyControllerAppearance = () => {
      appearanceUpdates += 1;
    };
    app.updateProgress = () => {
      progressUpdates += 1;
    };

    const updatedAt = Date.now();
    await chrome.api.storage.local.set({
      [key]: { suppressed: true, updatedAt },
    });
    const line = controller.lines[0];
    line.marked = true;
    app.updateAggregateFromLines(controller);
    await chrome.api.storage.local.set({
      [line.key]: app.lineReviewStorageValue(line, updatedAt),
    });

    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(line.marked, true);
    assert.equal(appearanceUpdates, 0);
    assert.equal(progressUpdates, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("refreshes immediately when a manual Viewed click hides the diff", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = fileElement.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    const filePath = app.resolveFilePath(fileElement, 0);
    const suppressionKey =
      await app.officialViewedSuppressionKey(filePath);
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
      fileElement.querySelector("table")?.remove();
    });

    officialControl.click();

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(
        dom.window.document.getElementById(app.constants.PANEL_ID),
        null,
      );
      assert.equal(
        app.officialViewedSyncSuppressed.has(suppressionKey),
        false,
      );
      assert.equal(suppressionKey in chrome.snapshot(), false);
    });
    assert.equal(scheduled[0]?.immediate, true);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("hides a cold-cache Viewed removal until review state is restored", async () => {
  const { app, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  const reviewRead = delayReviewStorageRead(app);
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const filePath = app.resolveFilePath(fileElement, 0);
    assert.equal(app.controllersByRow.size, 0);
    assert.equal(
      app.Core.cachedOfficialSyncSuppressionKey(
        app.officialViewedSuppressionScope(),
        filePath,
      ),
      null,
    );
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const tableHtml =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    installContentStyles(dom);
    const officialControl = fileElement.querySelector(
      'button[aria-label="Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Not Viewed");
      officialControl.setAttribute("aria-pressed", "false");
      fileElement.insertAdjacentHTML("beforeend", tableHtml);
      fileElement.insertAdjacentHTML(
        "beforeend",
        "<button>Load more lines</button>",
      );
    });

    officialControl.click();
    await Promise.resolve();

    const table = fileElement.querySelector("table");
    assertFileRevealState(dom, fileElement, table, true);
    await reviewRead.started;
    assert.equal(app.controllersByRow.size, 2);
    assert.equal(dom.window.getComputedStyle(table).display, "none");

    reviewRead.release();

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.ok(
        dom.window.document.getElementById(app.constants.PANEL_ID),
      );
      assertFileRevealState(dom, fileElement, table, false);
    });
    assert.equal(scheduled[0]?.immediate, true);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    reviewRead.release();
    app.stop();
    dom.window.close();
  }
});

test("does not hide an already-rendered diff when Viewed is removed", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = fileElement.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.setAttribute("aria-label", "Viewed");
    officialControl.setAttribute("aria-pressed", "true");
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Not Viewed");
      officialControl.setAttribute("aria-pressed", "false");
    });

    officialControl.click();

    assert.equal(app.controllersByRow.size, 2);
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    assert.equal(
      fileElement.classList.contains("hunkmark-file-reveal-restoring"),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("hides Load Diff content until review controls are ready", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  const reviewRead = delayReviewStorageRead(app);
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    installContentStyles(dom);
    const loadedFixture = new JSDOM(loadDiffFixture({ loaded: true }));
    const loadedFileHtml =
      loadedFixture.window.document.querySelector(".js-file").outerHTML;
    loadedFixture.window.close();
    const cachedDiscoveryRoots = recordCachedDiscoveryRoots(app);
    const loadButton = fileElement.querySelector("button");
    loadButton.addEventListener("click", () => {
      loadButton.insertAdjacentHTML(
        "beforebegin",
        '<span data-component="loadingSpinner"><span data-component="Spinner">Loading</span></span>',
      );
      loadButton.remove();
      dom.window.setTimeout(() => {
        const replacementTemplate = dom.window.document.createElement(
          "template",
        );
        replacementTemplate.innerHTML = loadedFileHtml;
        fileElement.replaceWith(replacementTemplate.content.firstElementChild);
      }, 0);
    });

    loadButton.click();

    const officialLoader = fileElement.querySelector(
      '[data-component="Spinner"]',
    );
    const loadingSkeleton = fileElement.querySelector(".loading-skeleton");
    const loadingMessage = fileElement.querySelector(".load-diff-message");
    assert.equal(
      dom.window.getComputedStyle(officialLoader).display === "none",
      false,
    );
    assert.equal(
      dom.window.getComputedStyle(loadingSkeleton).display === "none",
      false,
    );
    assert.equal(
      dom.window.getComputedStyle(loadingMessage).display === "none",
      false,
    );
    let replacementFileElement;
    await waitFor(() => {
      replacementFileElement = dom.window.document.querySelector(".js-file");
      assert.notEqual(replacementFileElement, fileElement);
      const table = replacementFileElement.querySelector("table");
      const preservedLoader = replacementFileElement.querySelector(
        '[data-component="Spinner"]',
      );
      assert.ok(preservedLoader);
      assertFileRevealState(
        dom,
        replacementFileElement,
        table.parentElement,
        true,
      );
      assert.equal(
        dom.window.getComputedStyle(preservedLoader).display === "none",
        false,
      );
    });
    await reviewRead.started;
    assert.equal(app.controllersByRow.size, 1);
    assertFileRevealState(
      dom,
      replacementFileElement,
      replacementFileElement.querySelector("table").parentElement,
      true,
    );
    assert.equal(cachedDiscoveryRoots.length, 0);

    reviewRead.release();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector("table").parentElement,
        false,
      );
      assert.equal(
        replacementFileElement.querySelector(
          '[data-hunkmark-ui="file-reveal-loading"]',
        ),
        null,
      );
      assert.equal(app.fileRevealRestorePending.size, 0);
    });
  } finally {
    reviewRead.release();
    app.stop();
    dom.window.close();
  }
});

test("shows Load Diff immediately after a hidden large diff is revealed", async (t) => {
  const cases = [
    {
      name: "file expansion",
      controlHtml: '<button aria-label="Expand file">Expand</button>',
      includeHiddenPlaceholder: true,
      reveal: (fileElement, control) => {
        control.setAttribute("aria-label", "Collapse file");
        fileElement.querySelector(".diff-body").hidden = false;
      },
    },
    {
      name: "official Viewed removal",
      controlHtml:
        '<button aria-label="Viewed" aria-pressed="true">Viewed</button>',
      reveal: (fileElement, control) => {
        setOfficialViewed(control, false);
        fileElement.insertAdjacentHTML(
          "beforeend",
          `<div class="diff-body">${loadDiffPlaceholderHtml()}</div>`,
        );
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(
        hiddenLargeDiffFixture(scenario.controlHtml, {
          includeHiddenPlaceholder: scenario.includeHiddenPlaceholder,
        }),
      );
      try {
        installContentStyles(dom);
        const fileElement = dom.window.document.querySelector(".js-file");
        const control = fileElement.querySelector("button");
        let readinessFrame = null;
        if (scenario.includeHiddenPlaceholder) {
          dom.window.requestAnimationFrame = (callback) => {
            readinessFrame = callback;
            return 1;
          };
          dom.window.cancelAnimationFrame = () => {
            readinessFrame = null;
          };
        }
        control.addEventListener("click", () => {
          scenario.reveal(fileElement, control);
        });

        control.click();
        const diffBody = fileElement.querySelector(".diff-body");
        assertFileRevealState(dom, fileElement, diffBody, true);
        if (scenario.includeHiddenPlaceholder) {
          assert.ok(readinessFrame);
          const callback = readinessFrame;
          readinessFrame = null;
          callback(dom.window.performance.now());
        }

        await waitFor(() => {
          assertFileRevealState(dom, fileElement, diffBody, false);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
        });
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("shows stable non-hunk content immediately after a file reveal", async (t) => {
  const cases = [
    {
      name: "file expansion",
      html: nonHunkDiffFixture(
        '<button aria-label="Expand file">Expand</button>',
        { hidden: true },
      ),
      reveal: (fileElement, control) => {
        control.setAttribute("aria-label", "Collapse file");
        fileElement.querySelector(".diff-body").hidden = false;
      },
    },
    {
      name: "official Viewed removal",
      html: initiallyViewedCommitSelectionFixture(),
      reveal: (fileElement, control) => {
        setOfficialViewed(control, false);
        fileElement.insertAdjacentHTML(
          "beforeend",
          '<div class="diff-body"><div class="binary-diff">Binary file not shown.</div></div>',
        );
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(scenario.html);
      try {
        installContentStyles(dom);
        const fileElement = dom.window.document.querySelector(".js-file");
        const control = fileElement.querySelector("button");
        control.addEventListener("click", () => {
          scenario.reveal(fileElement, control);
        });

        control.click();

        const diffBody = fileElement.querySelector(".diff-body");
        assertFileRevealState(dom, fileElement, diffBody, true);
        await waitFor(() => {
          assertFileRevealState(dom, fileElement, diffBody, false);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
        });
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("cancels a cold-cache visibility expectation when key generation fails", async () => {
  const { app, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    app.officialViewedSuppressionKey = async () => {
      throw new Error("identifier generation failed");
    };

    dom.window.document
      .querySelector('button[aria-label="Viewed"]')
      .click();

    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(app.fileDiffVisibilityPending.size, 0);
      assert.equal(app.fileRevealPrepaintRestores.size, 0);
      assert.equal(
        dom.window.document
          .querySelector(".js-file")
          .classList.contains("hunkmark-file-reveal-restoring"),
        false,
      );
    });
    assert.equal(
      app.officialViewedStorageIntentGenerationByKey.size,
      0,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("rolls back a manual Not Viewed intent when storage fails", async () => {
  const { app, chrome, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  try {
    const {
      control: officialControl,
      key,
    } = await officialFileContext(app, dom);
    const warnings = captureWarnings(dom);
    respondToOfficialClicks(officialControl, false);

    chrome.failNextSet();
    officialControl.click();
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(app.officialViewedRestoreGuards.has(key), true);

    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(app.fileDiffVisibilityPending.size, 0);
      assert.equal(app.officialViewedRestoreGuards.size, 0);
    });
    assert.equal(app.officialViewedSyncSuppressed.has(key), false);
    assertOfficialIntentSettled(app, key);
    assert.equal(key in chrome.snapshot(), false);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("restores persisted suppression when manual Viewed removal fails", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    const { control, key } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);
    const warnings = captureWarnings(dom);
    respondToOfficialClicks(control, true);

    chrome.failNextRemove();
    control.click();

    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(app.fileDiffVisibilityPending.size, 0);
    });
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(chrome.snapshot()[key]?.suppressed, true);
    assertOfficialIntentSettled(app, key);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("restores a preceding tab's committed intent after a queued write fails", async () => {
  const extension = await startLockedExtension();
  const {
    app,
    chrome: sharedChrome,
    dom,
    locks: sharedLocks,
  } = extension;
  let holder;
  try {
    const {
      controller,
      key,
      scope: suppressionScope,
    } = officialViewedContext(app);
    const initialRequestCount = sharedLocks.requests.length;
    holder = holdReviewStorageLock(app, sharedLocks);
    await holder.started;

    const intentPromise = app.recordManualOfficialViewedIntent({
      filePath: controller.filePath,
      knownKey: key,
      suppressionScope,
      suppressed: true,
    });
    const rejectedIntent = assert.rejects(
      intentPromise,
      /storage write failed/,
    );
    await waitFor(() => {
      assert.equal(
        sharedLocks.requests.length,
        initialRequestCount + 2,
      );
    });

    const updatedAt = Date.now();
    await sharedChrome.api.storage.local.set({
      [key]: { suppressed: true, updatedAt },
    });
    sharedChrome.failNextSet();
    holder.release();
    await holder.promise;
    await rejectedIntent;

    assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assertOfficialIntentSettled(app, key);
  } finally {
    holder?.release();
    stopExtensions(extension);
  }
});

test("keeps a queued Not Viewed intent ahead of an older storage removal", async () => {
  const extension = await startLockedExtension();
  const {
    app,
    chrome: sharedChrome,
    locks: sharedLocks,
  } = extension;
  const allowOlderRemoval = createDeferred();
  const olderRemovalFinished = createDeferred();
  const releaseOlderLock = createDeferred();
  try {
    const { control, controllers, key } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);
    controllers.forEach((controller) => {
      controller.marked = true;
    });

    const olderLockHeld = createDeferred();
    const olderTransaction = sharedLocks.request(
      app.reviewStorageLockName(),
      { mode: "exclusive" },
      async () => {
        olderLockHeld.resolve();
        await allowOlderRemoval.promise;
        await app.removeReviewStorageUnlocked([key]);
        olderRemovalFinished.resolve();
        await releaseOlderLock.promise;
      },
    );
    await olderLockHeld.promise;

    setOfficialViewed(control, true);
    const getOfficialClicks = respondToOfficialClicks(control, "toggle");
    control.click();
    assert.equal(getOfficialClicks(), 1);
    assert.equal(control.getAttribute("aria-pressed"), "false");
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(
      Number.isInteger(
        app.officialViewedStorageIntentGenerationByKey.get(key),
      ),
      true,
    );

    allowOlderRemoval.resolve();
    await olderRemovalFinished.promise;
    assert.equal(key in sharedChrome.snapshot(), false);
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);

    app.syncOfficialViewedForControllers(controllers);
    assert.equal(getOfficialClicks(), 1);
    assert.equal(control.getAttribute("aria-pressed"), "false");

    releaseOlderLock.resolve();
    await olderTransaction;
    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assertOfficialIntentSettled(app, key);
    });
  } finally {
    allowOlderRemoval.resolve();
    releaseOlderLock.resolve();
    stopExtensions(extension);
  }
});

test("accepts the next tab's storage intent after the local lock callback", async () => {
  const shared = await startSharedExtensions(commitSelectionFixture());
  const {
    chrome: sharedChrome,
    first: tabA,
    locks: sharedLocks,
    second: tabB,
  } = shared;
  const tabAWriteGate = createDeferred();
  try {
    const {
      controller: controllerA,
      key,
      scope: suppressionScope,
    } = officialViewedContext(tabA.app);
    const { controller: controllerB } =
      officialViewedContext(tabB.app);
    assert.equal(controllerB.officialSuppressionKey, key);

    const tabAWriteFinished = createDeferred();
    const setReviewStorageUnlocked =
      tabA.app.setReviewStorageUnlocked.bind(tabA.app);
    tabA.app.setReviewStorageUnlocked = async (...args) => {
      await setReviewStorageUnlocked(...args);
      tabAWriteFinished.resolve();
      await tabAWriteGate.promise;
    };

    const tabAIntent = tabA.app.recordManualOfficialViewedIntent({
      filePath: controllerA.filePath,
      knownKey: key,
      suppressionScope,
      suppressed: true,
    });
    await tabAWriteFinished.promise;
    assert.equal(tabA.app.officialViewedSyncSuppressed.has(key), true);

    const tabBIntent = tabB.app.recordManualOfficialViewedIntent({
      filePath: controllerB.filePath,
      knownKey: key,
      suppressionScope,
      suppressed: false,
    });
    assert.equal(tabB.app.officialViewedSyncSuppressed.has(key), false);

    tabAWriteGate.resolve();
    const [{ generation: generationA }, { generation: generationB }] =
      await Promise.all([tabAIntent, tabBIntent]);

    assert.equal(key in sharedChrome.snapshot(), false);
    assert.equal(tabA.app.officialViewedSyncSuppressed.has(key), false);
    assert.equal(tabB.app.officialViewedSyncSuppressed.has(key), false);
    assert.equal(
      tabA.app.officialViewedStorageIntentGenerationByKey.has(key),
      false,
    );
    assert.equal(
      tabB.app.officialViewedStorageIntentGenerationByKey.has(key),
      false,
    );
    tabA.app.settleOfficialViewedIntent(
      key,
      generationA,
      suppressionScope,
    );
    tabB.app.settleOfficialViewedIntent(
      key,
      generationB,
      suppressionScope,
    );
  } finally {
    tabAWriteGate.resolve();
    stopExtensions(tabB, tabA);
  }
});

test("orders a hunk review clear before a newer tab's Not Viewed intent", async () => {
  const shared = await startSharedExtensions(commitSelectionFixture());
  const {
    chrome: sharedChrome,
    first: tabA,
    locks: sharedLocks,
    second: tabB,
  } = shared;
  let holder;
  try {
    const {
      controller: controllerA,
      key,
    } = officialViewedContext(tabA.app);
    const {
      control: controlB,
      controller: controllerB,
    } = officialViewedContext(tabB.app);
    assert.equal(controllerB.officialSuppressionKey, key);
    await seedSharedOfficialSuppression(tabA, tabB, key);

    const initialRequestCount = sharedLocks.requests.length;
    holder = holdReviewStorageLock(tabA.app, sharedLocks);
    await holder.started;

    changeCheckbox(tabA.dom, controllerA.input);
    await waitFor(() => {
      assert.equal(
        sharedLocks.requests.length,
        initialRequestCount + 2,
      );
    });

    setOfficialViewed(controlB, true);
    respondToOfficialClicks(controlB, false);
    controlB.click();
    await waitFor(() => {
      assert.equal(
        sharedLocks.requests.length,
        initialRequestCount + 3,
      );
    });

    holder.release();
    await holder.promise;
    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assert.equal(
        tabA.app.officialViewedSyncSuppressed.has(key),
        true,
      );
      assert.equal(
        tabB.app.officialViewedSyncSuppressed.has(key),
        true,
      );
      assert.equal(controllerA.input.disabled, false);
    });
  } finally {
    holder?.release();
    stopExtensions(tabB, tabA);
  }
});

test("keeps suppression when the preceding hunk review write fails", async () => {
  const extension = await startExtension(commitSelectionFixture());
  const { app, chrome, dom } = extension;
  try {
    const { controller, key } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);
    const warnings = captureWarnings(dom);

    chrome.failNextSet();
    changeCheckbox(dom, controller.input);

    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
      assert.equal(chrome.snapshot()[key]?.suppressed, true);
      assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    });
  } finally {
    stopExtensions(extension);
  }
});

test("syncs official Viewed before failed release-marker cleanup settles", async () => {
  const extension = await startExtension(commitSelectionFixture());
  const { app, chrome, dom } = extension;
  const cleanupGate = createDeferred();
  try {
    const {
      control,
      controllers,
      key,
    } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);
    await app.setHunkViewed(controllers[0], true);
    await waitFor(() => {
      assert.equal(key in chrome.snapshot(), false);
    });

    const removeReviewStorageUnlocked =
      app.removeReviewStorageUnlocked.bind(app);
    let cleanupStarted = false;
    let failCleanup = true;
    app.removeReviewStorageUnlocked = async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (
        failCleanup &&
        list.includes(key) &&
        chrome.snapshot()[key] === null
      ) {
        failCleanup = false;
        cleanupStarted = true;
        await cleanupGate.promise;
        throw new Error("release marker cleanup failed");
      }
      return removeReviewStorageUnlocked(keys);
    };
    const warnings = captureWarnings(dom);
    const getOfficialClicks = respondToOfficialClicks(control, true);

    await app.setHunkViewed(controllers[1], true);
    await waitFor(() => {
      assert.equal(cleanupStarted, true);
    });

    assert.equal(getOfficialClicks(), 1);
    assert.equal(control.getAttribute("aria-pressed"), "true");
    assert.equal(chrome.snapshot()[key], null);
    const stored = chrome.snapshot();
    assert.equal(controllers.every((controller) => controller.marked), true);
    assert.equal(
      controllers.every((controller) =>
        controller.lines.every((line) => Boolean(stored[line.key])),
      ),
      true,
    );
    assert.equal(stored[key], null);
    assert.equal(app.officialViewedSyncSuppressed.has(key), false);

    cleanupGate.resolve();
    await waitFor(() => {
      assert.equal(
        warnings[0]?.[0],
        "HunkMark could not discard an official Viewed release marker.",
      );
    });
    assert.equal(chrome.snapshot()[key], null);
  } finally {
    cleanupGate.resolve();
    stopExtensions(extension);
  }
});

test("keeps a newer tab's review after an older hunk write fails", async () => {
  const shared = await startSharedExtensions(duplicateHunkFixture());
  const {
    chrome: sharedChrome,
    first: tabA,
    locks: sharedLocks,
    second: tabB,
  } = shared;
  let holder;
  let writeA = null;
  let writeB = null;
  try {
    const controllerA = controllerAt(tabA.app);
    const controllerB = controllerAt(tabB.app);
    assert.equal(controllerA.lines[0].key, controllerB.lines[0].key);

    holder = holdReviewStorageLock(tabA.app, sharedLocks);
    await holder.started;
    const warnings = captureWarnings(tabA.dom);

    writeA = tabA.app.setHunkViewed(controllerA, true);
    writeB = tabB.app.setHunkViewed(controllerB, true);
    sharedChrome.failNextSet("older tab write failed");

    holder.release();
    await holder.promise;
    await Promise.all([writeA, writeB]);

    assert.equal(warnings.length, 1);
    assert.equal(controllerA.marked, true);
    assert.equal(controllerB.marked, true);
    assert.equal(controllerA.lines.every((line) => line.marked), true);
    assert.equal(controllerB.lines.every((line) => line.marked), true);
    assert.ok(sharedChrome.snapshot()[controllerA.lines[0].key]);
    assert.equal(controllerA.input.disabled, false);
  } finally {
    holder?.release();
    await Promise.allSettled([writeA, writeB].filter(Boolean));
    stopExtensions(tabB, tabA);
  }
});

[
  {
    name: "does not sync official Viewed before a concurrent hunk write rolls back",
    failureMessage: "second concurrent hunk write failed",
    startSecondWrite({ controllers, dom }) {
      changeCheckbox(dom, controllers[1].input);
    },
    assertFinal({ controllers, getOfficialClicks, officialControl, warnings }) {
      assert.equal(warnings.length, 1);
      assert.equal(controllers[0].marked, true);
      assert.equal(controllers[1].marked, false);
      assert.equal(getOfficialClicks(), 0);
      assert.equal(officialControl.getAttribute("aria-pressed"), "false");
    },
  },
  {
    name: "waits for a concurrent line write before syncing official Viewed",
    startSecondWrite({ controllers }) {
      controllers[1].lines[0].control.click();
    },
    assertFinal({ controllers, getOfficialClicks, officialControl }) {
      assert.equal(controllers.every((controller) => controller.marked), true);
      assert.equal(getOfficialClicks(), 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    },
  },
  {
    name: "waits for a concurrent drag write before syncing official Viewed",
    startSecondWrite({ app, controllers }) {
      app.startLineDrag(controllers[1].lines[0], true, 91);
      return app.finishLineDrag(true);
    },
    assertFinal({ controllers, getOfficialClicks, officialControl }) {
      assert.equal(controllers.every((controller) => controller.marked), true);
      assert.equal(getOfficialClicks(), 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    },
  },
].forEach(({ assertFinal, failureMessage, name, startSecondWrite }) => {
  test(name, async () => {
    const extension = await startLockedExtension();
    const { app, dom, locks } = extension;
    let delayedWrite;
    let holder;
    let secondWrite;
    try {
      const {
        control: officialControl,
        controllers,
        key,
      } = officialViewedContext(app);
      await seedOfficialSuppression(app, key);

      holder = holdReviewStorageLock(app, locks);
      await holder.started;
      delayedWrite = delayReviewStorageSet(app, 2, { failureMessage });
      const warnings = captureWarnings(dom);
      const getOfficialClicks =
        respondToOfficialClicks(officialControl, true);

      changeCheckbox(dom, controllers[0].input);
      secondWrite = startSecondWrite({ app, controllers, dom });
      assert.equal(app.officialViewedReviewPendingByKey.get(key), 2);

      holder.release();
      await holder.promise;
      await delayedWrite.started;
      await waitFor(() => {
        assert.equal(app.officialViewedReviewPendingByKey.get(key), 1);
        assert.equal(getOfficialClicks(), 0);
      });

      delayedWrite.release();
      await secondWrite;
      await waitFor(() => {
        assertFinal({
          controllers,
          getOfficialClicks,
          officialControl,
          warnings,
        });
        assert.equal(
          app.officialViewedReviewPendingByKey.has(key),
          false,
        );
      });
    } finally {
      holder?.release();
      delayedWrite?.release();
      await secondWrite?.catch(() => undefined);
      stopExtensions(extension);
    }
  });
});

test("keeps review persistence gates across route-state resets", async () => {
  const extension = await startExtension(commitSelectionFixture());
  const { app } = extension;
  try {
    const { controllers, key } = officialViewedContext(app);
    const firstKeys =
      app.beginOfficialViewedReviewPersistence([controllers[0]]);
    assert.equal(
      app.officialViewedReviewPendingByKey.get(key),
      1,
    );

    app.resetOfficialViewedState();
    assert.equal(
      app.officialViewedReviewPendingByKey.get(key),
      1,
    );

    const secondKeys =
      app.beginOfficialViewedReviewPersistence([controllers[1]]);
    assert.equal(
      app.officialViewedReviewPendingByKey.get(key),
      2,
    );
    app.endOfficialViewedReviewPersistence(firstKeys);
    assert.equal(
      app.officialViewedReviewPendingByKey.get(key),
      1,
    );
    app.endOfficialViewedReviewPersistence(secondKeys);
    assert.equal(
      app.officialViewedReviewPendingByKey.has(key),
      false,
    );
  } finally {
    stopExtensions(extension);
  }
});

test("does not let page reset erase a newer manual Not Viewed intent", async () => {
  const extension = await startLockedExtension();
  const { app, chrome: sharedChrome, dom } = extension;
  const resetReadStarted = createDeferred();
  const resetReadGate = createDeferred();
  try {
    const {
      control: officialControl,
      key,
    } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);

    const getLocalStorage = app.getLocalStorage.bind(app);
    let gateNextResetRead = true;
    app.getLocalStorage = async (keys) => {
      if (gateNextResetRead && keys === null) {
        gateNextResetRead = false;
        resetReadStarted.resolve();
        await resetReadGate.promise;
      }
      return getLocalStorage(keys);
    };

    const resetButton = { disabled: false };
    const resetPromise = app.resetCurrentPage(resetButton);
    await resetReadStarted.promise;

    setOfficialViewed(officialControl, true);
    respondToOfficialClicks(officialControl, false);
    officialControl.click();
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);

    resetReadGate.resolve();
    await resetPromise;
    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assert.equal(app.officialViewedSyncSuppressed.has(key), true);
      assert.equal(
        app.officialViewedStorageIntentGenerationByKey.has(key),
        false,
      );
    });
  } finally {
    resetReadGate.resolve();
    stopExtensions(extension);
  }
});

test("does not apply a stale refresh over a newer manual Viewed intent", async () => {
  const url = "https://github.com/octo/repo/pull/123/files";
  const scope = Core.parseReviewScope(new URL(url));
  const suppressionScope = Core.reviewStateScope(
    scope,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const key = await Core.officialSyncSuppressionKey(
    suppressionScope,
    "src/selection.js",
  );
  const extension = await startLockedExtension(
    commitSelectionFixture(),
    {
      [key]: { suppressed: true, updatedAt: Date.now() },
    },
    {
      url,
      waitForScope: false,
    },
  );
  const { app, chrome: sharedChrome, dom } = extension;
  const refreshReadStarted = createDeferred();
  const refreshReadGate = createDeferred();
  try {
    const getLocalStorage = app.getLocalStorage.bind(app);
    let gateControllerRead = true;
    app.getLocalStorage = async (keys) => {
      const stored = await getLocalStorage(keys);
      if (
        gateControllerRead &&
        Array.isArray(keys) &&
        keys.includes(key)
      ) {
        gateControllerRead = false;
        refreshReadStarted.resolve();
        await refreshReadGate.promise;
      }
      return stored;
    };

    await refreshReadStarted.promise;
    const { control: officialControl } = officialViewedContext(app);
    respondToOfficialClicks(officialControl, true);
    officialControl.click();
    assert.equal(app.officialViewedSyncSuppressed.has(key), false);

    refreshReadGate.resolve();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(key in sharedChrome.snapshot(), false);
      assert.equal(app.officialViewedSyncSuppressed.has(key), false);
      assert.equal(
        app.officialViewedStorageIntentGenerationByKey.has(key),
        false,
      );
    });
  } finally {
    refreshReadGate.resolve();
    stopExtensions(extension);
  }
});

test("does not couple manual intent persistence to retention pruning", async () => {
  const { app, chrome, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  try {
    const {
      filePath,
      key,
      scope: suppressionScope,
    } = await officialFileContext(app, dom);
    const setReviewStorageUnlocked =
      app.setReviewStorageUnlocked.bind(app);
    let intentPruneOption = null;
    app.setReviewStorageUnlocked = async (...args) => {
      intentPruneOption = args[3];
      await setReviewStorageUnlocked(...args);
      if (intentPruneOption?.prune !== false) {
        throw new Error("retention prune failed after intent persistence");
      }
    };

    const { generation } = await app.recordManualOfficialViewedIntent({
      filePath,
      knownKey: key,
      suppressionScope,
      suppressed: true,
    });

    assert.equal(intentPruneOption?.prune, false);
    assert.equal(chrome.snapshot()[key]?.suppressed, true);
    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(
      app.officialViewedStorageIntentGenerationByKey.has(key),
      false,
    );
    app.settleOfficialViewedIntent(
      key,
      generation,
      suppressionScope,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("refreshes immediately when HunkMark Viewed sync hides the diff", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = fileElement.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
      fileElement.querySelector("table")?.remove();
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(
        dom.window.document.getElementById(app.constants.PANEL_ID),
        null,
      );
    });
    assert.equal(
      scheduled.some(({ immediate }) => immediate === true),
      true,
    );
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps unrelated host diff mutations debounced", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const hostUpdate = dom.window.document.createElement("span");
    hostUpdate.textContent = "GitHub host update";
    dom.window.document.querySelector(".blob-code-hunk").append(hostUpdate);

    await waitFor(() => {
      assert.equal(scheduled.length > 0, true);
    });
    assert.equal(
      scheduled.some(({ immediate }) => immediate === true),
      false,
    );
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("distinguishes a manual official Viewed removal from a host reset", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
    });

    controllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });

    officialControl.click();
    const suppressionKey = await app.officialViewedSuppressionKey(
      controllers[0].filePath,
    );
    await waitFor(() => {
      assert.equal(officialClicks, 2);
      assert.equal(officialControl.getAttribute("aria-pressed"), "false");
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), true);
    });

    app.syncOfficialViewedForControllers(controllers);
    assert.equal(officialClicks, 2);

    controllers[0].input.checked = false;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controllers[0].input.disabled, false);
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
    });
    controllers[0].input.checked = true;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 3);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps only the latest rapid manual Viewed intent", async () => {
  const { app, chrome, dom } = await startExtension(
    commitSelectionFixture(),
  );
  const originalWindowSetTimeout = dom.window.setTimeout.bind(dom.window);
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const {
      control: officialControl,
      key: suppressionKey,
    } = officialViewedContext(app);
    respondToOfficialClicks(officialControl, "toggle");
    dom.window.setTimeout = (callback, delay, ...args) =>
      originalWindowSetTimeout(
        callback,
        delay === 100 ? 0 : delay,
        ...args,
      );

    officialControl.click();
    officialControl.click();

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(officialControl.getAttribute("aria-pressed"), "false");
    assert.equal(
      app.officialViewedSyncSuppressed.has(suppressionKey),
      true,
    );
    const persistedSuppression = chrome.snapshot()[suppressionKey];
    assert.equal(persistedSuppression.suppressed, true);
    assert.equal(Number.isFinite(persistedSuppression.updatedAt), true);
    assert.equal(
      app.officialViewedReconcileGenerationByKey.has(suppressionKey),
      false,
    );
  } finally {
    dom.window.setTimeout = originalWindowSetTimeout;
    stopExtensions({ app, dom });
  }
});

test("keeps a newer restore guard when an older manual intent fails", async () => {
  const extension = await startLockedExtension();
  const {
    app,
    chrome: sharedChrome,
    dom,
    locks: sharedLocks,
  } = extension;
  let holder;
  try {
    const {
      control: officialControl,
      key,
    } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);

    const initialRequestCount = sharedLocks.requests.length;
    holder = holdReviewStorageLock(app, sharedLocks);
    await holder.started;

    const warnings = captureWarnings(dom);
    respondToOfficialClicks(officialControl, "toggle");

    officialControl.click();
    officialControl.click();
    assert.equal(app.officialViewedRestoreGuards.has(key), true);
    await waitFor(() => {
      assert.equal(
        sharedLocks.requests.length,
        initialRequestCount + 3,
      );
    });

    sharedChrome.failNextRemove();
    holder.release();
    await holder.promise;
    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
    });

    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(app.officialViewedRestoreGuards.has(key), true);
  } finally {
    holder?.release();
    stopExtensions(extension);
  }
});

test("preserves a newer tab's Not Viewed intent after an older reconciliation", async () => {
  const shared = await startSharedExtensions(commitSelectionFixture());
  const {
    chrome: sharedChrome,
    first: tabA,
    second: tabB,
  } = shared;
  try {
    const {
      control: controlA,
      controller: controllerA,
      key,
      scope: suppressionScope,
    } = officialViewedContext(tabA.app);
    const {
      control: controlB,
      controller: controllerB,
    } = officialViewedContext(tabB.app);
    assert.equal(controllerB.officialSuppressionKey, key);

    await seedSharedOfficialSuppression(tabA, tabB, key);
    controlA.setAttribute("data-loading", "true");
    respondToOfficialClicks(controlA, true);
    controlA.click();

    let generationA;
    await waitFor(() => {
      generationA =
        tabA.app.officialViewedReconcileGenerationByKey.get(key);
      assert.equal(Number.isInteger(generationA), true);
      assert.equal(key in sharedChrome.snapshot(), false);
    });

    setOfficialViewed(controlB, true);
    respondToOfficialClicks(controlB, false);
    controlB.click();

    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assert.equal(
        tabB.app.officialViewedReconcileGenerationByKey.has(key),
        false,
      );
    });

    tabA.app.reconcileOfficialViewedAfterClick(
      key,
      controllerA.fileElement,
      false,
      generationA,
      suppressionScope,
      20,
    );

    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assert.equal(
        tabA.app.officialViewedReconcileGenerationByKey.has(key),
        false,
      );
      assert.equal(
        tabA.app.officialViewedSyncSuppressed.has(key),
        true,
      );
    });
  } finally {
    stopExtensions(tabB, tabA);
  }
});

test("preserves a newer tab's Not Viewed intent after an older host observation", async () => {
  const shared = await startSharedExtensions(commitSelectionFixture());
  const {
    chrome: sharedChrome,
    first: tabA,
    second: tabB,
  } = shared;
  try {
    const {
      control: controlA,
      controllers: controllersA,
      key,
    } = officialViewedContext(tabA.app);
    const {
      control: controlB,
      controller: controllerB,
    } = officialViewedContext(tabB.app);
    assert.equal(controllerB.officialSuppressionKey, key);
    tabA.app.syncOfficialViewedForControllers(controllersA);

    setOfficialViewed(controlB, true);
    respondToOfficialClicks(controlB, false);
    controlB.click();

    await waitFor(() => {
      assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
      assert.equal(
        tabA.app.officialViewedSyncSuppressed.has(key),
        true,
      );
    });

    setOfficialViewed(controlA, true);
    tabA.app.syncOfficialViewedForControllers(controllersA);
    await tabA.app.withReviewStorageLock(() => undefined);

    assert.equal(sharedChrome.snapshot()[key]?.suppressed, true);
    assert.equal(
      tabA.app.officialViewedSyncSuppressed.has(key),
      true,
    );
  } finally {
    stopExtensions(tabB, tabA);
  }
});

test("keeps cleared suppression when Viewed reconciliation crosses a route change", async () => {
  const extension = await startExtension(commitSelectionFixture());
  const { app, chrome, dom } = extension;
  try {
    const {
      control: officialControl,
      fileElement,
      key,
      scope: suppressionScope,
    } = officialViewedContext(app);
    await seedOfficialSuppression(app, key);
    officialControl.setAttribute("data-loading", "true");
    respondToOfficialClicks(officialControl, true);

    officialControl.click();
    let generation;
    await waitFor(() => {
      generation =
        app.officialViewedReconcileGenerationByKey.get(key);
      assert.equal(Number.isInteger(generation), true);
      assert.equal(key in chrome.snapshot(), false);
    });

    dom.window.history.pushState(
      {},
      "",
      "/octo/repo/pull/124/files",
    );
    app.resetOfficialViewedState();
    app.reconcileOfficialViewedAfterClick(
      key,
      fileElement,
      false,
      generation,
      suppressionScope,
      20,
    );

    await waitFor(() => {
      assert.equal(
        app.officialViewedReconcileGenerationByKey.has(key),
        false,
      );
      assert.equal(app.officialViewedSyncSuppressed.has(key), false);
      assert.equal(key in chrome.snapshot(), false);
    });
  } finally {
    stopExtensions(extension);
  }
});

test("persists a cold-cache Not Viewed intent to its original route", async () => {
  const { app, chrome, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  const keyGenerationStarted = createDeferred();
  const keyGenerationGate = createDeferred();
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const filePath = app.resolveFilePath(fileElement, 0);
    const suppressionScope = app.officialViewedSuppressionScope();
    assert.equal(
      app.Core.cachedOfficialSyncSuppressionKey(
        suppressionScope,
        filePath,
      ),
      null,
    );

    const generateSuppressionKey =
      app.officialViewedSuppressionKey.bind(app);
    app.officialViewedSuppressionKey = async (path, scope) => {
      keyGenerationStarted.resolve();
      await keyGenerationGate.promise;
      return generateSuppressionKey(path, scope);
    };

    const officialControl = fileElement.querySelector(
      'button[aria-label="Viewed"]',
    );
    respondToOfficialClicks(officialControl, false);

    officialControl.click();
    await keyGenerationStarted.promise;
    dom.window.history.pushState(
      {},
      "",
      "/octo/repo/pull/124/files",
    );
    app.resetOfficialViewedState();
    keyGenerationGate.resolve();

    const key = await generateSuppressionKey(
      filePath,
      suppressionScope,
    );
    const originalMetadataKey =
      await app.Core.reviewContextMetadataKey(suppressionScope);
    const newSuppressionScope = app.Core.reviewStateScope(
      app.Core.parseReviewScope(dom.window.location),
      app.Core.ALL_COMMITS_REVIEW_VARIANT,
    );
    const newMetadataKey =
      await app.Core.reviewContextMetadataKey(newSuppressionScope);

    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(stored[key]?.suppressed, true);
      assert.equal(Number.isFinite(stored[key]?.updatedAt), true);
      assert.equal(Boolean(stored[originalMetadataKey]), true);
      assert.equal(newMetadataKey in stored, false);
      assert.equal(
        app.officialViewedReconcileGenerationByKey.has(key),
        false,
      );
      assert.equal(app.officialViewedSyncSuppressed.has(key), false);
    });
  } finally {
    keyGenerationGate.resolve();
    stopExtensions({ app, dom });
  }
});

test("restores collapsed hunks before paint after GitHub removes its diff body", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
      if (viewed) {
        fileElement.querySelector("table")?.remove();
      } else {
        fileElement.insertAdjacentHTML("beforeend", cleanTable);
      }
    });

    const initialControllers = Array.from(
      app.controllersByRow.values(),
    );
    const suppressionKey =
      initialControllers[0].officialSuppressionKey;
    initialControllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.collapsed,
        ),
        true,
      );
    });
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(fileElement.querySelector("table"), null);
    });

    const immediateRefreshesBeforeRestore = scheduled.filter(
      ({ immediate }) => immediate === true,
    ).length;
    officialControl.click();
    assert.equal(
      app.officialViewedRestoreGuards.has(suppressionKey),
      true,
    );
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const rows = Array.from(dom.window.document.querySelectorAll("tbody tr"));
    assert.equal(rows.length, 4);
    assert.equal(rows[1].classList.contains("hunkmark-collapsed"), true);
    assert.equal(rows[3].classList.contains("hunkmark-collapsed"), true);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.collapsed,
        ),
        true,
      );
      assert.equal(app.officialViewedRestoreGuards.size, 0);
    });
    assert.equal(
      scheduled.filter(({ immediate }) => immediate === true).length >
        immediateRefreshesBeforeRestore,
      true,
    );
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores cached controls before paint when GitHub expands a Viewed file", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
      fileElement.querySelector("table")?.remove();
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(fileElement.querySelector("table"), null);
    });

    fileElement.insertAdjacentHTML("beforeend", cleanTable);
    await Promise.resolve();

    const rows = Array.from(fileElement.querySelectorAll("tbody tr"));
    assert.equal(rows.length, 4);
    assert.equal(rows[1].classList.contains("hunkmark-collapsed"), true);
    assert.equal(rows[3].classList.contains("hunkmark-collapsed"), true);
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-hunk-actions").length,
      2,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );
    assert.match(
      fileElement.querySelector(".hunkmark-file-progress").textContent,
      /Hunks 2\/2 · Lines 2\/2/,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("synchronizes modern file progress with expand and collapse before paint", async () => {
  const { app, dom } = await startExtension(modernGridFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    const fileElement = controller.fileElement;
    const fileToggle = fileElement.querySelector(
      'button[aria-labelledby="modern-file-toggle-label"]',
    );
    const fileToggleLabel = fileElement.querySelector(
      "#modern-file-toggle-label",
    );
    installContentStyles(dom);
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const cleanFixture = new JSDOM(modernGridFixture());
    const rowsHtml = Array.from(
      cleanFixture.window.document.querySelectorAll('[role="row"]'),
      (row) => row.outerHTML,
    ).join("");
    cleanFixture.window.close();
    fileToggle.addEventListener("click", () => {
      if (fileToggleLabel.textContent === "Collapse file") {
        fileToggleLabel.textContent = "Expand file";
        fileElement
          .querySelectorAll('[role="row"]')
          .forEach((row) => row.remove());
        return;
      }
      fileToggleLabel.textContent = "Collapse file";
      fileElement
        .querySelector(".Diff-module__diffHeaderWrapper__VTI5w")
        .setAttribute("aria-busy", "true");
      fileElement.insertAdjacentHTML("beforeend", rowsHtml);
    });

    fileToggle.click();
    await Promise.resolve();

    assert.equal(fileElement.querySelector(".hunkmark-file-progress"), null);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(
        dom.window.document.getElementById(app.constants.PANEL_ID),
        null,
      );
    });
    assert.equal(
      scheduled.some(({ immediate }) => immediate === true),
      true,
    );
    assert.equal(app.fileDiffVisibilityPending.size, 0);

    const immediateRefreshesAfterCollapse = scheduled.filter(
      ({ immediate }) => immediate === true,
    ).length;
    const cachedDiscoveryRoots = recordCachedDiscoveryRoots(app);
    fileToggle.click();

    const expandedRow = fileElement.querySelector('[role="row"]');
    assertFileRevealState(dom, fileElement, expandedRow, true);
    await Promise.resolve();

    assert.equal(app.controllersByRow.size, 1);
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-hunk-actions").length,
      1,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );
    assert.match(
      fileElement.querySelector(".hunkmark-file-progress").textContent,
      /Hunks 0\/1 · Lines 0\/2/,
    );
    assert.equal(
      fileElement
        .querySelector(".Diff-module__diffHeaderWrapper__VTI5w")
        .getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      scheduled.filter(({ immediate }) => immediate === true).length,
      immediateRefreshesAfterCollapse,
    );
    assert.equal(cachedDiscoveryRoots.length > 0, true);
    assert.equal(
      cachedDiscoveryRoots.every((searchRoot) => searchRoot === fileElement),
      true,
    );
    assertFileRevealState(dom, fileElement, expandedRow, false);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores reviewed line backgrounds before rebuilding controllers", async () => {
  const autoCollapsePreferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
  const { app, dom } = await startExtension(
    commitSelectionFixture(),
    { [autoCollapsePreferenceKey]: false },
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(app.autoCollapseViewed, false);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let progressPresentWhenOfficialViewed = null;
    officialControl.addEventListener("click", () => {
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
      if (viewed) {
        progressPresentWhenOfficialViewed = Boolean(
          fileElement.querySelector(".hunkmark-file-progress"),
        );
        fileElement.querySelector("table")?.remove();
      } else {
        fileElement.insertAdjacentHTML("beforeend", cleanTable);
      }
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
      assert.equal(app.controllersByRow.size, 0);
    });
    assert.equal(progressPresentWhenOfficialViewed, false);
    assert.equal(fileElement.querySelector(".hunkmark-file-progress"), null);

    officialControl.click();
    await Promise.resolve();

    const restoredLines = Array.from(
      fileElement.querySelectorAll(".blob-code-addition"),
    );
    assert.equal(restoredLines.length, 2);
    assert.equal(
      restoredLines.every((line) =>
        line.classList.contains("hunkmark-line-viewed"),
      ),
      true,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      0,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-collapsed").length,
      0,
    );
    const progress = fileElement.querySelector(".hunkmark-file-progress");
    assert.ok(progress);
    assert.match(progress.textContent, /Hunks 2\/2 · Lines 2\/2/);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) =>
            !controller.collapsed &&
            controller.lines.every(
              (line) =>
                line.marked &&
                line.element.classList.contains("hunkmark-line-viewed"),
            ),
        ),
        true,
      );
      assert.equal(app.officialViewedRestoreGuards.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("respects a persisted manual official Viewed removal after reload", async () => {
  const reviewContext = "github.com:octo/repo:pull:123";
  const reviewScope = Core.reviewStateScope(
    reviewContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/selection.js";
  const suppressionKey = await Core.officialSyncSuppressionKey(
    reviewScope,
    filePath,
  );
  const now = Date.now();
  const initial = {
    [await Core.lineStorageKey(
      reviewScope,
      filePath,
      "addition",
      "+first",
    )]: {
      contextFingerprint: await lineReviewContextFingerprint({
        headerText: "@@ -1 +1 @@",
        blockSignature: "addition:unified:+first",
      }),
      viewedAt: now,
    },
    [await Core.lineStorageKey(
      reviewScope,
      filePath,
      "addition",
      "+second",
    )]: {
      contextFingerprint: await lineReviewContextFingerprint({
        headerText: "@@ -10 +10 @@",
        blockSignature: "addition:unified:+second",
      }),
      viewedAt: now,
    },
    [suppressionKey]: { suppressed: true, updatedAt: now },
    [await Core.reviewContextMetadataKey(reviewContext)]: {
      lastAccessedAt: now,
    },
  };
  const { app, chrome, dom } = await startExtension(
    commitSelectionFixture(),
    initial,
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.marked,
        ),
        true,
      );
      assert.equal(app.officialViewedSyncSuppressed.has(suppressionKey), true);
    });

    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    app.syncOfficialViewedForControllers(controllers);
    assert.equal(officialClicks, 0);

    controllers[0].input.checked = false;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
    });
    controllers[0].input.checked = true;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("auto-collapses a viewed hunk but allows expansion without unmarking", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );

    await waitFor(() => {
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, true);
      assert.equal(controller.collapseButton.textContent, "Expand");
    });
    assert.ok(chrome.snapshot()[controller.collapsedKey]);

    controller.collapseButton.click();
    await waitFor(() => {
      assert.equal(controller.collapsed, false);
      assert.equal(controller.marked, true);
      assert.equal(controller.input.checked, true);
      assert.equal(controller.collapsedKey in chrome.snapshot(), false);
    });

    controller.input.checked = false;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
      assert.equal(controller.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores saved review state after a page reload", async () => {
  const first = await startExtension(duplicateHunkFixture());
  let stored;
  try {
    await waitFor(() => {
      const controls = lineControls(first.dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });
    const control = lineControls(first.dom)[0];
    control.click();
    await waitFor(() => {
      assert.equal(control.disabled, false);
      assert.equal(control.getAttribute("aria-pressed"), "true");
    });
    stored = first.chrome.snapshot();
  } finally {
    first.app.stop();
    first.dom.window.close();
  }

  const second = await startExtension(duplicateHunkFixture(), stored);
  try {
    await waitFor(() => {
      const controls = lineControls(second.dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].getAttribute("aria-pressed"), "true");
      assert.equal(controls[1].getAttribute("aria-pressed"), "false");
      assert.equal(
        Array.from(second.app.controllersByRow.values())[0].collapsed,
        true,
      );
    });
  } finally {
    second.app.stop();
    second.dom.window.close();
  }
});

test("reattaches hunk controls when GitHub replaces a header cell", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
    const oldCell = dom.window.document.querySelector("td.blob-code-hunk");
    const replacement = oldCell.cloneNode(false);
    replacement.textContent = "@@ -1 +1 @@";
    oldCell.replaceWith(replacement);

    await waitFor(() => {
      assert.equal(replacement.querySelectorAll(".hunkmark-hunk-actions").length, 1);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("expands a viewed hunk when GitHub reveals surrounding context", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.collapsed, true);
      assert.ok(chrome.snapshot()[controller.collapsedKey]);
    });

    const contextRow = dom.window.document.createElement("tr");
    const contextCell = dom.window.document.createElement("td");
    contextCell.colSpan = 2;
    contextCell.textContent = "surrounding context";
    contextRow.append(contextCell);
    controller.hunkRow.after(contextRow);

    await waitFor(() => {
      assert.equal(app.controllersByRow.get(controller.hunkRow), controller);
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, false);
      assert.equal(contextRow.classList.contains("hunkmark-collapsed"), false);
      assert.equal(controller.collapsedKey in chrome.snapshot(), false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves viewed lines when GitHub merges expanded hunks", async () => {
  const { app, chrome, dom } = await startExtension(mergeableHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const before = Array.from(app.controllersByRow.values());
    const lineKeys = before.flatMap((controller) =>
      controller.lines.map((line) => line.key),
    );
    const collapsedKeys = before.map((controller) => controller.collapsedKey);

    before.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(before.every((controller) => controller.marked), true);
      assert.equal(before.every((controller) => controller.collapsed), true);
      assert.equal(
        collapsedKeys.every((key) => Boolean(chrome.snapshot()[key])),
        true,
      );
    });

    replaceMergeFixtureRows(dom.window.document, true);

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.equal(merged.hunkRow.isConnected, true);
      assert.equal(merged.marked, true);
      assert.equal(merged.indeterminate, false);
      assert.equal(merged.collapsed, false);
      assert.equal(merged.collapseButton.textContent, "Collapse");
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.key),
        lineKeys,
      );
      assert.equal(
        dom.window.document
          .querySelector("[data-test-context]")
          .classList.contains("hunkmark-collapsed"),
        false,
      );
      assert.equal(merged.collapsedKey in chrome.snapshot(), false);
      assert.equal(
        collapsedKeys.some((key) => key in chrome.snapshot()),
        false,
      );
    });
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 1 \/ 1 · Lines 2 \/ 2/,
    );

    merged.input.checked = false;
    merged.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(merged.marked, false);
      assert.equal(
        lineKeys.some((key) => key in chrome.snapshot()),
        false,
      );
    });

    replaceMergeFixtureRows(dom.window.document, false);
    await waitFor(() => {
      const split = Array.from(app.controllersByRow.values());
      assert.equal(split.length, 2);
      assert.equal(split.every((controller) => controller.hunkRow.isConnected), true);
      assert.equal(split.every((controller) => !controller.marked), true);
      assert.equal(split.every((controller) => !controller.collapsed), true);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps unchanged lines viewed after a commit and resets ambiguous duplicates", async () => {
  const { app, chrome, dom } = await startExtension(evolvingCommitFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
      assert.equal(before.input.disabled, false);
    });
    const stableKey = before.lines[0].key;
    const duplicateKeys = before.lines.slice(1).map((line) => line.key);
    assert.equal(duplicateKeys.every((key) => Boolean(chrome.snapshot()[key])), true);

    replacePageBody(dom, evolvingCommitFixture(true));

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.deepEqual(
        Array.from(after.lines, (line) => [line.text, line.marked]),
        [
          ["+stable", true],
          ["+new", false],
          ["+repeat", false],
          ["+repeat", false],
          ["+repeat", false],
        ],
      );
      assert.equal(after.lines[0].key, stableKey);
      assert.equal(
        after.lines
          .slice(2)
          .some((line) => duplicateKeys.includes(line.key)),
        false,
      );
      assert.equal(after.marked, false);
      assert.equal(after.indeterminate, true);
      assert.equal(after.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("resyncs official Viewed after a host reset without losing unchanged line state", async () => {
  const { app, chrome, dom } = await startExtension(
    evolvingCommitFixture(false, true),
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.input.disabled, false);
    });

    replacePageBody(dom, evolvingCommitFixture(true, false));

    let after;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.deepEqual(
        Array.from(after.lines, (line) => [line.text, line.marked]),
        [
          ["+stable", true],
          ["+new", false],
          ["+repeat", false],
          ["+repeat", false],
          ["+repeat", false],
        ],
      );
      assert.equal(after.indeterminate, true);
    });

    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    after.input.checked = true;
    after.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(after.marked, true);
      assert.equal(after.input.disabled, false);
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
    const suppressionKey =
      await app.officialViewedSuppressionKey(after.filePath);
    assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("fails closed when a reviewed line moves to a different context", async () => {
  const { app, chrome, dom } = await startExtension(
    contextualLineFixture({ before: "benign();", after: "log();" }),
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
      assert.ok(chrome.snapshot()[before.lines[0].key]);
    });

    const originalLineElement = before.lines[0].element;
    const contextCells = dom.window.document.querySelectorAll(
      ".blob-code-context",
    );
    dom.window.document.querySelector(".blob-code-hunk").textContent =
      "@@ -210,3 +210,4 @@ function checkAccess() {";
    contextCells[0].textContent = "if (isAdmin) {";
    contextCells[1].textContent = "audit();";

    await waitFor(() => {
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.equal(after.lines[0].element, originalLineElement);
      assert.equal(after.lines[0].key, before.lines[0].key);
      assert.notEqual(
        after.lines[0].contextFingerprint,
        before.lines[0].contextFingerprint,
      );
      assert.equal(after.marked, false);
      assert.equal(after.collapsed, false);
      assert.equal(
        chrome.snapshot()[after.lines[0].key].contextFingerprint,
        before.lines[0].contextFingerprint,
      );
      assert.ok(chrome.snapshot()[after.collapsedKey]);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves a newer tab's review state when a stale tab rerenders", async () => {
  const sharedChrome = createChromeApi();
  const sharedLocks = createExclusiveLockManager();
  const staleTab = await startExtension(
    contextualLineFixture({
      after: "log();",
      before: "benign();",
      officialControl: true,
    }),
    {},
    {
      chromeInstance: sharedChrome,
      lockManager: sharedLocks,
    },
  );
  let currentTab = null;
  try {
    const staleController = Array.from(
      staleTab.app.controllersByRow.values(),
    )[0];
    staleController.input.checked = true;
    staleController.input.dispatchEvent(
      new staleTab.dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(staleController.input.disabled, false);
      assert.equal(staleController.marked, true);
      assert.equal(staleController.collapsed, true);
    });

    const lineKey = staleController.lines[0].key;
    const collapsedKey = staleController.collapsedKey;
    const staleFingerprint =
      staleController.lines[0].contextFingerprint;

    currentTab = await startExtension(
      contextualLineFixture({
        after: "audit();",
        before: "if (isAdmin) {",
        officialControl: true,
      }),
      {},
      {
        chromeInstance: sharedChrome,
        lockManager: sharedLocks,
      },
    );
    const currentController = Array.from(
      currentTab.app.controllersByRow.values(),
    )[0];
    assert.equal(currentController.lines[0].key, lineKey);
    assert.notEqual(
      currentController.lines[0].contextFingerprint,
      staleFingerprint,
    );
    assert.equal(currentController.marked, false);
    assert.equal(currentController.collapsed, false);
    assert.equal(
      sharedChrome.snapshot()[lineKey].contextFingerprint,
      staleFingerprint,
    );
    assert.ok(sharedChrome.snapshot()[collapsedKey]);

    currentController.input.checked = true;
    currentController.input.dispatchEvent(
      new currentTab.dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(currentController.input.disabled, false);
      assert.equal(currentController.marked, true);
      assert.equal(currentController.collapsed, true);
      assert.equal(staleController.marked, false);
      assert.equal(staleController.collapsed, false);
    });
    const currentFingerprint =
      currentController.lines[0].contextFingerprint;
    assert.equal(
      sharedChrome.snapshot()[lineKey].contextFingerprint,
      currentFingerprint,
    );
    assert.ok(sharedChrome.snapshot()[collapsedKey]);
    assert.equal(
      sharedLocks.requests.every(
        ({ mode, name }) =>
          mode === "exclusive" &&
          name === staleTab.app.reviewStorageLockName(),
      ),
      true,
    );

    staleTab.app.startOfficialViewedRestoreGuard(
      staleController.officialSuppressionKey,
      staleController.filePath,
    );
    assert.equal(
      staleTab.app.preserveOfficialViewedRestoredState(),
      true,
    );
    assert.equal(
      staleController.groupRows.some(
        (row) =>
          row !== staleController.hunkRow &&
          row.classList.contains("hunkmark-collapsed"),
      ),
      false,
    );

    const staleHeader = staleTab.dom.window.document.querySelector(
      ".blob-code-hunk",
    );
    const replacement = staleHeader.cloneNode(false);
    replacement.textContent = staleHeader.textContent;
    staleHeader.replaceWith(replacement);

    let rebuiltStaleController;
    await waitFor(() => {
      rebuiltStaleController = Array.from(
        staleTab.app.controllersByRow.values(),
      )[0];
      assert.notEqual(rebuiltStaleController, staleController);
      assert.equal(rebuiltStaleController.input.disabled, false);
      assert.equal(rebuiltStaleController.marked, false);
      assert.equal(rebuiltStaleController.collapsed, false);
    });

    assert.equal(currentController.marked, true);
    assert.equal(currentController.collapsed, true);
    assert.equal(
      sharedChrome.snapshot()[lineKey].contextFingerprint,
      currentFingerprint,
    );
    assert.ok(sharedChrome.snapshot()[collapsedKey]);
  } finally {
    currentTab?.app.stop();
    currentTab?.dom.window.close();
    staleTab.app.stop();
    staleTab.dom.window.close();
  }
});

test("fails closed when invisible Unicode changes a reviewed line", async () => {
  const { app, dom } = await startExtension(contextualLineFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
    });

    replacePageBody(
      dom,
      contextualLineFixture({ line: "+return tr\u202eue;" }),
    );

    await waitFor(() => {
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.notEqual(after.lines[0].key, before.lines[0].key);
      assert.equal(after.marked, false);
      assert.equal(after.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("ignores legacy line marks that lack context evidence", async () => {
  const discovery = await startExtension(contextualLineFixture());
  let lineKey;
  let collapsedKey;
  try {
    await waitFor(() => {
      assert.equal(discovery.app.controllersByRow.size, 1);
    });
    const controller = Array.from(
      discovery.app.controllersByRow.values(),
    )[0];
    lineKey = controller.lines[0].key;
    collapsedKey = controller.collapsedKey;
    await assert.rejects(
      discovery.app.setReviewStorage({
        [lineKey]: { viewedAt: Date.now() },
      }),
      /context fingerprint is required/i,
    );
  } finally {
    discovery.app.stop();
    discovery.dom.window.close();
  }

  const restored = await startExtension(contextualLineFixture(), {
    [lineKey]: { viewedAt: Date.now() },
    [collapsedKey]: { collapsed: true, updatedAt: Date.now() },
  });
  try {
    await waitFor(() => {
      const controller = Array.from(
        restored.app.controllersByRow.values(),
      )[0];
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
      assert.equal(controller.collapsed, false);
      assert.equal(lineKey in restored.chrome.snapshot(), false);
      assert.equal(collapsedKey in restored.chrome.snapshot(), false);
    });
  } finally {
    restored.app.stop();
    restored.dom.window.close();
  }
});

test("shares persisted review state across GitHub viewers in the same local storage", async () => {
  const first = await startExtension(
    withViewerMeta(contextualLineFixture(), "alice"),
  );
  let stored;
  try {
    await waitFor(() => {
      assert.equal(first.app.controllersByRow.size, 1);
    });
    const controller = Array.from(first.app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new first.dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.input.disabled, false);
    });
    stored = first.chrome.snapshot();
  } finally {
    first.app.stop();
    first.dom.window.close();
  }

  const second = await startExtension(
    withViewerMeta(contextualLineFixture(), "bob"),
    stored,
  );
  try {
    await waitFor(() => {
      const controller = Array.from(second.app.controllersByRow.values())[0];
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, true);
    });
  } finally {
    second.app.stop();
    second.dom.window.close();
  }
});

test("activates without GitHub viewer metadata or sign-in controls", async () => {
  const { app, dom } = await startExtension(contextualLineFixture());
  try {
    assert.equal(
      app.currentScope,
      "github.com:octo/repo:pull:123",
    );
    assert.equal(app.controllersByRow.size, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not sync official Viewed while diff content is unresolved", async () => {
  const { app, dom } = await startExtension(
    contextualLineFixture({ officialControl: true, unresolved: true }),
  );
  try {
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    dom.window.document.querySelector(".js-diff-load-container button").click();
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.input.disabled, false);
    });
    assert.equal(officialClicks, 0);

    dom.window.document.querySelector(".js-diff-load-container").remove();
    controller.input.checked = false;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, false);
      assert.equal(controller.input.disabled, false);
    });
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("isolates selected-commit state and resets only the selected range", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        app.currentReviewVariant,
        app.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
    });
    const allCommitsScope = app.currentReviewScope;
    const allControllers = Array.from(app.controllersByRow.values());
    allControllers[0].input.checked = true;
    allControllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(allControllers[0].marked, true);
      assert.equal(allControllers[1].marked, false);
      assert.equal(allControllers[0].input.disabled, false);
    });
    const allCommitsLineKey = allControllers[0].lines[0].key;

    dom.window.history.pushState(
      {},
      "",
      "/octo/repo/pull/123/changes/abc123",
    );
    replacePageBody(dom, commitSelectionFixture({ withOfficialControl: false }));

    let selectedControllers;
    await waitFor(() => {
      assert.equal(app.currentReviewVariant, "selected:abc123");
      assert.notEqual(app.currentReviewScope, allCommitsScope);
      selectedControllers = Array.from(app.controllersByRow.values());
      assert.equal(selectedControllers.length, 2);
      assert.equal(
        selectedControllers.every((controller) => controller.hunkRow.isConnected),
        true,
      );
      assert.equal(
        selectedControllers.every((controller) => !controller.marked),
        true,
      );
    });
    const selectedReviewScope = app.currentReviewScope;
    assert.equal(
      dom.window.document.querySelector(
        app.constants.OFFICIAL_FILE_VIEWED_SELECTOR,
      ),
      null,
    );

    selectedControllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(
        selectedControllers.every(
          (controller) => controller.marked && !controller.input.disabled,
        ),
        true,
      );
    });
    const selectedLineKeys = selectedControllers.flatMap((controller) =>
      controller.lines.map((line) => line.key),
    );
    const reviewContextMetadataKey = await app.Core.reviewContextMetadataKey(
      app.currentScope,
    );
    const selectedScopePrefixes =
      await app.Core.reviewStoragePrefixes(selectedReviewScope);
    const contextPrefixes =
      await app.Core.reviewStoragePrefixesForContext(app.currentScope);
    assert.equal(selectedLineKeys.includes(allCommitsLineKey), false);
    assert.equal(Boolean(chrome.snapshot()[reviewContextMetadataKey]), true);

    dom.window.document.querySelector(".hunkmark-reset-button").click();
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(
        Object.keys(stored).some((key) =>
          selectedScopePrefixes.some((prefix) => key.startsWith(prefix)),
        ),
        false,
      );
      assert.equal(Boolean(stored[allCommitsLineKey]), true);
      assert.equal(Boolean(stored[reviewContextMetadataKey]), true);
      assert.equal(
        selectedControllers.every((controller) => !controller.marked),
        true,
      );
    });

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/changes");
    replacePageBody(dom, commitSelectionFixture());
    await waitFor(() => {
      const restored = Array.from(app.controllersByRow.values());
      assert.equal(app.currentReviewScope, allCommitsScope);
      assert.equal(restored.length, 2);
      assert.equal(restored.every((controller) => controller.hunkRow.isConnected), true);
      assert.equal(restored[0].marked, true);
      assert.equal(restored[1].marked, false);
    });

    dom.window.document.querySelector(".hunkmark-reset-button").click();
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(
        Object.keys(stored).some((key) =>
          contextPrefixes.some((prefix) => key.startsWith(prefix)),
        ),
        false,
      );
      assert.equal(reviewContextMetadataKey in stored, false);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => !controller.marked,
        ),
        true,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("syncs official Viewed in a selected range when GitHub exposes it", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture(), {}, {
    url: "https://github.com/octo/repo/pull/123/changes/abc123..head456",
  });
  try {
    await waitFor(() => {
      assert.equal(app.currentReviewVariant, "selected:abc123..head456");
      assert.equal(app.controllersByRow.size, 2);
    });
    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    controllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });

    await waitFor(() => {
      assert.equal(
        controllers.every(
          (controller) => controller.marked && !controller.input.disabled,
        ),
        true,
      );
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("removes legacy review state and prunes inactive pull requests as complete units", async () => {
  const now = Date.now();
  const validContextFingerprint = "A".repeat(43);
  const currentContext = "github.com:octo/repo:pull:123";
  const expiredContext = "github.com:old/repo:pull:9";
  const recentContext = "github.com:recent/repo:pull:7";
  const corruptContext = "github.com:corrupt/repo:pull:8";
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const expiredScope = Core.reviewStateScope(
    expiredContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const expiredSelectedScope = Core.reviewStateScope(
    expiredContext,
    "selected:old..head",
  );
  const recentScope = Core.reviewStateScope(
    recentContext,
    "selected:abc..def",
  );
  const corruptScope = Core.reviewStateScope(
    corruptContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const currentKey = await Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const expiredLineKey = await Core.lineStorageKey(
    expiredScope,
    "src/expired.js",
    "addition",
    "+expired",
  );
  const expiredCollapsedKey = `${await Core.hunkStorageKey(
    expiredScope,
    "src/expired.js",
    "@@\n+expired",
  )}:collapsed`;
  const expiredSelectedKey = await Core.lineStorageKey(
    expiredSelectedScope,
    "src/expired-selected.js",
    "deletion",
    "-expired-selected",
  );
  const recentKey = await Core.lineStorageKey(
    recentScope,
    "src/recent.js",
    "addition",
    "+recent",
  );
  const corruptLineKey = await Core.lineStorageKey(
    corruptScope,
    "src/corrupt.js",
    "addition",
    "+corrupt",
  );
  const preferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
  const expiredAt = now - 181 * 24 * 60 * 60 * 1000;
  const recentAt = now - 7 * 24 * 60 * 60 * 1000;
  const legacyAccountStateKey =
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:line:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc:0`;
  const legacyAccountMetadataKey =
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-context:aaaaaaaaaaaaaaaa`;
  const obsoleteScopeMetadataKey =
    `${LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE}:review-scope:aaaaaaaaaaaaaaaa`;
  const legacyContentStateKey =
    `${LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE}:line:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:cccccccccccccccc:0`;
  const [
    currentMetadataKey,
    expiredMetadataKey,
    recentMetadataKey,
    corruptMetadataKey,
  ] = await Promise.all([
    Core.reviewContextMetadataKey(currentContext),
    Core.reviewContextMetadataKey(expiredContext),
    Core.reviewContextMetadataKey(recentContext),
    Core.reviewContextMetadataKey(corruptContext),
  ]);
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture(), {
    [currentKey]: {
      contextFingerprint: validContextFingerprint,
      viewedAt: expiredAt,
    },
    [expiredLineKey]: {
      contextFingerprint: validContextFingerprint,
      viewedAt: expiredAt,
    },
    [expiredCollapsedKey]: { collapsed: true, updatedAt: expiredAt },
    [expiredSelectedKey]: {
      contextFingerprint: validContextFingerprint,
      viewedAt: expiredAt,
    },
    [recentKey]: {
      contextFingerprint: validContextFingerprint,
      viewedAt: recentAt,
    },
    [corruptLineKey]: {
      contextFingerprint: "not-a-review-identifier",
      viewedAt: recentAt,
    },
    [corruptMetadataKey]: { lastAccessedAt: recentAt },
    [legacyAccountStateKey]: { viewedAt: recentAt },
    [legacyAccountMetadataKey]: { lastAccessedAt: recentAt },
    [obsoleteScopeMetadataKey]: { lastAccessedAt: recentAt },
    [legacyContentStateKey]: { viewedAt: recentAt },
    [preferenceKey]: true,
  });
  try {
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(expiredLineKey in stored, false);
      assert.equal(expiredCollapsedKey in stored, false);
      assert.equal(expiredSelectedKey in stored, false);
      assert.equal(expiredMetadataKey in stored, false);
      assert.equal(legacyAccountStateKey in stored, false);
      assert.equal(legacyAccountMetadataKey in stored, false);
      assert.equal(obsoleteScopeMetadataKey in stored, false);
      assert.equal(legacyContentStateKey in stored, false);
      assert.equal(corruptLineKey in stored, false);
      assert.equal(corruptMetadataKey in stored, false);
      assert.equal(currentKey in stored, true);
      assert.ok(
        stored[currentMetadataKey].lastAccessedAt >= now,
      );
      assert.equal(recentKey in stored, true);
      assert.equal(
        stored[recentMetadataKey].lastAccessedAt,
        recentAt,
      );
      assert.equal(stored[preferenceKey], true);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("serializes pruning with a fresh review write from another tab", async () => {
  const sharedChrome = createChromeApi();
  const sharedLocks = createExclusiveLockManager();
  const tabA = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: sharedChrome,
    lockManager: sharedLocks,
  });
  const tabB = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: sharedChrome,
    lockManager: sharedLocks,
  });
  let prunePromise = null;
  let writePromise = null;
  let releaseSnapshot = () => {};

  try {
    const now = Date.now();
    const staleAt =
      now - tabA.app.constants.REVIEW_RETENTION_MS - 1;
    const targetContext = "github.com:old/repo:pull:9";
    const targetScope = Core.reviewStateScope(
      targetContext,
      Core.ALL_COMMITS_REVIEW_VARIANT,
    );
    const lineKey = await Core.lineStorageKey(
      targetScope,
      "src/old.js",
      "addition",
      "+old",
    );
    const metadataKey =
      await Core.reviewContextMetadataKey(targetContext);

    await tabA.app.setReviewStorage(
      {
        [lineKey]: {
          contextFingerprint: "S".repeat(43),
          viewedAt: staleAt,
        },
      },
      targetScope,
      staleAt,
    );

    const originalGetLocalStorage =
      tabA.app.getLocalStorage.bind(tabA.app);
    let signalSnapshotRead;
    const snapshotRead = new Promise((resolve) => {
      signalSnapshotRead = resolve;
    });
    const snapshotPause = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    let pauseNextSnapshot = true;
    tabA.app.getLocalStorage = async (keys) => {
      const stored = await originalGetLocalStorage(keys);
      if (pauseNextSnapshot && keys === null) {
        pauseNextSnapshot = false;
        signalSnapshotRead();
        await snapshotPause;
      }
      return stored;
    };

    prunePromise = tabA.app.pruneStoredReviewState({
      currentContext: tabA.app.currentScope,
      now,
    });
    await snapshotRead;

    const freshAt = now + 1;
    const freshValue = {
      contextFingerprint: "F".repeat(43),
      viewedAt: freshAt,
    };
    let writeFinished = false;
    writePromise = tabB.app
      .setReviewStorage(
        { [lineKey]: freshValue },
        targetScope,
        freshAt,
      )
      .finally(() => {
        writeFinished = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writeFinished, false);

    releaseSnapshot();
    releaseSnapshot = () => {};
    await Promise.all([prunePromise, writePromise]);

    const stored = sharedChrome.snapshot();
    assert.deepEqual(stored[lineKey], freshValue);
    assert.equal(stored[metadataKey].lastAccessedAt, freshAt);
    assert.equal(
      sharedLocks.requests.every(
        ({ mode, name }) =>
          mode === "exclusive" &&
          name === tabA.app.reviewStorageLockName(),
      ),
      true,
    );
  } finally {
    releaseSnapshot();
    await Promise.allSettled(
      [prunePromise, writePromise].filter(Boolean),
    );
    tabB.app.stop();
    tabB.dom.window.close();
    tabA.app.stop();
    tabA.dom.window.close();
  }
});

test("serializes page reset with a fresh review write from another tab", async () => {
  const sharedChrome = createChromeApi();
  const sharedLocks = createExclusiveLockManager();
  const tabA = await startExtension(contextualLineFixture(), {}, {
    chromeInstance: sharedChrome,
    lockManager: sharedLocks,
  });
  const tabB = await startExtension(contextualLineFixture(), {}, {
    chromeInstance: sharedChrome,
    lockManager: sharedLocks,
  });
  let writePromise = null;
  let releaseSnapshot = () => {};

  try {
    const controllerA = Array.from(tabA.app.controllersByRow.values())[0];
    const controllerB = Array.from(tabB.app.controllersByRow.values())[0];
    const lineKey = controllerA.lines[0].key;
    const oldAt = Date.now();
    await tabA.app.setReviewStorage(
      {
        [lineKey]: tabA.app.lineReviewStorageValue(
          controllerA.lines[0],
          oldAt,
        ),
      },
      tabA.app.currentReviewScope,
      oldAt,
    );

    const originalGetLocalStorage =
      tabA.app.getLocalStorage.bind(tabA.app);
    let signalSnapshotRead;
    const snapshotRead = new Promise((resolve) => {
      signalSnapshotRead = resolve;
    });
    const snapshotPause = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    let pauseNextSnapshot = true;
    tabA.app.getLocalStorage = async (keys) => {
      const stored = await originalGetLocalStorage(keys);
      if (pauseNextSnapshot && keys === null) {
        pauseNextSnapshot = false;
        signalSnapshotRead();
        await snapshotPause;
      }
      return stored;
    };

    const resetButton =
      tabA.dom.window.document.querySelector(".hunkmark-reset-button");
    resetButton.click();
    await snapshotRead;

    const freshAt = oldAt + 1;
    const freshValue = tabB.app.lineReviewStorageValue(
      controllerB.lines[0],
      freshAt,
    );
    let writeFinished = false;
    writePromise = tabB.app
      .setReviewStorage(
        { [lineKey]: freshValue },
        tabB.app.currentReviewScope,
        freshAt,
      )
      .finally(() => {
        writeFinished = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(writeFinished, false);

    releaseSnapshot();
    releaseSnapshot = () => {};
    await writePromise;
    await waitFor(() => {
      assert.equal(resetButton.disabled, false);
      assert.equal(controllerA.marked, true);
    });

    assert.equal(
      sharedChrome.snapshot()[lineKey].contextFingerprint,
      freshValue.contextFingerprint,
    );
    assert.equal(
      sharedChrome.snapshot()[lineKey].viewedAt,
      freshValue.viewedAt,
    );
    assert.equal(
      sharedLocks.requests.every(
        ({ mode, name }) =>
          mode === "exclusive" &&
          name === tabA.app.reviewStorageLockName(),
      ),
      true,
    );
  } finally {
    releaseSnapshot();
    await Promise.allSettled([writePromise].filter(Boolean));
    tabB.app.stop();
    tabB.dom.window.close();
    tabA.app.stop();
    tabA.dom.window.close();
  }
});

test("updates pull-request access metadata at most once per 24 hours", async () => {
  const now = Date.now();
  const currentContext = "github.com:octo/repo:pull:123";
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const stateKey = await Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const metadataKey = await Core.reviewContextMetadataKey(currentContext);
  const previousAccess = now - 60 * 60 * 1000;
  const extension = await startLockedExtension(
    duplicateHunkFixture(),
    {
      [stateKey]: {
        contextFingerprint: "A".repeat(43),
        viewedAt: previousAccess,
      },
      [metadataKey]: { lastAccessedAt: previousAccess },
    },
  );
  const { app, chrome, dom, locks } = extension;
  try {
    await waitFor(() => {
      assert.equal(
        chrome.snapshot()[metadataKey].lastAccessedAt,
        previousAccess,
      );
    });

    const requestsBeforeTouch = locks.requests.length;
    const beforeInterval = await app.touchReviewContextAccess(
      currentContext,
      previousAccess + app.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS - 1,
    );
    assert.equal(beforeInterval, false);
    assert.equal(locks.requests.length, requestsBeforeTouch);
    assert.equal(
      chrome.snapshot()[metadataKey].lastAccessedAt,
      previousAccess,
    );

    const nextAccess =
      previousAccess + app.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS + 1;
    const afterInterval = await app.touchReviewContextAccess(
      currentContext,
      nextAccess,
    );
    assert.equal(afterInterval, true);
    assert.equal(locks.requests.length, requestsBeforeTouch + 1);
    assert.equal(chrome.snapshot()[metadataKey].lastAccessedAt, nextAccess);

    const emptyContext = "github.com:empty/repo:pull:99";
    const emptyAccess = await app.touchReviewContextAccess(
      emptyContext,
      nextAccess,
    );
    assert.equal(emptyAccess, false);
    assert.equal(locks.requests.length, requestsBeforeTouch + 1);
    const emptyMetadataKey =
      await Core.reviewContextMetadataKey(emptyContext);
    assert.equal(
      emptyMetadataKey in chrome.snapshot(),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("evicts every range of the oldest pull request when over capacity", async () => {
  const now = Date.now();
  const currentContext = "github.com:octo/repo:pull:123";
  const middleContext = "github.com:middle/repo:pull:2";
  const oldestContext = "github.com:oldest/repo:pull:1";
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const middleScope = Core.reviewStateScope(
    middleContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestScope = Core.reviewStateScope(
    oldestContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestSelectedScope = Core.reviewStateScope(
    oldestContext,
    "selected:abc..def",
  );
  const stateKeys = (scope, prefix, count) =>
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        Core.lineStorageKey(
          scope,
          `src/${prefix}.js`,
          "addition",
          `+${prefix}-${index}`,
        ),
      ),
    );
  const currentKeys = await stateKeys(currentScope, "current", 2);
  const middleKeys = await stateKeys(middleScope, "middle", 2);
  const oldestKeys = await stateKeys(oldestScope, "oldest", 3);
  const oldestSelectedKeys = await stateKeys(
    oldestSelectedScope,
    "oldest-selected",
    1,
  );
  const initial = {};
  for (const [context, keys, lastAccessedAt] of [
    [currentContext, currentKeys, now],
    [middleContext, middleKeys, now - 2 * 24 * 60 * 60 * 1000],
    [
      oldestContext,
      [...oldestKeys, ...oldestSelectedKeys],
      now - 3 * 24 * 60 * 60 * 1000,
    ],
  ]) {
    keys.forEach((key) => {
      initial[key] = {
        contextFingerprint: "A".repeat(43),
        viewedAt: lastAccessedAt,
      };
    });
    initial[await Core.reviewContextMetadataKey(context)] = {
      lastAccessedAt,
    };
  }
  const oldestMetadataKey =
    await Core.reviewContextMetadataKey(oldestContext);

  const { app, chrome, dom } = await startExtension(
    duplicateHunkFixture(),
    initial,
  );
  try {
    await app.pruneStoredReviewState({
      currentContext,
      maxEntries: 8,
      now,
    });
    const stored = chrome.snapshot();
    assert.equal(oldestKeys.every((key) => !(key in stored)), true);
    assert.equal(
      oldestSelectedKeys.every((key) => !(key in stored)),
      true,
    );
    assert.equal(oldestMetadataKey in stored, false);
    assert.equal(middleKeys.every((key) => key in stored), true);
    assert.equal(currentKeys.every((key) => key in stored), true);
    assert.equal(
      [...middleKeys, ...currentKeys].filter((key) => key in stored).length,
      4,
    );
    assert.equal(
      Object.keys(stored).filter(
        (key) =>
          Core.isReviewStorageKey(key) ||
          Core.isReviewContextMetadataKey(key),
      ).length,
      6,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("enforces the review storage limit after later writes", async () => {
  const now = Date.now();
  const currentContext = "github.com:octo/repo:pull:123";
  const middleContext = "github.com:middle/repo:pull:2";
  const oldestContext = "github.com:oldest/repo:pull:1";
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const middleScope = Core.reviewStateScope(
    middleContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestScope = Core.reviewStateScope(
    oldestContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const stateKeys = (scope, prefix, count) =>
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        Core.lineStorageKey(
          scope,
          `src/${prefix}.js`,
          "addition",
          `+${prefix}-${index}`,
        ),
      ),
    );
  const oldestKeys = await stateKeys(oldestScope, "oldest", 3);
  const middleKeys = await stateKeys(middleScope, "middle", 2);
  const currentKey = await Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const { app, chrome, dom } = await startExtension(
    duplicateHunkFixture(),
    {},
    { lockManager: createExclusiveLockManager() },
  );
  try {
    app.reviewStorageEntryLimit = () => 8;
    const initial = {};
    for (const [context, keys, lastAccessedAt] of [
      [oldestContext, oldestKeys, now - 3 * 24 * 60 * 60 * 1000],
      [middleContext, middleKeys, now - 2 * 24 * 60 * 60 * 1000],
    ]) {
      keys.forEach((key) => {
        initial[key] = {
          contextFingerprint: "A".repeat(43),
          viewedAt: lastAccessedAt,
        };
      });
      initial[await Core.reviewContextMetadataKey(context)] = {
        lastAccessedAt,
      };
    }
    await chrome.api.storage.local.set(initial);
    assert.equal(app.reviewStorageKeys.size, 7);

    await app.setReviewStorage(
      {
        [currentKey]: {
          contextFingerprint: "A".repeat(43),
          viewedAt: now,
        },
      },
      currentScope,
      now,
    );

    const stored = chrome.snapshot();
    const oldestMetadataKey =
      await Core.reviewContextMetadataKey(oldestContext);
    const currentMetadataKey =
      await Core.reviewContextMetadataKey(currentContext);
    assert.equal(oldestKeys.every((key) => !(key in stored)), true);
    assert.equal(oldestMetadataKey in stored, false);
    assert.equal(middleKeys.every((key) => key in stored), true);
    assert.equal(currentKey in stored, true);
    assert.equal(currentMetadataKey in stored, true);
    assert.equal(app.reviewStorageKeys.size <= 8, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps the maximum line-state payload below Chrome 114's local quota", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    assert.equal(app.constants.REVIEW_STORAGE_MAX_ENTRIES, 25_000);
    const identifier = "A".repeat(43);
    const stored = {};
    for (
      let index = 0;
      index < app.constants.REVIEW_STORAGE_MAX_ENTRIES;
      index += 1
    ) {
      const key =
        `${Core.REVIEW_STORAGE_NAMESPACE}:line:` +
        `${identifier}:${identifier}:${identifier}:${index}`;
      stored[key] = {
        contextFingerprint: identifier,
        viewedAt: Number.MAX_SAFE_INTEGER,
      };
    }

    assert.equal(
      Buffer.byteLength(JSON.stringify(stored), "utf8") < 10 * 1024 * 1024,
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("shrinks a dragged line range before persisting it", async () => {
  const { app, chrome, dom } = await startExtension(dragFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-cell").length,
        3,
      );
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.lines.forEach((line, index) => {
      line.element.getClientRects = () => [
        { top: index * 20, bottom: index * 20 + 20 },
      ];
    });

    const pointerDown = new dom.window.Event("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(pointerDown, {
      button: { value: 0 },
      pointerId: { value: 7 },
      pointerType: { value: "mouse" },
    });
    controller.lines[0].control.dispatchEvent(pointerDown);
    assert.equal(pointerDown.defaultPrevented, true);
    app.touchLineRange(controller.lines[2]);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, true],
    );

    app.touchLineRange(controller.lines[1]);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, false],
    );
    await app.finishLineDrag(true);

    assert.equal(
      Object.keys(chrome.snapshot()).filter((key) => key.includes(":line:"))
        .length,
      2,
    );
    assert.equal(controller.indeterminate, true);

    app.startLineDrag(controller.lines[2], true, 8);
    await app.finishLineDrag(true);
    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
    assert.ok(chrome.snapshot()[controller.collapsedKey]);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("enables auto-collapse by default and persists its setting", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.ok(dom.window.document.getElementById("hunkmark-panel"));
    });
    const autoCollapse = dom.window.document.querySelector(
      'input[aria-label="Automatically collapse viewed hunks"]',
    );
    assert.equal(app.autoCollapseViewed, true);
    assert.equal(autoCollapse.checked, true);

    autoCollapse.checked = false;
    autoCollapse.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(app.autoCollapseViewed, false);
      assert.equal(autoCollapse.checked, false);
      assert.equal(
        chrome.snapshot()[app.autoCollapsePreferenceKey],
        false,
      );
    });

    const controller = Array.from(app.controllersByRow.values())[0];
    controller.lines[0].control.click();
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores the UI when a storage write fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      const controls = lineControls(dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });
    const control = lineControls(dom)[0];
    const controller = Array.from(app.controllersByRow.values())[0];
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    chrome.failNextSet();
    control.click();

    await waitFor(() => {
      assert.equal(control.disabled, false);
      assert.equal(control.getAttribute("aria-pressed"), "false");
      assert.equal(controller.collapsed, false);
    });
    assert.equal(Object.keys(chrome.snapshot()).length, 0);
    assert.equal(warnings.length, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores collapsed state from storage when its write fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = controllerAt(app);
    const warnings = captureWarnings(dom);

    chrome.failNextSet();
    await app.setCollapsed(controller, true);

    assert.equal(warnings.length, 1);
    assert.equal(controller.collapsed, false);
    assert.equal(controller.collapsedKey in chrome.snapshot(), false);
    assert.equal(controller.collapseButton.disabled, false);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("restores dragged lines from storage when their write fails", async () => {
  const { app, chrome, dom } = await startExtension(dragFixture());
  try {
    const controller = controllerAt(app);
    const warnings = captureWarnings(dom);

    app.startLineDrag(controller.lines[0], true, 17);
    chrome.failNextSet();
    await app.finishLineDrag(true);

    assert.equal(warnings.length, 1);
    assert.equal(controller.lines.every((line) => !line.marked), true);
    assert.equal(controller.marked, false);
    assert.equal(
      controller.lines.some((line) => line.key in chrome.snapshot()),
      false,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("rolls back a partially stored line mutation when removal fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = controllerAt(app);
    const line = controller.lines[0];
    const warnings = captureWarnings(dom);
    const contextId = await app.Core.reviewContextId(
      app.currentReviewScope,
    );
    const metadataKey =
      app.Core.reviewContextMetadataKeyForId(contextId);

    chrome.failNextRemove();
    await app.setLineViewed(line, true);

    const stored = chrome.snapshot();
    assert.equal(warnings.length, 1);
    assert.equal(line.marked, false);
    assert.equal(controller.marked, false);
    assert.equal(controller.collapsed, false);
    assert.equal(line.key in stored, false);
    assert.equal(controller.key in stored, false);
    assert.equal(controller.collapsedKey in stored, false);
    assert.equal(metadataKey in stored, false);
    assert.equal(app.reviewContextAccessedAtById.has(contextId), false);
    assert.equal(line.control.disabled, false);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("restores prior review values and access metadata when a mixed mutation fails", async () => {
  const { app, chrome, dom } = await startExtension(dragFixture());
  try {
    const controller = controllerAt(app);
    const previousLine = controller.lines[0];
    const nextLine = controller.lines[1];
    const nextAt = Date.now();
    const previousAt =
      nextAt - app.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS - 1;
    const contextId = await app.Core.reviewContextId(
      app.currentReviewScope,
    );
    const metadataKey =
      app.Core.reviewContextMetadataKeyForId(contextId);
    const previousValue = app.lineReviewStorageValue(
      previousLine,
      previousAt,
    );
    await app.setReviewStorage(
      { [previousLine.key]: previousValue },
      app.currentReviewScope,
      previousAt,
    );

    chrome.failNextRemove();
    await assert.rejects(
      app.mutateReviewStorage({
        values: {
          [nextLine.key]: app.lineReviewStorageValue(nextLine, nextAt),
        },
        removals: [previousLine.key],
        scope: app.currentReviewScope,
        now: nextAt,
      }),
      /storage removal failed/,
    );

    const stored = chrome.snapshot();
    assert.equal(
      stored[previousLine.key].contextFingerprint,
      previousValue.contextFingerprint,
    );
    assert.equal(
      stored[previousLine.key].viewedAt,
      previousValue.viewedAt,
    );
    assert.equal(nextLine.key in stored, false);
    assert.equal(stored[metadataKey].lastAccessedAt, previousAt);
    assert.equal(
      app.reviewContextAccessedAtById.get(contextId),
      previousAt,
    );
    assert.equal(previousLine.marked, true);
    assert.equal(nextLine.marked, false);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("reconciles a partial line mutation when its rollback also fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = controllerAt(app);
    const line = controller.lines[0];
    const removeLocalStorage = app.removeLocalStorage.bind(app);
    let removalAttempts = 0;
    app.removeLocalStorage = async (keys) => {
      removalAttempts += 1;
      if (removalAttempts <= 2) {
        throw new Error(
          removalAttempts === 1
            ? "review removal failed"
            : "review rollback failed",
        );
      }
      return removeLocalStorage(keys);
    };
    const warnings = captureWarnings(dom);

    await app.setLineViewed(line, true);

    const stored = chrome.snapshot();
    assert.equal(removalAttempts, 2);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0][2].rollbackError.message,
      /review rollback failed/,
    );
    assert.ok(stored[line.key]);
    assert.ok(stored[controller.collapsedKey]);
    assert.equal(line.marked, true);
    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
    assert.equal(line.control.disabled, false);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a committed line review when retention pruning fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = controllerAt(app);
    const line = controller.lines[0];
    app.reviewStorageLimitExceeded = () => true;
    app.ensureStoredReviewStatePrunedUnlocked = async () => {
      throw new Error("retention pruning failed");
    };
    const warnings = captureWarnings(dom);

    await app.setLineViewed(line, true);
    await waitFor(() => {
      assert.equal(
        warnings.some(([message]) =>
          String(message).includes("prune old review state after saving"),
        ),
        true,
      );
    });

    assert.equal(
      warnings.some(([message]) =>
        String(message).includes("could not save a line mark"),
      ),
      false,
    );
    assert.ok(chrome.snapshot()[line.key]);
    assert.equal(line.marked, true);
    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("stops quietly when the extension context is invalidated", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);

    chrome.invalidateContext();
    replacePageBody(dom, commitSelectionFixture());

    await waitFor(() => {
      assert.equal(app.stopped, true);
      assert.equal(app.observer, null);
      assert.equal(app.navigationPollTimer, null);
      assert.equal(app.refreshTimer, null);
    });
    assert.equal(warnings.length, 0);
    assert.equal(
      dom.window.document.querySelectorAll(
        "[data-hunkmark-ui], .hunkmark-file-progress, #hunkmark-panel",
      ).length,
      0,
    );
    const notice = dom.window.document.getElementById(
      app.constants.RECONNECT_NOTICE_ID,
    );
    assert.ok(notice);
    assert.match(notice.textContent, /Reload this page/);
    assert.equal(notice.querySelector("button").textContent, "Reload");

    app.scheduleRefresh();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(app.refreshQueued, false);
    assert.equal(warnings.length, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("stops quietly when collapse storage loses the extension context", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    const controller = Array.from(app.controllersByRow.values())[0];

    await waitFor(() => {
      assert.equal(controller.collapseButton.disabled, false);
    });
    chrome.invalidateContext();
    controller.collapseButton.click();

    await waitFor(() => {
      assert.equal(app.stopped, true);
      assert.equal(app.observer, null);
      assert.equal(app.navigationPollTimer, null);
    });
    assert.equal(warnings.length, 0);
    assert.equal(Object.keys(chrome.snapshot()).length, 0);
    assert.equal(
      dom.window.document.querySelectorAll(
        "[data-hunkmark-ui], .hunkmark-file-progress, #hunkmark-panel",
      ).length,
      0,
    );
    const notice = dom.window.document.getElementById(
      app.constants.RECONNECT_NOTICE_ID,
    );
    assert.ok(notice);
    assert.equal(notice.querySelector("button").textContent, "Reload");
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-collapsed").length,
      0,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("stops quietly when official Viewed override loses the storage API", async () => {
  const { app, chrome, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);

    chrome.api.storage = undefined;
    assert.doesNotThrow(() => {
      dom.window.document
        .querySelector('button[aria-label="Viewed"]')
        .click();
    });

    await waitFor(() => {
      assert.equal(app.stopped, true);
      assert.equal(app.observer, null);
      assert.equal(app.navigationPollTimer, null);
    });
    assert.equal(warnings.length, 0);
    const notice = dom.window.document.getElementById(
      app.constants.RECONNECT_NOTICE_ID,
    );
    assert.ok(notice);
    assert.match(notice.textContent, /Reload this page/);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("activates after GitHub client-side navigation into Files changed", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(app.currentScope, null);
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      0,
    );

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/files");
    const fixtureDom = new JSDOM(duplicateHunkFixture());
    const fixture = fixtureDom.window.document.querySelector(".js-file");
    dom.window.document.body.replaceChildren(
      dom.window.document.importNode(fixture, true),
    );
    fixtureDom.window.close();
    dom.window.document.dispatchEvent(new dom.window.Event("turbo:load"));

    await waitFor(() => {
      assert.ok(app.currentScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("activates when the diff DOM arrives before the SPA URL change", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    replacePageBody(dom, duplicateHunkFixture());
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      0,
    );

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/changes");

    await waitFor(() => {
      assert.ok(app.currentScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("ignores GitHub viewer metadata changes after activation", async () => {
  const { app, dom } = await startExtension(
    duplicateHunkFixture(),
  );
  try {
    const initialScope = app.currentScope;

    const viewerMeta = dom.window.document.createElement("meta");
    viewerMeta.name = "user-login";
    viewerMeta.content = "another-user";
    dom.window.document.head.append(viewerMeta);

    await waitFor(() => {
      assert.equal(app.currentScope, initialScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not inspect DOM mutations while outside a pull request diff", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(app.currentScope, null);
    let diffChecks = 0;
    const originalMutationAffectsDiff = app.mutationAffectsDiff.bind(app);
    app.mutationAffectsDiff = (mutation) => {
      diffChecks += 1;
      return originalMutationAffectsDiff(mutation);
    };

    const unrelated = dom.window.document.createElement("div");
    unrelated.textContent = "dynamic repository notification";
    dom.window.document.body.append(unrelated);
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(diffChecks, 0);
    assert.equal(app.currentScope, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("supports GitHub's current React diff with persistent controls visible", async () => {
  const { app, dom } = await startExtension(modernGridFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        1,
      );
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-control").length,
        2,
      );
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    assert.equal(controller.filePath, "src/modern.ts");
    assert.deepEqual(
      Array.from(controller.lines, (line) => [line.kind, line.side]),
      [
        ["deletion", "left"],
        ["addition", "right"],
      ],
    );
    const pathSection = dom.window.document.querySelector(
      '[class*="file-path-section"]',
    );
    const progress = pathSection.nextElementSibling;
    assert.equal(progress.className, "hunkmark-file-progress");
    assert.match(progress.textContent, /Hunks 0\/1 · Lines 0\/2/);

    const style = installContentStyles(dom);
    const lineHoverRule = Array.from(style.sheet.cssRules).find(
      (rule) => rule.selectorText === ".hunkmark-line-control:hover",
    );
    assert.match(lineHoverRule.style.background, /linear-gradient/);
    assert.match(lineHoverRule.style.background, /--bgColor-default/);
    assert.equal(
      dom.window.getComputedStyle(controller.actions).visibility,
      "visible",
    );
    assert.equal(dom.window.getComputedStyle(controller.actions).opacity, "1");
    assert.equal(dom.window.getComputedStyle(progress).visibility, "visible");
    assert.equal(dom.window.getComputedStyle(progress).opacity, "1");
    assert.equal(
      dom.window.getComputedStyle(controller.hunkCell).paddingRight,
      "16px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].element).paddingRight,
      "24px",
    );
    assert.equal(
      controller.lines[0].element.style.getPropertyValue(
        "--hunkmark-host-line-action-inset",
      ),
      "24px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].control).right,
      "calc(4px + var(--hunkmark-host-line-action-inset, 0px))",
    );
    assert.equal(
      controller.lines[1].element.style.getPropertyValue(
        "--hunkmark-first-line-center",
      ),
      "12px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[1].control).top,
      "var(--hunkmark-first-line-center, 12px)",
    );
    const reviewButton = dom.window.document.querySelector(
      'button[aria-label="Add a line comment"]',
    );
    const highlightedCode = controller.lines[1].element.querySelector(
      "code > span",
    );
    assert.equal(
      dom.window.getComputedStyle(reviewButton).backgroundColor,
      "rgb(31, 111, 235)",
    );
    controller.lines[1].control.click();
    await waitFor(() => {
      assert.equal(controller.lines[1].marked, true);
    });
    assert.equal(
      dom.window.getComputedStyle(reviewButton).backgroundColor,
      "rgb(31, 111, 235)",
    );
    assert.equal(
      dom.window.getComputedStyle(highlightedCode).backgroundColor,
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].control).opacity,
      "0",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("ignores DOM mutations unrelated to a diff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    let refreshCalls = 0;
    const originalRefresh = app.refresh.bind(app);
    app.refresh = async () => {
      refreshCalls += 1;
      return originalRefresh();
    };

    const unrelated = dom.window.document.createElement("div");
    unrelated.textContent = "unrelated notification";
    dom.window.document.body.append(unrelated);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshCalls, 0);

    const changedLine = dom.window.document.querySelector(
      "td.blob-code-addition",
    );
    changedLine.prepend("updated ");
    await waitFor(() => {
      assert.equal(refreshCalls, 1);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("adds only the missing clearance below the final diff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    panel.style.bottom = "18px";
    panel.getBoundingClientRect = () => ({ height: 40 });
    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.groupRows.forEach((row) => {
        row.getClientRects = () => [{ bottom: 400 }];
        row.getBoundingClientRect = () => ({ bottom: 400 });
      });
    });
    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    spacer.style.height = "0px";

    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "0px");

    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 420,
    });
    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "46px");
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps the panel clear of a collapsed file below the final hunk", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    panel.style.bottom = "18px";
    panel.getBoundingClientRect = () => ({ height: 40 });
    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.groupRows.forEach((row) => {
        row.getClientRects = () => [{ bottom: 400 }];
        row.getBoundingClientRect = () => ({ bottom: 400 });
      });
    });

    const collapsedFile = dom.window.document.createElement("section");
    collapsedFile.className = "js-file";
    collapsedFile.dataset.filePath = "src/collapsed.js";
    collapsedFile.textContent = "src/collapsed.js";
    collapsedFile.getClientRects = () => [{ bottom: 470 }];
    collapsedFile.getBoundingClientRect = () => ({ bottom: 470 });
    dom.window.document.body.insertBefore(collapsedFile, panel);
    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    spacer.style.height = "0px";

    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "44px");
  } finally {
    app.stop();
    dom.window.close();
  }
});
