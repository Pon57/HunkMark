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

function syncStickyHunkContentInset(app, controller) {
  app.applyStickyHunkContentInset(
    controller,
    app.measureStickyHunkContentInset(controller),
  );
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

function delayReviewStorageRemove(
  app,
  targetRemove,
  { failureMessage = null } = {},
) {
  const original = app.removeLocalStorage.bind(app);
  const started = createDeferred();
  const gate = createDeferred();
  let removeCount = 0;
  app.removeLocalStorage = async (keys) => {
    removeCount += 1;
    if (removeCount === targetRemove) {
      started.resolve();
      await gate.promise;
      if (failureMessage) {
        throw new Error(failureMessage);
      }
    }
    return original(keys);
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

function contextExpansionIntentFor(app, filePath = null) {
  if (filePath !== null) {
    const intents = app.hostContextExpansionIntentsForFile(filePath);
    return intents[intents.length - 1] ?? null;
  }
  return app.hostContextExpansionIntents.values().next().value ?? null;
}

function fileReviewSnapshotFor(app, filePath) {
  return app.fileReviewSnapshotsByKey.get(app.fileProgressStateKey(filePath));
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
    intersectionObserverClass = null,
    lineLayoutReads = null,
    lockManager = null,
    resizeObserverClass = null,
    setupWindow = null,
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
  dom.window.ResizeObserver =
    resizeObserverClass ??
    class ResizeObserver {
      observe() {}
      disconnect() {}
    };
  if (intersectionObserverClass) {
    dom.window.IntersectionObserver = intersectionObserverClass;
  }
  if (lineLayoutReads) {
    const getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    dom.window.getComputedStyle = (element, pseudoElement) => {
      if (
        element.matches?.(
          ".blob-code-addition, .blob-code-deletion, .diff-text-cell",
        )
      ) {
        lineLayoutReads.push(element);
      }
      return getComputedStyle(element, pseudoElement);
    };
  }
  setupWindow?.(dom.window);

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

function largeChangedBlockFixture(
  lineCount = 200,
  lineWidth = 96,
  { hunkSize = lineCount } = {},
) {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const prefix = `+line-${String(index).padStart(4, "0")}-`;
    const text = `${prefix}${"x".repeat(lineWidth - prefix.length)}`;
    const hunkLineCount = Math.min(hunkSize, lineCount - index);
    const hunkHeader =
      index % hunkSize === 0
        ? `<tr><td class="blob-code-hunk">@@ -${index + 1},0 +${
            index + 1
          },${hunkLineCount} @@</td></tr>`
        : "";
    return `${hunkHeader}<tr><td class="blob-code-addition">${text}</td></tr>`;
  }).join("");
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/large.js">
        <div class="file-header"><span class="file-info">src/large.js</span></div>
        <table><tbody>
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

function semanticMergeableHunkFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/semantic-merge.js">
        <div class="file-header"><span class="file-info">src/semantic-merge.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@ function first() {</td></tr>
          <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
          <tr><td class="blob-code-hunk">@@ -10 +10 @@ function second() {</td></tr>
          <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
          <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>
          <tr><td class="blob-code-hunk"><button class="js-expand" aria-label="Expand up">Expand</button>@@ -20 +20 @@ function third() {</td></tr>
          <tr><td class="blob-num">19</td><td class="blob-code-context">before third</td></tr>
          <tr><td class="blob-num">20</td><td class="blob-code-addition">+third</td></tr>
          <tr><td class="blob-num">21</td><td class="blob-code-context">after third</td></tr>
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
  return `<div class="js-diff-load-container">
    <div class="load-diff-placeholder">
      <div class="loading-skeleton">Loading preview</div>
      <button>Load Diff</button>
      <span class="load-diff-message">Large diffs are not rendered by default.</span>
    </div>
  </div>`;
}

function loadDiffFixture({
  activeLoading = false,
  loaded = false,
  nonHunk = false,
  reactRegionLoading = false,
  staticLoadMore = false,
} = {}) {
  const content = loaded
    ? `<div class="js-diff-load-container">
        ${
          activeLoading
            ? '<span data-component="loadingSpinner"><span data-component="Spinner">Loading</span></span>'
            : ""
        }
        ${
          staticLoadMore
            ? '<button data-testid="load-more-lines">Load more lines</button>'
            : ""
        }
        ${
          nonHunk
            ? '<div class="binary-diff">Binary file not shown.</div>'
            : `<table><tbody>
                <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
                <tr><td class="blob-num">1</td><td class="blob-code-addition">+loaded</td></tr>
              </tbody></table>`
        }
      </div>`
    : loadDiffPlaceholderHtml();
  return `<!doctype html>
    <html><body>
      <div id="diff-large" class="js-file" data-file-path="src/large-diff.js"${
        reactRegionLoading
          ? ' role="region" aria-label="Loading src/large-diff.js"'
          : ""
      }>
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

function replaceSemanticMergeFixtureRows(document, { changed = false } = {}) {
  const tbody = document.querySelector("tbody");
  tbody.innerHTML =
    `<tr><td class="blob-code-hunk">@@ -1,20 +1,20 @@ function merged() {</td></tr>
     <tr><td class="blob-num">0</td><td class="blob-code-context">merged before</td></tr>
     <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
     <tr><td class="blob-num">5</td><td class="blob-code-context">between first and second</td></tr>
     <tr><td class="blob-num">10</td><td class="blob-code-addition">${changed ? "+changed" : "+second"}</td></tr>
     <tr><td class="blob-num">15</td><td class="blob-code-context">between second and third</td></tr>
     <tr><td class="blob-num">20</td><td class="blob-code-addition">+third</td></tr>
     <tr><td class="blob-num">21</td><td class="blob-code-context">merged after</td></tr>`;
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
            <button class="js-expand-all-difflines-button" data-file-path="src/modern.ts" aria-label="Expand all lines: src/modern.ts">Expand lines</button>
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

function currentReactContextExpansionFixture() {
  const fileEntry = ({ path, suffix }) => `
    <div class="PullRequestDiffsList-module__diffEntry__${suffix}">
      <div role="region" class="Diff-module__diffTargetable__${suffix} Diff-module__diff__${suffix}">
        <div class="Diff-module__diffHeaderWrapper__${suffix}">
          <div class="DiffFileHeader-module__diff-file-header__${suffix}">
            <div class="DiffFileHeader-module__file-path-section__${suffix}">
              <h3><a href="#diff-${suffix}"><code>${path}</code></a></h3>
              <button class="js-expand-all-difflines-button" data-file-path="${path}" aria-label="Expand all lines: ${path}">Expand lines</button>
            </div>
          </div>
        </div>
        <table role="grid" aria-label="Diff for: ${path}"><tbody>
          <tr class="diff-line-row">
            <td role="gridcell" class="diff-hunk-cell">
              <button class="Button ExpandableHunkHeaderDiffLine-module__expand-button-line__${suffix}" aria-label="Expand file from line 2 to line 9">Expand</button>
              @@ -10 +10 @@
            </td>
          </tr>
          <tr class="diff-line-row" data-line-type="addition">
            <td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-${suffix}R10">
              <code class="addition" data-diff-side="right">+${suffix}</code>
            </td>
          </tr>
        </tbody></table>
      </div>
    </div>`;
  return `<!doctype html>
    <html><body>
      <div data-testid="progressive-diffs-list">
        ${fileEntry({ path: "src/react-one.js", suffix: "one" })}
        ${fileEntry({ path: "src/react-two.js", suffix: "two" })}
      </div>
    </body></html>`;
}

function currentReactSplitContextExpansionFixture() {
  return `<!doctype html>
    <html><body>
      <div data-testid="progressive-diffs-list">
        <div class="PullRequestDiffsList-module__diffEntry__split">
          <div id="diff-split" role="region" class="Diff-module__diffTargetable__split Diff-module__diff__split">
            <div class="Diff-module__diffHeaderWrapper__split">
              <div class="DiffFileHeader-module__diff-file-header__split">
                <h3><a href="#diff-split"><code>src/react-split.js</code></a></h3>
              </div>
            </div>
            <table role="grid" aria-label="Diff for: src/react-split.js"><tbody>
              <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell focusable-grid-cell left-side"><button class="Button ExpandableHunkHeaderDiffLine-module__expand-button-line__split" aria-label="Expand file up from line 10">Expand</button>@@ -10 +10 @@ split()</td></tr>
              <tr class="diff-line-row">
                <td role="gridcell" class="focusable-grid-cell new-diff-line-number left-side" data-diff-side="left">10</td>
                <td role="gridcell" class="diff-text-cell focusable-grid-cell left-side-diff-cell" data-diff-side="left" data-line-anchor="diff-split-L10"><code class="diff-text deletion"><span class="diff-text-marker">-</span><span class="diff-text-inner">oldValue</span></code></td>
                <td role="gridcell" class="focusable-grid-cell new-diff-line-number left-side" data-diff-side="right">10</td>
                <td role="gridcell" class="diff-text-cell focusable-grid-cell right-side-diff-cell" data-diff-side="right" data-line-anchor="diff-split-R10"><code class="diff-text addition"><span class="diff-text-marker">+</span><span class="diff-text-inner">newValue</span></code></td>
              </tr>
            </tbody></table>
          </div>
        </div>
      </div>
    </body></html>`;
}

function currentReactOverlappingContextExpansionFixture() {
  return `<!doctype html>
    <html><body>
      <div data-testid="progressive-diffs-list">
        <div class="PullRequestDiffsList-module__diffEntry__overlap">
          <div role="region" class="Diff-module__diffTargetable__overlap Diff-module__diff__overlap">
            <div class="Diff-module__diffHeaderWrapper__overlap">
              <div class="DiffFileHeader-module__diff-file-header__overlap">
                <div class="DiffFileHeader-module__file-path-section__overlap">
                  <h3><a href="#diff-overlap"><code>src/react-overlap.js</code></a></h3>
                  <button class="js-expand-all-difflines-button" data-file-path="src/react-overlap.js" aria-label="Expand all lines: src/react-overlap.js">Expand lines</button>
                </div>
              </div>
            </div>
            <table role="grid" aria-label="Diff for: src/react-overlap.js"><tbody>
              <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1 +1 @@ first()</td></tr>
              <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R1"><code class="addition" data-diff-side="right">+first</code></td></tr>
              <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -10 +10 @@ second()</td></tr>
              <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R10"><code class="addition" data-diff-side="right">+second</code></td></tr>
              <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell"><button class="Button ExpandableHunkHeaderDiffLine-module__expand-button-line__overlap" aria-label="Expand file down from line 12">Expand down</button><button class="Button ExpandableHunkHeaderDiffLine-module__expand-button-line__overlap" aria-label="Expand file up from line 20">Expand up</button>@@ -20 +20 @@ third()</td></tr>
              <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R20"><code class="addition" data-diff-side="right">+third</code></td></tr>
            </tbody></table>
          </div>
        </div>
      </div>
    </body></html>`;
}

function replaceCurrentReactOverlappingContextRows(document) {
  document.querySelector('[aria-label="Diff for: src/react-overlap.js"] tbody')
    .innerHTML = `
      <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1,20 +1,20 @@ merged()</td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">merged before</td></tr>
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R1"><code class="addition" data-diff-side="right">+first</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">between first and second</td></tr>
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R10"><code class="addition" data-diff-side="right">+second</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">between second and third</td></tr>
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R20"><code class="addition" data-diff-side="right">+third</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">merged after</td></tr>`;
}

function currentReactMergedExpansionTable(
  document,
  { secondLine = "+second" } = {},
) {
  const table = document.createElement("table");
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", "Diff for: src/react-overlap.js");
  table.innerHTML = `<tbody>
    <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1,20 +1,20 @@ merged()</td></tr>
    <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">merged before</td></tr>
    <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R1"><code class="addition" data-diff-side="right">+first</code></td></tr>
    <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">between first and second</td></tr>
    <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R10"><code class="addition" data-diff-side="right">${secondLine}</code></td></tr>
    <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">between second and third</td></tr>
    <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R20"><code class="addition" data-diff-side="right">+third</code></td></tr>
    <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell">merged after</td></tr>
  </tbody>`;
  return table;
}

function currentReactContextEvidenceFixture() {
  const fixtureDom = new JSDOM(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const { document } = fixtureDom.window;
    const addContextRow = (changedRow, text, position) => {
      const row = document.createElement("tr");
      row.className = "diff-line-row";
      row.setAttribute("data-line-type", "context");
      row.innerHTML =
        '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
        `<code class="diff-text" data-diff-side="right">${text}</code>` +
        "</td>";
      changedRow[position](row);
    };
    [
      ["diff-overlap-R1", "first"],
      ["diff-overlap-R10", "second"],
      ["diff-overlap-R20", "third"],
    ].forEach(([anchor, name]) => {
      const changedRow = document
        .querySelector(`[data-line-anchor="${anchor}"]`)
        .closest("tr");
      addContextRow(changedRow, `before ${name}`, "before");
      addContextRow(changedRow, `after ${name}`, "after");
    });
    return fixtureDom.serialize();
  } finally {
    fixtureDom.window.close();
  }
}

function replaceCurrentReactContextEvidenceRows(
  document,
  {
    headerText = "@@ -1,20 +1,20 @@ merged()",
    insertNearChanged = false,
    replaceSecondContext = false,
  } = {},
) {
  document.querySelector('[aria-label="Diff for: src/react-overlap.js"] tbody')
    .innerHTML = `
      <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">${headerText}</td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">before first</code></td></tr>
      ${insertNearChanged ? '<tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">inserted near first</code></td></tr>' : ""}
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R1"><code class="addition" data-diff-side="right">+first</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">after first</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">inserted between first and second</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">${replaceSecondContext ? "replaced before second" : "before second"}</code></td></tr>
      ${insertNearChanged ? '<tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">inserted near second</code></td></tr>' : ""}
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R10"><code class="addition" data-diff-side="right">+second</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">after second</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">inserted between second and third</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">before third</code></td></tr>
      ${insertNearChanged ? '<tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">inserted near third</code></td></tr>' : ""}
      <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-overlap-R20"><code class="addition" data-diff-side="right">+third</code></td></tr>
      <tr class="diff-line-row" data-line-type="context"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">after third</code></td></tr>`;
}

function appendCurrentReactTrailingContextEvidence(document, text) {
  const row = document.createElement("tr");
  row.className = "diff-line-row";
  row.setAttribute("data-line-type", "context");
  row.innerHTML =
    '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
    `<code class="diff-text" data-diff-side="right">${text}</code>` +
    "</td>";
  document
    .querySelector('[aria-label="Diff for: src/react-overlap.js"] tbody')
    .append(row);
  return row;
}

function currentReactMergedContextEvidenceTable(
  document,
  {
    headerText = "@@ -1,20 +1,20 @@ merged()",
    insertNearChanged = false,
    trailingContext = "far trailing context",
  } = {},
) {
  const fixtureDom = new JSDOM(currentReactContextEvidenceFixture());
  try {
    replaceCurrentReactContextEvidenceRows(fixtureDom.window.document, {
      headerText,
      insertNearChanged,
    });
    appendCurrentReactTrailingContextEvidence(
      fixtureDom.window.document,
      trailingContext,
    );
    return document.importNode(
      fixtureDom.window.document.querySelector(
        '[aria-label="Diff for: src/react-overlap.js"]',
      ),
      true,
    );
  } finally {
    fixtureDom.window.close();
  }
}

function currentReactCachedExpandAllTable(document, options = {}) {
  return currentReactMergedContextEvidenceTable(document, {
    ...options,
    headerText: "@@ -1,20 +1,20 @@ first()",
    insertNearChanged: true,
  });
}

function moveCurrentReactSecondContextAfterChangedLine(searchRoot) {
  const changedSecond = searchRoot
    .querySelector('[data-line-anchor="diff-overlap-R10"]')
    .closest("tr");
  const beforeSecond = Array.from(
    changedSecond.parentElement.children,
  ).find((row) => row.textContent.trim() === "before second");
  changedSecond.after(beforeSecond);
}

function currentReactBlankContextEvidenceFixture() {
  const fixtureDom = new JSDOM(currentReactContextEvidenceFixture());
  try {
    const { document } = fixtureDom.window;
    const changedSecond = document
      .querySelector('[data-line-anchor="diff-overlap-R10"]')
      .closest("tr");
    const blankContext = document.createElement("tr");
    blankContext.className = "diff-line-row";
    blankContext.dataset.contextEvidence = "blank";
    blankContext.innerHTML = `
      <td role="gridcell" class="new-diff-line-number left-side">9</td>
      <td role="gridcell" class="diff-text-cell left-side-diff-cell"><code class="diff-text syntax-highlighted-line" data-diff-side="left"></code></td>
      <td role="gridcell" class="new-diff-line-number right-side">9</td>
      <td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text syntax-highlighted-line" data-diff-side="right"></code></td>`;
    changedSecond.before(blankContext);
    return fixtureDom.serialize();
  } finally {
    fixtureDom.window.close();
  }
}

function insertCurrentReactBlankContextAfterSecondLine(searchRoot) {
  const fixtureDom = new JSDOM(currentReactBlankContextEvidenceFixture());
  try {
    const document = searchRoot.ownerDocument ?? searchRoot;
    const blankContext = document.importNode(
      fixtureDom.window.document.querySelector(
        '[data-context-evidence="blank"]',
      ),
      true,
    );
    searchRoot
      .querySelector('[data-line-anchor="diff-overlap-R10"]')
      .closest("tr")
      .after(blankContext);
    return blankContext;
  } finally {
    fixtureDom.window.close();
  }
}

function replaceCurrentReactDirectionalRegion(
  document,
  {
    firstHeader = "@@ -1 +1 @@ first()",
    nextDownLabel = "Expand file down from line 13",
  } = {},
) {
  const fixtureDom = new JSDOM(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const previousRegion = document.querySelector(
      '[role="region"].Diff-module__diff__overlap',
    );
    const replacementRegion = document.importNode(
      fixtureDom.window.document.querySelector(
        '[role="region"].Diff-module__diff__overlap',
      ),
      true,
    );
    replacementRegion.querySelector(".diff-hunk-cell").textContent =
      firstHeader;
    const downControl = replacementRegion.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    downControl.setAttribute("aria-label", nextDownLabel);
    const contextRow = document.createElement("tr");
    contextRow.className = "diff-line-row";
    contextRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell left-side-diff-cell" data-diff-side="left"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>' +
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>';
    downControl.closest("tr").before(contextRow);
    previousRegion.replaceWith(replacementRegion);
    return { previousRegion, replacementRegion };
  } finally {
    fixtureDom.window.close();
  }
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


module.exports = {
  test,
  assert,
  path,
  JSDOM,
  Core,
  LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE,
  LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE,
  lineReviewContextFingerprint,
  root,
  withViewerMeta,
  createChromeApi,
  createExclusiveLockManager,
  createDeferred,
  installContentStyles,
  syncStickyHunkContentInset,
  holdReviewStorageLock,
  delayReviewStorageSet,
  delayReviewStorageRemove,
  delayReviewStorageRead,
  recordCachedDiscoveryRoots,
  controllersFor,
  contextExpansionIntentFor,
  fileReviewSnapshotFor,
  controllerAt,
  stopExtensions,
  startSharedExtensions,
  startLockedExtension,
  seedOfficialSuppression,
  seedSharedOfficialSuppression,
  officialViewedContext,
  officialFileContext,
  captureWarnings,
  changeCheckbox,
  lineControls,
  setOfficialViewed,
  respondToOfficialClicks,
  assertOfficialIntentSettled,
  waitFor,
  assertFileRevealState,
  startExtension,
  duplicateHunkFixture,
  largeChangedBlockFixture,
  mergeableHunkFixture,
  semanticMergeableHunkFixture,
  commitSelectionFixture,
  initiallyViewedCommitSelectionFixture,
  loadDiffPlaceholderHtml,
  loadDiffFixture,
  hiddenLargeDiffFixture,
  nonHunkDiffFixture,
  evolvingCommitFixture,
  replacePageBody,
  replaceMergeFixtureRows,
  replaceSemanticMergeFixtureRows,
  splitFixture,
  dragFixture,
  modernGridFixture,
  currentReactContextExpansionFixture,
  currentReactSplitContextExpansionFixture,
  currentReactOverlappingContextExpansionFixture,
  replaceCurrentReactOverlappingContextRows,
  currentReactMergedExpansionTable,
  currentReactContextEvidenceFixture,
  replaceCurrentReactContextEvidenceRows,
  appendCurrentReactTrailingContextEvidence,
  currentReactMergedContextEvidenceTable,
  currentReactCachedExpandAllTable,
  moveCurrentReactSecondContextAfterChangedLine,
  currentReactBlankContextEvidenceFixture,
  insertCurrentReactBlankContextAfterSecondLine,
  replaceCurrentReactDirectionalRegion,
  contextualLineFixture,
};
