const {
  test,
  assert,
  path,
  JSDOM,
  Core,
  LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE,
  LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE,
  createChromeApi,
  createDeferred,
  createExclusiveLockManager,
  delayReviewStorageRemove,
  delayReviewStorageSet,
  installContentStyles,
  controllersFor,
  controllerAt,
  stopExtensions,
  startLockedExtension,
  captureWarnings,
  changeCheckbox,
  lineControls,
  waitFor,
  startExtension,
  duplicateHunkFixture,
  commitSelectionFixture,
  splitFixture,
  initiallyViewedCommitSelectionFixture,
  replacePageBody,
  dragFixture,
  modernGridFixture,
  loadDiffFixture,
  currentReactContextExpansionFixture,
  currentReactContextEvidenceFixture,
  currentReactSplitContextExpansionFixture,
  contextualLineFixture,
} = require("./content-test-support.cjs");

function manyFileHunkFixture(fileCount) {
  const files = Array.from({ length: fileCount }, (_, index) => `
    <div class="PullRequestDiffsList-module__diffEntry__chunk-${index}">
      <div role="region" id="diff-chunk-${index}"
        class="Diff-module__diffTargetable__chunk Diff-module__diff__chunk">
        <div class="Diff-module__diffHeaderWrapper__chunk">
          <div class="DiffFileHeader-module__diff-file-header__chunk">
            <h3><code>src/chunk-${index}.js</code></h3>
          </div>
        </div>
        <table role="grid" aria-label="Diff for: src/chunk-${index}.js">
          <tbody>
            <tr class="diff-line-row">
              <td role="gridcell" class="diff-hunk-cell">
                @@ -${index + 1} +${index + 1} @@
              </td>
            </tr>
            <tr class="diff-line-row" data-line-type="addition">
              <td role="gridcell"
                class="diff-text-cell right-side-diff-cell"
                data-line-anchor="diff-chunk-${index}-R${index + 1}">
                <code class="addition" data-diff-side="right">+chunk ${index}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`).join("");
  return `<!doctype html><html><body>${files}</body></html>`;
}

function fileGridFor(dom, filePath) {
  const fileGrid = dom.window.document.querySelector(
    `[aria-label="Diff for: ${filePath}"]`,
  );
  assert.ok(fileGrid);
  return fileGrid;
}

function controllersForFile(app, filePath) {
  return controllersFor(app).filter(
    (controller) => controller.filePath === filePath,
  );
}

function controllerForFile(app, filePath) {
  const [controller] = controllersForFile(app, filePath);
  assert.ok(controller);
  return controller;
}

function appendDiffLoader(dom, fileGrid, label = "Loading diff") {
  const loader = dom.window.document.createElement("tr");
  loader.setAttribute("data-component", "loadingSpinner");
  loader.innerHTML = `<td role="progressbar">${label}</td>`;
  fileGrid.querySelector("tbody").append(loader);
  return loader;
}

function appendAdditionHunk(
  dom,
  fileGrid,
  { anchor = null, before = null, lineNumber, text },
) {
  const hunkRow = dom.window.document.createElement("tr");
  hunkRow.className = "diff-line-row";
  hunkRow.innerHTML =
    `<td role="gridcell" class="diff-hunk-cell">` +
    `@@ -${lineNumber} +${lineNumber} @@</td>`;
  const lineRow = dom.window.document.createElement("tr");
  lineRow.className = "diff-line-row";
  lineRow.setAttribute("data-line-type", "addition");
  lineRow.innerHTML =
    '<td role="gridcell" class="diff-text-cell right-side-diff-cell" ' +
    `data-line-anchor="${anchor ?? `diff-contract-R${lineNumber}`}">` +
    `<code class="addition" data-diff-side="right">${text}</code></td>`;
  if (before) {
    before.before(hunkRow, lineRow);
  } else {
    fileGrid.querySelector("tbody").append(hunkRow, lineRow);
  }
  return { hunkRow, lineRow };
}

async function hydrationQueueContract(filePaths, constantOverrides = {}) {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body></body></html>",
  );
  app.observer.disconnect();
  app.constants = {
    ...app.constants,
    DIFF_LOAD_FILE_HYDRATION_CONCURRENCY: 2,
    DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_CONCURRENCY: 1,
    DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_DELAY_MS: 0,
    DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 10,
    ...constantOverrides,
  };
  app.settleDeferredDiffLoadRefreshes = () => false;
  const elements = new Map();
  const rects = new Map();
  const gates = new Map();
  const started = [];
  let running = 0;
  let maxRunning = 0;
  filePaths.forEach((filePath) => {
    const fileElement = dom.window.document.createElement("section");
    fileElement.className = "js-file";
    fileElement.dataset.filePath = filePath;
    fileElement.innerHTML = `<div><code>${filePath}</code></div>`;
    rects.set(filePath, { bottom: 5_200, top: 5_000 });
    fileElement.getBoundingClientRect = () => rects.get(filePath);
    dom.window.document.body.append(fileElement);
    elements.set(filePath, fileElement);
  });
  app.hydrateDiffLoadFile = async (_fileElement, filePath) => {
    started.push(filePath);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => gates.set(filePath, resolve));
    running -= 1;
    return 0;
  };
  return {
    app,
    dom,
    elements,
    get maxRunning() {
      return maxRunning;
    },
    release(filePath) {
      gates.get(filePath)?.();
    },
    schedule(filePath) {
      return app.scheduleDiffLoadFileHydration(
        filePath,
        elements.get(filePath),
      );
    },
    setRect(filePath, rect) {
      rects.set(filePath, rect);
    },
    started,
    stop() {
      gates.forEach((resolve) => resolve());
      app.stop();
      dom.window.close();
    },
  };
}

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

test("keeps the maximum line-state payload below Chrome's local quota", async () => {
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
        baselineContextFingerprint: "B".repeat(43),
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
    let capturedPointerId = null;
    controller.lines[0].control.setPointerCapture = (pointerId) => {
      capturedPointerId = pointerId;
    };
    controller.lines[0].control.hasPointerCapture = (pointerId) =>
      capturedPointerId === pointerId;
    controller.lines[0].control.releasePointerCapture = (pointerId) => {
      assert.equal(pointerId, capturedPointerId);
      capturedPointerId = null;
    };

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
    assert.equal(capturedPointerId, 7);
    assert.equal(
      controller.lines[0].control.classList.contains(
        "hunkmark-line-dragging",
      ),
      true,
    );
    assert.equal(
      dom.window.document.body.classList.contains("hunkmark-line-dragging"),
      false,
    );
    assert.equal(app.dragState.rangePrepared, false);
    assert.equal(app.dragState.indexByLine.size, 1);
    assert.equal(app.dragState.endpointIndex, 0);
    let progressUpdates = 0;
    const updateProgressForControllers =
      app.updateProgressForControllers.bind(app);
    app.updateProgressForControllers = (controllers) => {
      progressUpdates += 1;
      return updateProgressForControllers(controllers);
    };
    dom.window.scrollBy = () => {};
    const pointerMove = new dom.window.Event("pointermove", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(pointerMove, {
      clientY: { value: 0 },
      pointerId: { value: 7 },
    });
    app.lineDragPointerMove(pointerMove);
    assert.equal(pointerMove.defaultPrevented, true);
    assert.equal(app.dragState.rangePrepared, false);
    assert.equal(progressUpdates, 0);
    app.touchLineRange(controller.lines[0]);
    assert.equal(app.dragState.rangePrepared, false);
    assert.equal(app.dragState.indexByLine.size, 1);
    assert.equal(progressUpdates, 0);
    app.dragState.orderedLines.indexOf = () => {
      throw new Error("drag range lookup must use the cached line index");
    };
    app.touchLineRange(controller.lines[2]);
    assert.equal(app.dragState.rangePrepared, true);
    assert.equal(app.dragState.indexByLine.size, 3);
    assert.equal(progressUpdates, 1);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, true],
    );
    app.touchLineRange(controller.lines[2]);
    assert.equal(progressUpdates, 1);

    app.touchLineRange(controller.lines[1]);
    assert.equal(progressUpdates, 2);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, false],
    );
    await app.finishLineDrag(true);
    assert.equal(
      controller.lines[0].control.classList.contains(
        "hunkmark-line-dragging",
      ),
      false,
    );
    assert.equal(capturedPointerId, null);

    assert.equal(
      Object.keys(chrome.snapshot()).filter((key) => key.includes(":line:"))
        .length,
      2,
    );
    assert.equal(controller.indeterminate, true);

    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 600;
    controller.lines[2].control.focus();
    app.orderedLinesForDrag = () => {
      throw new Error("a single-line click must not prepare a drag range");
    };
    app.startLineDrag(controller.lines[2], true, 8);
    assert.equal(app.dragState.rangePrepared, false);
    await app.finishLineDrag(true);
    await waitFor(() => {
      assert.equal(scrollCalls.length, 1);
    });
    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
    assert.ok(chrome.snapshot()[controller.collapsedKey]);
    assert.equal(dom.window.document.activeElement, controller.input);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("updates interaction progress only for affected files", async () => {
  const { app, dom } = await startExtension(`<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/first.js">
        <div class="file-header"><span class="file-info">src/first.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
        </tbody></table>
      </div>
      <div class="js-file" data-file-path="src/second.js">
        <div class="file-header"><span class="file-info">src/second.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+second</td></tr>
        </tbody></table>
      </div>
    </body></html>`);
  try {
    await waitFor(() => assert.equal(app.controllersByRow.size, 2));
    const controllers = Array.from(app.controllersByRow.values()).sort((a, b) =>
      a.filePath.localeCompare(b.filePath),
    );
    const [first, second] = controllers;
    const secondProgress = second.fileElement.querySelector(
      ".hunkmark-file-progress",
    );
    assert.equal(secondProgress.textContent, "Hunks 0/1 · Lines 0/1");

    const renderedFiles = [];
    let panelEnsures = 0;
    const renderFileProgress = app.renderFileProgress.bind(app);
    const ensurePanel = app.ensurePanel.bind(app);
    app.renderFileProgress = (fileElement, state) => {
      renderedFiles.push(fileElement.dataset.filePath);
      return renderFileProgress(fileElement, state);
    };
    app.ensurePanel = () => {
      panelEnsures += 1;
      return ensurePanel();
    };
    first.lines[0].marked = true;
    app.updateAggregateFromLines(first);
    app.updateProgressForControllers([first]);

    assert.deepEqual(renderedFiles, ["src/first.js"]);
    assert.equal(panelEnsures, 0);
    assert.equal(secondProgress.textContent, "Hunks 0/1 · Lines 0/1");
    assert.equal(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      "Hunks 1 / 2 · Lines 1 / 2",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("coalesces background hydration progress scans", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      PROGRESS_UPDATE_DELAY_MS: 20,
    };
    let progressUpdates = 0;
    const updateProgressForControllers =
      app.updateProgressForControllers.bind(app);
    app.updateProgressForControllers = (...args) => {
      progressUpdates += 1;
      return updateProgressForControllers(...args);
    };
    const controller = controllerAt(app);
    const renderedFilePaths = [];
    const renderFileProgress = app.renderFileProgress.bind(app);
    app.renderFileProgress = (fileElement, state) => {
      renderedFilePaths.push(app.knownFilePath(fileElement));
      return renderFileProgress(fileElement, state);
    };

    app.scheduleProgressUpdate([controller]);
    app.scheduleProgressUpdate([controller]);
    app.scheduleProgressUpdate([controller]);

    await waitFor(() => assert.equal(progressUpdates, 1));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(progressUpdates, 1);
    assert.deepEqual(renderedFilePaths, [controller.filePath]);
    assert.equal(app.progressUpdateTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("finds drag endpoints logarithmically with stable row boundaries", async () => {
  const { app, dom } = await startExtension(dragFixture());
  try {
    let rectReads = 0;
    const lines = Array.from({ length: 128 }, (_, index) => ({
      element: {
        compareDocumentPosition(other) {
          return index < other.documentIndex
            ? dom.window.Node.DOCUMENT_POSITION_FOLLOWING
            : dom.window.Node.DOCUMENT_POSITION_PRECEDING;
        },
        documentIndex: index,
        getBoundingClientRect() {
          rectReads += 1;
          return { bottom: index * 30 + 20, top: index * 30 };
        },
      },
    }));
    assert.equal(app.dragLinesAreInDocumentOrder(lines), true);
    const moved = lines.slice();
    [moved[63], moved[64]] = [moved[64], moved[63]];
    assert.equal(app.dragLinesAreInDocumentOrder(moved), false);

    app.dragState = {
      anchorIndex: 64,
      anchorLine: lines[64],
      orderedLines: lines,
      rangePrepared: true,
    };
    const endpointAt = (clientY, expectedIndex) => {
      rectReads = 0;
      assert.equal(app.dragEndpointAtY(clientY), lines[expectedIndex]);
      assert.equal(rectReads <= 9, true);
    };
    endpointAt(64 * 30 + 10, 64);
    endpointAt(63 * 30 + 25, 64);
    endpointAt(63 * 30 + 20, 63);
    endpointAt(-1, 0);
    endpointAt(64 * 30 + 25, 64);
    endpointAt(65 * 30, 65);
    endpointAt(128 * 30, 127);
  } finally {
    app.dragState = null;
    app.stop();
    dom.window.close();
  }
});

test("builds drag order without forcing hunk layout", async () => {
  const { app, dom } = await startExtension(`<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/drag-order.js">
        <div class="file-header"><span class="file-info">src/drag-order.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-code-hunk">@@ -3 +3 @@</td></tr>
          <tr><td class="blob-num">3</td><td class="blob-code-addition">+second</td></tr>
        </tbody></table>
      </div>
    </body></html>`);
  try {
    await waitFor(() => assert.equal(app.controllersByRow.size, 2));
    const controllers = Array.from(app.controllersByRow.values());
    controllers.forEach((controller) => {
      controller.hunkRow.getClientRects = () => {
        throw new Error("drag ordering must not force hunk layout");
      };
    });

    assert.deepEqual(
      Array.from(app.orderedLinesForDrag(controllers[0].lines[0])),
      [controllers[0].lines[0], controllers[1].lines[0]],
    );
    controllers[1].hunkRow.setAttribute("aria-hidden", "true");
    assert.deepEqual(
      Array.from(app.orderedLinesForDrag(controllers[0].lines[0])),
      [controllers[0].lines[0]],
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps optimistic line clears stable across multi-step persistence", async (t) => {
  const autoCollapsePreferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
  const scenarios = [
    {
      clear: (app, controller) =>
        app.setLineViewed(controller.lines[0], false),
      name: "direct line mutation",
    },
    {
      clear: async (app, controller) => {
        app.startLineDrag(controller.lines[0], false, 73);
        await app.finishLineDrag(true);
      },
      name: "single-line pointer mutation",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(splitFixture(), {
        [autoCollapsePreferenceKey]: false,
      });
      try {
        const controller = controllerAt(app);
        await app.setHunkViewed(controller, true);
        assert.equal(controller.lines.every((line) => line.marked), true);

        const appearances = [];
        const applyControllerAppearance =
          app.applyControllerAppearance.bind(app);
        app.applyControllerAppearance = (candidate) => {
          if (candidate === controller) {
            appearances.push(candidate.lines.map((line) => line.marked));
          }
          return applyControllerAppearance(candidate);
        };

        await scenario.clear(app, controller);

        assert.equal(appearances.length > 0, true);
        assert.equal(
          appearances.every((marks) => marks.every((marked) => !marked)),
          true,
        );
        assert.equal(controller.lines.every((line) => !line.marked), true);
        assert.equal(
          app.reviewAppearancePersistenceCountByController.size,
          0,
        );
      } finally {
        app.stop();
        dom.window.close();
      }
    });
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

test("propagates GitHub Viewed sync enablement to completed open tabs", async () => {
  const preferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`;
  const sharedChrome = createChromeApi({ [preferenceKey]: false });
  const first = await startExtension(splitFixture(), {}, {
    chromeInstance: sharedChrome,
  });
  const second = await startExtension(splitFixture(), {}, {
    chromeInstance: sharedChrome,
  });
  try {
    const tabs = [first, second];
    const officialClicks = [0, 0];
    tabs.forEach(({ dom }, index) => {
      const control = dom.window.document.querySelector(
        'button[aria-label="Not Viewed"]',
      );
      control.addEventListener("click", () => {
        officialClicks[index] += 1;
        control.setAttribute("aria-label", "Viewed");
        control.setAttribute("aria-pressed", "true");
      });
    });

    await second.app.setHunkViewed(controllerAt(second.app), true);
    await waitFor(() => {
      assert.equal(
        tabs.every(({ app }) => controllerAt(app).marked),
        true,
      );
    });
    assert.deepEqual(officialClicks, [0, 0]);

    const firstInput = first.dom.window.document.querySelector(
      'input[aria-label="Sync GitHub file Viewed"]',
    );
    changeCheckbox(first.dom, firstInput, true);
    await waitFor(() => {
      assert.equal(
        tabs.every(({ app }) => app.syncOfficialViewedEnabled),
        true,
      );
      assert.equal(
        tabs.every(({ dom }) =>
          dom.window.document.querySelector(
            'input[aria-label="Sync GitHub file Viewed"]',
          ).checked,
        ),
        true,
      );
      assert.deepEqual(officialClicks, [1, 1]);
    });
  } finally {
    stopExtensions(first, second);
  }
});

test("restores GitHub Viewed sync when its preference write fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const input = dom.window.document.querySelector(
      'input[aria-label="Sync GitHub file Viewed"]',
    );
    const warnings = captureWarnings(dom);
    chrome.failNextSet();

    changeCheckbox(dom, input, false);
    await waitFor(() => {
      assert.equal(input.disabled, false);
      assert.equal(input.checked, true);
      assert.equal(app.syncOfficialViewedEnabled, true);
      assert.equal(
        app.officialViewedSyncPreferenceKey in chrome.snapshot(),
        false,
      );
    });
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0][0],
      /could not save GitHub Viewed synchronization/,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps GitHub Viewed sync enabled when immediate DOM sync fails", async () => {
  const preferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`;
  const { app, chrome, dom } = await startExtension(
    splitFixture(),
    { [preferenceKey]: false },
  );
  try {
    await app.setHunkViewed(controllerAt(app), true);
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.click = () => {
      throw new Error("GitHub control failed");
    };
    const warnings = captureWarnings(dom);

    await app.setOfficialViewedSync(true);

    const input = dom.window.document.querySelector(
      'input[aria-label="Sync GitHub file Viewed"]',
    );
    assert.equal(app.syncOfficialViewedEnabled, true);
    assert.equal(input.checked, true);
    assert.equal(input.disabled, false);
    assert.equal(chrome.snapshot()[preferenceKey], true);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0][0],
      /could not apply GitHub Viewed synchronization/,
    );
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

test("does not auto-return when collapsed state cannot be reconciled", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const [current] = controllersFor(app);
    const warnings = captureWarnings(dom);
    current.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    app.setReviewStorage = async () => {
      throw new Error("storage write failed");
    };
    app.getLocalStorage = async () => {
      throw new Error("storage reconciliation failed");
    };
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);

    await app.setCollapsed(current, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(warnings.length, 1);
    assert.equal(current.collapsed, true);
    assert.equal(current.collapseButton.disabled, false);
    assert.equal(scrollCalls.length, 0);
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
    let stickyLayoutUpdates = 0;
    app.updateStickyHunkLayouts = () => {
      stickyLayoutUpdates += 1;
    };
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(diffChecks, 0);
    assert.equal(stickyLayoutUpdates, 0);
    assert.equal(app.hunkStickyLayoutFrameId, null);
    assert.equal(app.currentScope, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("yields between interaction-sensitive phases of a large refresh", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    let yields = 0;
    Object.defineProperty(dom.window, "scheduler", {
      configurable: true,
      value: {
        async yield() {
          yields += 1;
        },
      },
    });
    await app.yieldForLargeRefreshInteraction(
      app.constants.LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD - 1,
    );
    assert.equal(yields, 0);

    app.constants = {
      ...app.constants,
      LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
    };
    await app.refresh();

    assert.equal(yields, 2);
    assert.equal(app.refreshQueued, false);
    assert.equal(app.refreshRunning, false);
    assert.equal(controllersFor(app).length, 2);

    controllersFor(app).forEach((controller) =>
      app.destroyController(controller),
    );
    assert.equal(controllersFor(app).length, 0);
    yields = 0;

    await app.refresh();

    assert.equal(yields, 2);
    assert.equal(controllersFor(app).length, 2);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps stable controller DOM connected across a stale refresh retry", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
    };
    const originalControllers = controllersFor(app);
    const originalActions = originalControllers.map(
      (controller) => controller.actions,
    );
    let invalidated = false;
    const yieldForRefresh =
      app.yieldForLargeRefreshInteraction.bind(app);
    app.yieldForLargeRefreshInteraction = async (...args) => {
      if (!invalidated) {
        invalidated = true;
        app.diffMutationGeneration += 1;
      }
      await yieldForRefresh(...args);
    };
    let connectedAtAbort = false;
    const abortRefresh = app.abortRefreshForStaleDiff.bind(app);
    app.abortRefreshForStaleDiff = (...args) => {
      const result = abortRefresh(...args);
      connectedAtAbort = originalControllers.every(
        (controller, index) =>
          !controller.destroyed &&
          controller.actions === originalActions[index] &&
          controller.actions.isConnected,
      );
      return result;
    };

    await app.refresh();
    await waitFor(() => {
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
    });

    assert.equal(connectedAtAbort, true);
    assert.deepEqual(controllersFor(app), originalControllers);
    assert.equal(
      originalActions.every((actions) => actions.isConnected),
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not retry a stale refresh while diff loading remains unsettled", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_SETTLE_MS: 20,
      LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
    };
    const originalControllers = controllersFor(app);
    const originalActions = originalControllers.map(
      (controller) => controller.actions,
    );
    const fileGrid = dom.window.document.querySelector(
      '[aria-label="Diff for: src/react-one.js"]',
    );
    const loader = appendDiffLoader(dom, fileGrid);
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(originalControllers[0].input.disabled, true);
    });

    let invalidated = false;
    const yieldForRefresh =
      app.yieldForLargeRefreshInteraction.bind(app);
    app.yieldForLargeRefreshInteraction = async (...args) => {
      if (!invalidated) {
        invalidated = true;
        app.diffMutationGeneration += 1;
      }
      await yieldForRefresh(...args);
    };

    await app.refresh();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(app.refreshQueued, false);
    assert.equal(app.refreshRunning, false);
    assert.deepEqual(controllersFor(app), originalControllers);
    assert.equal(
      originalActions.every((actions) => actions.isConnected),
      true,
    );

    loader.remove();
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 0);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      assert.equal(
        controllersFor(app).every(
          (controller) => controller.input.disabled === false,
        ),
        true,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("discards unreconciled controllers from a stale refresh retry", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    controllersFor(app).forEach((controller) =>
      app.destroyController(controller),
    );
    app.constants = {
      ...app.constants,
      LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
    };
    const createdControllers = [];
    const createController = app.createController.bind(app);
    app.createController = (...args) => {
      const controller = createController(...args);
      createdControllers.push(controller);
      return controller;
    };
    let yields = 0;
    let firstAttemptControllers = [];
    const yieldForRefresh =
      app.yieldForLargeRefreshInteraction.bind(app);
    app.yieldForLargeRefreshInteraction = async (...args) => {
      yields += 1;
      if (yields === 2) {
        firstAttemptControllers = createdControllers.slice();
        app.diffMutationGeneration += 1;
      }
      await yieldForRefresh(...args);
    };

    await app.refresh();
    await waitFor(() => {
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      assert.equal(controllersFor(app).length, 2);
      assert.equal(
        controllersFor(app).every(
          (controller) => controller.input.disabled === false,
        ),
        true,
      );
    });

    assert.equal(firstAttemptControllers.length, 2);
    assert.equal(
      firstAttemptControllers.every(
        (controller) =>
          controller.destroyed && !controller.actions.isConnected,
      ),
      true,
    );
    assert.equal(
      controllersFor(app).every(
        (controller) => !firstAttemptControllers.includes(controller),
      ),
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

for (const mutationYield of [1, 2]) {
  test(
    `blocks stale review writes during large refresh yield ${mutationYield}`,
    async () => {
      const { app, chrome, dom } = await startExtension(
        currentReactContextExpansionFixture(),
      );
      try {
        app.constants = {
          ...app.constants,
          LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
        };
        const originalController = controllersFor(app).find(
          (controller) => controller.filePath === "src/react-one.js",
        );
        assert.ok(originalController);
        const originalLine = originalController.lines[0];
        const originalControl = originalLine.control;
        const originalKey = originalLine.key;
        assert.ok(originalControl);
        let mutated = false;
        let yields = 0;
        const yieldForRefresh =
          app.yieldForLargeRefreshInteraction.bind(app);
        app.yieldForLargeRefreshInteraction = async (...args) => {
          yields += 1;
          if (!mutated && yields === mutationYield) {
            mutated = true;
            originalLine.element.querySelector("code").textContent =
              `+replacement-${mutationYield}`;
            await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
            assert.equal(originalControl.disabled, true);
            originalControl.click();
          }
          await yieldForRefresh(...args);
        };

        await app.refresh();
        await waitFor(() => {
          assert.equal(app.refreshQueued, false);
          assert.equal(app.refreshRunning, false);
          const currentController = controllersFor(app).find(
            (controller) => controller.filePath === "src/react-one.js",
          );
          assert.ok(currentController);
          assert.notEqual(currentController, originalController);
          assert.equal(
            currentController.lines[0].text,
            `+replacement-${mutationYield}`,
          );
          assert.equal(currentController.lines[0].control.disabled, false);
          assert.equal(currentController.lines[0].marked, false);
        });
        assert.equal(originalController.destroyed, true);
        assert.equal(originalKey in chrome.snapshot(), false);
      } finally {
        app.stop();
        dom.window.close();
      }
    },
  );
}

test("restores only controls enabled before diff mutation suspension", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const first = controllersFor(app).find(
      (controller) => controller.filePath === "src/react-one.js",
    );
    const second = controllersFor(app).find(
      (controller) => controller.filePath === "src/react-two.js",
    );
    assert.ok(first);
    assert.ok(second);
    first.lines[0].control.disabled = true;

    app.suspendReviewControllersForDiffMutation(
      new Set(["src/react-one.js"]),
    );

    assert.equal(first.input.disabled, true);
    assert.equal(first.collapseButton.disabled, true);
    assert.equal(first.lines[0].control.disabled, true);
    assert.equal(second.input.disabled, false);
    assert.equal(second.lines[0].control.disabled, false);

    app.restoreDiffMutationSuspendedReviewControls();

    assert.equal(first.input.disabled, false);
    assert.equal(first.collapseButton.disabled, false);
    assert.equal(first.lines[0].control.disabled, true);
    assert.equal(second.input.disabled, false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("suspends file-header mutations only when path identity changes", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.observer.disconnect();
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    assert.ok(controller);
    const fileHeader = app.fileHeaderElement(controller.fileElement);
    const fileGrid = controller.fileElement.querySelector(
      '[role="grid"][aria-label^="Diff for: "]',
    );
    const auxiliaryButton = dom.window.document.createElement("button");
    auxiliaryButton.textContent = "Collapse file";
    fileHeader.append(auxiliaryButton);
    app.handleMutations([
      {
        addedNodes: [auxiliaryButton],
        removedNodes: [],
        target: fileHeader,
      },
    ]);

    assert.equal(app.reviewControllerIsSuspended(controller), false);
    assert.equal(controller.input.disabled, false);

    fileGrid.setAttribute("aria-label", "Diff for: src/renamed-one.js");
    const identityMutation = dom.window.document.createElement("button");
    identityMutation.textContent = "Updated header";
    fileHeader.append(identityMutation);
    app.handleMutations([
      {
        addedNodes: [identityMutation],
        removedNodes: [],
        target: fileHeader,
      },
    ]);

    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(controller.input.disabled, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("rejects review events from controls reenabled while suspended", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    assert.ok(controller);
    const line = controller.lines[0];
    app.suspendReviewControllersForDiffMutation(
      new Set(["src/react-one.js"]),
    );

    line.control.disabled = false;
    line.control.click();
    controller.input.disabled = false;
    controller.input.checked = true;
    controller.input.dispatchEvent(new dom.window.Event("change"));
    controller.collapseButton.disabled = false;
    controller.collapseButton.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));

    assert.equal(line.marked, false);
    assert.equal(controller.marked, false);
    assert.equal(controller.collapsed, false);
    assert.equal(controller.input.checked, false);
    assert.equal(controller.input.disabled, true);
    assert.equal(controller.collapseButton.disabled, true);
    assert.equal(line.key in chrome.snapshot(), false);
    assert.equal(controller.key in chrome.snapshot(), false);
    assert.equal(controller.collapsedKey in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps a suspended line disabled when an older write finishes", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.autoCollapseViewed = false;
    app.constants = {
      ...app.constants,
      REFRESH_DELAY_MS: 500,
    };
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    assert.ok(controller);
    const line = controller.lines[0];
    const control = line.control;
    const oldKey = line.key;
    assert.ok(control);
    await app.setLineViewed(line, true);
    assert.ok(chrome.snapshot()[oldKey]);

    const delayedClear = delayReviewStorageRemove(app, 1);
    const pendingClear = app.setLineViewed(line, false);
    await delayedClear.started;
    line.element.querySelector("code").textContent = "+replacement-pending";
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    assert.equal(app.diffMutationSuspendedControllers.has(controller), true);
    assert.equal(app.reviewControllerIsCurrent(controller), true);
    assert.equal(control.disabled, true);

    delayedClear.release();
    await pendingClear;

    assert.equal(app.diffMutationSuspendedControllers.has(controller), true);
    assert.equal(app.reviewControllerIsCurrent(controller), true);
    assert.equal(control.disabled, true);
    control.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    assert.equal(oldKey in chrome.snapshot(), false);

    await waitFor(() => {
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      const replacement = controllersFor(app).find(
        (candidate) => candidate.filePath === "src/react-one.js",
      );
      assert.ok(replacement);
      assert.notEqual(replacement, controller);
      assert.equal(replacement.lines[0].text, "+replacement-pending");
      assert.equal(replacement.lines[0].marked, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("enables a line after its pending write and refresh both finish", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.autoCollapseViewed = false;
    app.constants = {
      ...app.constants,
      LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
    };
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    assert.ok(controller);
    const line = controller.lines[0];
    const delayedWrite = delayReviewStorageSet(app, 1);
    const pendingWrite = app.setLineViewed(line, true);
    await delayedWrite.started;
    assert.equal(line.control.disabled, true);

    const refreshYielded = createDeferred();
    const resumeRefresh = createDeferred();
    let paused = false;
    const yieldForRefresh = app.yieldForLargeRefreshInteraction.bind(app);
    app.yieldForLargeRefreshInteraction = async (...args) => {
      if (!paused) {
        paused = true;
        refreshYielded.resolve();
        await resumeRefresh.promise;
      }
      await yieldForRefresh(...args);
    };
    const pendingRefresh = app.refresh();
    await refreshYielded.promise;
    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(line.control.disabled, true);

    delayedWrite.release();
    await pendingWrite;
    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(line.control.disabled, true);
    assert.ok(chrome.snapshot()[line.key]);

    resumeRefresh.resolve();
    await pendingRefresh;

    assert.equal(app.reviewControllerIsCurrent(controller), true);
    assert.equal(app.reviewControllerIsSuspended(controller), false);
    assert.equal(line.control.disabled, false);
    assert.equal(line.marked, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("tracks a fully disabled zero-line hunk while its clear finishes", async () => {
  const { app, chrome, dom } = await startExtension(`<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/zero-line.js">
        <div class="file-header"><span class="file-info">src/zero-line.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1,0 +1,0 @@</td></tr>
        </tbody></table>
      </div>
    </body></html>`);
  try {
    app.autoCollapseViewed = false;
    app.constants = {
      ...app.constants,
      REFRESH_DELAY_MS: 500,
    };
    const controller = controllerAt(app);
    assert.equal(controller.lines.length, 0);
    const oldKey = controller.key;
    await app.setHunkViewed(controller, true);
    assert.ok(chrome.snapshot()[oldKey]);

    const delayedClear = delayReviewStorageRemove(app, 1);
    const pendingClear = app.setHunkViewed(controller, false);
    await delayedClear.started;
    controller.hunkCell.textContent = "@@ -2,0 +2,0 @@ changed";
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    assert.equal(app.reviewControllerIsCurrent(controller), true);
    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(controller.input.disabled, true);

    delayedClear.release();
    await pendingClear;

    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(controller.input.disabled, true);
    controller.input.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    assert.equal(oldKey in chrome.snapshot(), false);

    await waitFor(() => {
      const replacement = controllerAt(app);
      assert.notEqual(replacement, controller);
      assert.equal(replacement.marked, false);
      assert.equal(replacement.input.disabled, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("blocks stale review writes during chunked discovery", async () => {
  const { app, chrome, dom } = await startExtension(manyFileHunkFixture(17));
  try {
    const originalController = controllersFor(app).find(
      (controller) => controller.filePath === "src/chunk-0.js",
    );
    assert.ok(originalController);
    const originalLine = originalController.lines[0];
    const originalControl = originalLine.control;
    const originalKey = originalLine.key;
    assert.ok(originalControl);
    let mutated = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      if (!mutated) {
        mutated = true;
        originalLine.element.querySelector("code").textContent =
          "+replacement-during-discovery";
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
        assert.equal(originalControl.disabled, true);
        originalControl.click();
      }
      await yieldForDiscovery(...args);
    };

    await app.refresh();
    await waitFor(() => {
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      const currentController = controllersFor(app).find(
        (controller) => controller.filePath === "src/chunk-0.js",
      );
      assert.ok(currentController);
      assert.notEqual(currentController, originalController);
      assert.equal(
        currentController.lines[0].text,
        "+replacement-during-discovery",
      );
      assert.equal(currentController.lines[0].control.disabled, false);
    });
    assert.equal(originalController.destroyed, true);
    assert.equal(originalKey in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("yields while discovering many files before discovery completes", async () => {
  const { app, dom } = await startExtension(manyFileHunkFixture(17));
  try {
    let scheduledTaskRan = false;
    let preparedAfterScheduledTask = false;
    let schedulerYields = 0;
    let yields = 0;
    Object.defineProperty(dom.window, "scheduler", {
      configurable: true,
      value: {
        async yield() {
          schedulerYields += 1;
        },
      },
    });
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      yields += 1;
      await yieldForDiscovery(...args);
    };
    const prepare = app.prepareDiscoveredHunkFileInputs.bind(app);
    app.prepareDiscoveredHunkFileInputs = (...args) => {
      preparedAfterScheduledTask ||= scheduledTaskRan;
      return prepare(...args);
    };
    dom.window.setTimeout(() => {
      scheduledTaskRan = true;
    }, 0);

    await app.refresh();

    assert.equal(yields, 8);
    assert.equal(schedulerYields, 7);
    assert.equal(preparedAfterScheduledTask, true);
    assert.equal(controllersFor(app).length, 17);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("aborts chunked discovery when the diff DOM changes after a yield", async () => {
  const { app, dom } = await startExtension(manyFileHunkFixture(9));
  try {
    const generation = app.diffMutationGeneration;
    let removed = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      if (!removed) {
        removed = true;
        dom.window.document.querySelector("#diff-chunk-8").remove();
      }
      await yieldForDiscovery(...args);
    };

    const discovered = await app.discoverHunks();

    assert.equal(discovered, null);
    assert.equal(app.diffMutationGeneration > generation, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("aborts chunked discovery when the review scope changes after a yield", async () => {
  const { app, dom } = await startExtension(manyFileHunkFixture(9));
  try {
    let navigated = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      if (!navigated) {
        navigated = true;
        dom.window.history.replaceState(
          {},
          "",
          "https://github.com/octo/repo/pull/124/files",
        );
      }
      await yieldForDiscovery(...args);
    };

    const discovered = await app.discoverHunks();

    assert.equal(discovered, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves known changed-line identity across auxiliary descendants", async () => {
  const { app, dom } = await startExtension(
    currentReactSplitContextExpansionFixture(),
  );
  try {
    const [controller] = controllersFor(app);
    const line = controller.lines.find(
      (candidate) => candidate.side === "right",
    );
    assert.equal(app.knownLineControllerForMutationTarget(line.element), line);
    const originalRefresh = app.refresh.bind(app);
    let refreshes = 0;
    app.refresh = async (...args) => {
      refreshes += 1;
      return originalRefresh(...args);
    };
    const originalInvalidate =
      app.invalidateVisibleStickyHunkOrigins.bind(app);
    let stickyInvalidations = 0;
    app.invalidateVisibleStickyHunkOrigins = () => {
      stickyInvalidations += 1;
      return originalInvalidate();
    };

    const auxiliaryContent = dom.window.document.createElement("div");
    auxiliaryContent.dataset.hostAuxiliary = "true";
    auxiliaryContent.innerHTML = `
      <div role="toolbar"></div>
      <pre><code>auxiliary sample</code></pre>`;
    line.element.append(auxiliaryContent);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const auxiliaryAction = dom.window.document.createElement("button");
    auxiliaryAction.textContent = "Action";
    auxiliaryContent.querySelector('[role="toolbar"]').append(auxiliaryAction);
    await new Promise((resolve) => setTimeout(resolve, 180));

    auxiliaryContent.remove();
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(refreshes, 0);
    assert.equal(stickyInvalidations >= 3, true);
    assert.equal(app.controllersByRow.get(controller.hunkRow), controller);
    assert.equal(line.text, "+newValue");
    assert.equal(line.control.isConnected, true);
    assert.equal(app.refreshQueued, false);
    assert.equal(app.refreshRunning, false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("refreshes when a known changed-line identity changes", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const originalController = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const originalRefresh = app.refresh.bind(app);
    let refreshes = 0;
    app.refresh = async (...args) => {
      refreshes += 1;
      return originalRefresh(...args);
    };

    originalController.lines[0].element.querySelector("code").textContent =
      "+changed";

    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      const refreshedController = controllersFor(app).find(
        (candidate) => candidate.filePath === "src/react-one.js",
      );
      assert.notEqual(refreshedController, originalController);
      assert.equal(refreshedController.lines[0].text, "+changed");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves untracked context identity across auxiliary descendants", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const originalControllers = controllersFor(app);
    const contextRow = Array.from(
      dom.window.document.querySelectorAll(
        'tr.diff-line-row[data-line-type="context"]',
      ),
    ).find((row) => row.textContent.includes("before first"));
    const contextCell = contextRow.querySelector(".diff-text-cell");
    assert.equal(app.knownLineControllerForMutationTarget(contextCell), null);
    const originalRefresh = app.refresh.bind(app);
    let refreshes = 0;
    app.refresh = async (...args) => {
      refreshes += 1;
      return originalRefresh(...args);
    };
    const originalInvalidate =
      app.invalidateVisibleStickyHunkOrigins.bind(app);
    let stickyInvalidations = 0;
    app.invalidateVisibleStickyHunkOrigins = () => {
      stickyInvalidations += 1;
      return originalInvalidate();
    };

    const primaryAuxiliary = dom.window.document.createElement("div");
    primaryAuxiliary.dataset.hostAuxiliary = "primary";
    primaryAuxiliary.append(dom.window.document.createElement("button"));
    const secondaryAuxiliary = dom.window.document.createElement("div");
    secondaryAuxiliary.dataset.hostAuxiliary = "secondary";
    secondaryAuxiliary.append(dom.window.document.createElement("button"));
    contextCell.append(primaryAuxiliary, secondaryAuxiliary);
    await new Promise((resolve) => setTimeout(resolve, 180));

    primaryAuxiliary.remove();
    secondaryAuxiliary.remove();
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(refreshes, 0);
    assert.equal(stickyInvalidations >= 2, true);
    assert.deepEqual(controllersFor(app), originalControllers);
    assert.equal(contextCell.querySelector("code").textContent, "before first");
    assert.equal(app.refreshQueued, false);
    assert.equal(app.refreshRunning, false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("skips non-structural file UI only while tracked identity matches", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const originalControllers = controllersFor(app);
    const fileGrid = dom.window.document.querySelector(
      '[aria-label="Diff for: src/react-one.js"]',
    );
    assert.ok(fileGrid);
    const fileRegion = fileGrid.closest('[role="region"]');
    assert.ok(fileRegion);
    const fileBody = fileGrid.parentElement;
    assert.ok(fileBody);
    assert.notEqual(fileBody, fileRegion);
    const fileHeader = app.fileHeaderElement(fileRegion);
    assert.ok(fileHeader);
    const filePathLink = app.filePathLink(fileRegion);
    assert.ok(filePathLink);
    assert.equal(app.knownFilePath(fileRegion), "src/react-one.js");
    assert.equal(
      app.currentFilePathEvidence(fileRegion),
      "src/react-one.js",
    );
    assert.equal(
      app.currentFilePathEvidence(fileGrid),
      "src/react-one.js",
    );
    const originalRefresh = app.refresh.bind(app);
    let refreshes = 0;
    app.refresh = async (...args) => {
      refreshes += 1;
      return originalRefresh(...args);
    };
    const originalInvalidate =
      app.invalidateVisibleStickyHunkOrigins.bind(app);
    let stickyInvalidations = 0;
    app.invalidateVisibleStickyHunkOrigins = () => {
      stickyInvalidations += 1;
      return originalInvalidate();
    };
    const resolveFilePath = app.resolveFilePath.bind(app);
    app.resolveFilePath = () => {
      throw new Error(
        "non-structural mutation checks must not rescan file identity",
      );
    };

    const auxiliaryUi = dom.window.document.createElement("div");
    auxiliaryUi.innerHTML = `
      <h4>Add comment on file</h4>
      <textarea aria-label="Markdown value"></textarea>`;
    fileBody.prepend(auxiliaryUi);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const previewHost = dom.window.document.createElement("div");
    const loadingPreview = dom.window.document.createElement("section");
    loadingPreview.innerHTML = `
      <span data-component="loadingSpinner">
        <span data-component="Spinner" role="progressbar">Loading</span>
      </span>`;
    previewHost.append(loadingPreview);
    auxiliaryUi.append(previewHost);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const preview = dom.window.document.createElement("div");
    preview.innerHTML = `
      <pre><code>const draft = true;</code></pre>
      <h3><a href="#diff-user-content">Linked preview</a></h3>
      <table><tbody><tr><td>Table preview</td></tr></tbody></table>
      <div role="row"><span role="cell">Grid preview</span></div>`;
    loadingPreview.replaceWith(preview);
    await new Promise((resolve) => setTimeout(resolve, 180));

    preview
      .querySelector("tbody")
      .append(dom.window.document.createElement("tr"));
    preview
      .querySelector("h3")
      .append(dom.window.document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(app.filePathLink(fileRegion), filePathLink);

    auxiliaryUi.remove();
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(refreshes, 0);
    assert.equal(stickyInvalidations >= 3, true);
    assert.deepEqual(controllersFor(app), originalControllers);
    assert.equal(
      originalControllers.every(
        (controller) =>
          controller.hunkRow.isConnected &&
          controller.lines.every(
            (line) => !line.control || line.control.isConnected,
          ),
      ),
      true,
    );
    assert.equal(app.refreshQueued, false);
    assert.equal(app.refreshRunning, false);

    app.resolveFilePath = resolveFilePath;
    const diffBody = fileGrid.querySelector("tbody");
    assert.ok(diffBody);
    const diffLoader = appendDiffLoader(dom, fileGrid);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);

    appendAdditionHunk(dom, fileGrid, {
      anchor: "diff-one-R20",
      lineNumber: 20,
      text: "+partial load",
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      controllersFor(app).some((controller) =>
        controller.lines.some((line) => line.text === "+partial load"),
      ),
      false,
    );
    assert.equal(refreshes, 0);
    assert.equal(diffLoader.isConnected, true);

    diffLoader.remove();
    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(controllersFor(app).length, originalControllers.length + 1);
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);

    refreshes = 0;
    const diffRow = dom.window.document.createElement("tr");
    diffRow.className = "diff-line-row";
    diffRow.setAttribute("data-line-type", "context");
    diffRow.innerHTML =
      '<td class="diff-text-cell"><code>new context</code></td>';
    diffBody.append(diffRow);
    await waitFor(() => assert.equal(refreshes, 1));

    refreshes = 0;
    fileGrid.setAttribute("aria-label", "Diff for: src/renamed.js");
    fileBody.prepend(dom.window.document.createElement("aside"));
    await waitFor(() => assert.equal(refreshes, 1));
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("defers an expected Load Diff root transition before a loader appears", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 2_000,
      DIFF_LOAD_REFRESH_SETTLE_MS: 20,
    };
    const replacementFileHtml = (options) => {
      const fixture = new JSDOM(loadDiffFixture(options));
      try {
        return fixture.window.document.querySelector(".js-file").outerHTML;
      } finally {
        fixture.window.close();
      }
    };
    const initialFile = dom.window.document.querySelector(".js-file");
    const fileParent = initialFile.parentElement;
    assert.ok(fileParent);
    const loadButton = initialFile.querySelector("button");
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };
    loadButton.addEventListener("click", () => {
      initialFile.remove();
    });

    loadButton.click();

    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);

    const stagingTemplate = dom.window.document.createElement("template");
    stagingTemplate.innerHTML = replacementFileHtml();
    const stagingFile = stagingTemplate.content.firstElementChild;
    fileParent.append(stagingFile);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);

    const loadedTemplate = dom.window.document.createElement("template");
    loadedTemplate.innerHTML = replacementFileHtml({ loaded: true });
    stagingFile.replaceWith(loadedTemplate.content.firstElementChild);

    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.controllersByRow.size, 1);
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps an earlier explicit Load Diff waiting during another file load", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.observer.disconnect();
    const fileRegions = Array.from(
      dom.window.document.querySelectorAll('[role="region"]'),
    );
    assert.equal(fileRegions.length, 2);
    const firstRegion = fileRegions[0];
    const secondRegion = fileRegions[1];
    const secondController = controllersFor(app).find(
      (controller) => controller.filePath === "src/react-two.js",
    );
    assert.ok(secondController);
    const controlContainer = dom.window.document.createElement("div");
    controlContainer.innerHTML = "<button>Load Diff</button>";
    firstRegion.append(controlContainer);
    const restore = app.beginFileRevealPrepaintRestore(
      firstRegion,
      "src/react-one.js",
      controlContainer.querySelector("button"),
      {
        timeoutMs: 500,
        waitForResolvedContent: true,
      },
    );
    assert.ok(restore);
    app.rememberDeferredDiffLoadRefresh("src/react-one.js", firstRegion);
    app.ensureDeferredDiffLoadRefreshTimeout();
    firstRegion.remove();
    assert.equal(
      app.deferredDiffLoadRecordAwaitsReplacement(firstRegion),
      true,
    );

    const secondBody = secondRegion.querySelector("tbody");
    const loader = appendDiffLoader(dom, secondRegion, "Loading another diff");
    app.handleMutations([
      {
        addedNodes: [loader],
        removedNodes: [],
        target: secondBody,
      },
    ]);

    assert.equal(app.deferredDiffLoadRefreshes.size, 2);
    assert.equal(app.deferredDiffLoadStatus().active, true);
    assert.equal(app.deferredDiffLoadRefreshSettleTimer, null);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);
    assert.equal(secondController.input.disabled, true);
    assert.equal(secondController.lines[0].control.disabled, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("rechecks active loading when quiet settlement fires", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  try {
    app.observer.disconnect();
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 500,
      DIFF_LOAD_REFRESH_SETTLE_MS: 20,
    };
    let refreshes = 0;
    app.scheduleRefresh = () => {
      refreshes += 1;
    };
    const fileElement = dom.window.document.querySelector(".js-file");
    app.rememberDeferredDiffLoadRefresh("src/large-diff.js", fileElement);
    app.scheduleDeferredDiffLoadRefreshSettlement();
    app.beginFileRevealPrepaintRestore(
      fileElement,
      "src/large-diff.js",
      fileElement.querySelector("button"),
      { timeoutMs: 500, waitForResolvedContent: true },
    );

    await new Promise((resolve) => dom.window.setTimeout(resolve, 60));

    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.equal(app.deferredDiffLoadRefreshSettleTimer, null);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("starts a deferred batch from a loader outside the mutation files", async () => {
  const fixture = new JSDOM(currentReactContextExpansionFixture());
  let html;
  try {
    const secondGrid = fixture.window.document.querySelector(
      '[aria-label="Diff for: src/react-two.js"]',
    );
    const loadingRegion = secondGrid.closest('[role="region"]');
    loadingRegion.id = "diff-loading-two";
    loadingRegion.setAttribute("aria-label", "Loading src/react-two.js");
    loadingRegion.innerHTML =
      '<div data-component="loadingSpinner" role="progressbar">' +
      "Loading diff two</div>";
    html = fixture.serialize();
  } finally {
    fixture.window.close();
  }

  const { app, dom } = await startExtension(html);
  try {
    let originalController;
    const loadingRegion = dom.window.document.querySelector(
      '[aria-label="Loading src/react-two.js"]',
    );
    await waitFor(() => {
      originalController = controllersFor(app).find(
        (controller) => controller.filePath === "src/react-one.js",
      );
      assert.ok(originalController);
    });
    assert.ok(loadingRegion);
    assert.equal(loadingRegion.querySelector('[role="grid"]'), null);
    assert.equal(
      app.knownFilePath(loadingRegion),
      "src/react-two.js",
    );
    assert.equal(
      app.currentFilePathEvidence(loadingRegion),
      "src/react-two.js",
    );
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };

    const replacementRow = dom.window.document.createElement("tr");
    replacementRow.className = "diff-line-row";
    replacementRow.setAttribute("data-line-type", "addition");
    replacementRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" ' +
      'data-line-anchor="diff-one-R10"><code class="addition" ' +
      'data-diff-side="right">+one</code></td>';
    originalController.lines[0].row.replaceWith(replacementRow);

    await waitFor(() => {
      assert.equal(refreshes, 0);
      assert.equal(originalController.destroyed, true);
      assert.equal(
        controllersFor(app).some(
          (controller) => controller.filePath === "src/react-one.js",
        ),
        false,
      );
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 2);
    assert.equal(
      app.knownFilePath(loadingRegion),
      "src/react-two.js",
    );

    let replacementController;
    await waitFor(() => {
      replacementController = controllersFor(app).find(
        (controller) => controller.filePath === "src/react-one.js",
      );
      assert.ok(replacementController);
      assert.equal(replacementController.lines[0].row, replacementRow);
      assert.equal(replacementController.actions.isConnected, true);
      assert.equal(replacementController.input.disabled, false);
      assert.equal(
        app.reviewControllerIsSuspended(replacementController),
        false,
      );
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(
        replacementController.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-row",
        ),
        true,
      );
      assert.equal(refreshes, 0);
    });

    loadingRegion
      .querySelector('[data-component="loadingSpinner"]')
      .remove();
    loadingRegion.setAttribute("aria-label", "Diff file src/react-two.js");
    await waitFor(() => {
      assert.equal(refreshes, 1);
      const finalController = controllersFor(app).find(
        (controller) => controller.filePath === "src/react-one.js",
      );
      assert.equal(finalController, replacementController);
      assert.equal(finalController.lines[0].control?.isConnected, true);
      assert.equal(
        finalController.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-row",
        ),
        true,
      );
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not restart an initial batch while its loader stays active", async () => {
  const fixture = new JSDOM(currentReactContextExpansionFixture());
  let html;
  try {
    const secondGrid = fixture.window.document.querySelector(
      '[aria-label="Diff for: src/react-two.js"]',
    );
    const loader = fixture.window.document.createElement("tr");
    loader.setAttribute("data-component", "loadingSpinner");
    loader.innerHTML = '<td role="progressbar">Loading diff</td>';
    secondGrid.querySelector("tbody").append(loader);
    html = fixture.serialize();
  } finally {
    fixture.window.close();
  }

  const { app, dom } = await startExtension(
    html,
    {},
    { waitForScope: false },
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 1_000,
    };
    const hydrateCounts = new Map();
    const hydrateDiffLoadFile = app.hydrateDiffLoadFile.bind(app);
    app.hydrateDiffLoadFile = async (fileElement, filePath, options) => {
      hydrateCounts.set(filePath, (hydrateCounts.get(filePath) ?? 0) + 1);
      return hydrateDiffLoadFile(fileElement, filePath, options);
    };
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };

    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.deferredDiffLoadRefreshes.size > 0, true);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(refreshes, 1);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);
    assert.equal(app.deferredDiffLoadRefreshSettleTimer, null);
    const stableHydrations = hydrateCounts.get("src/react-one.js");
    assert.equal(stableHydrations, 1);

    app.scheduleRefresh({ immediate: true });
    await waitFor(() => {
      assert.equal(refreshes, 2);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hydrateCounts.get("src/react-one.js"), stableHydrations);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("defers new review controls through quiet diff settlement", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 1_500,
      DIFF_LOAD_REFRESH_SETTLE_MS: 500,
    };
    const fileElement = dom.window.document.querySelector(".js-file");
    const diffBody = fileElement.querySelector("tbody");
    const appendedHunkRows = [];
    const appendHunk = (lineNumber, text) => {
      const hunkRow = dom.window.document.createElement("tr");
      hunkRow.innerHTML =
        `<td class="blob-code-hunk">@@ -${lineNumber} +${lineNumber} @@</td>`;
      const lineRow = dom.window.document.createElement("tr");
      lineRow.innerHTML =
        `<td class="blob-num">${lineNumber}</td>` +
        `<td class="blob-code-addition">${text}</td>`;
      diffBody.append(hunkRow, lineRow);
      appendedHunkRows.push(hunkRow);
    };

    const loader = appendDiffLoader(dom, fileElement);
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(
        controllersFor(app).every((controller) =>
          app.reviewControllerIsSuspended(controller),
        ),
        true,
      );
    });

    loader.remove();
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(app.deferredDiffLoadStatus().active, false);
      assert.notEqual(app.deferredDiffLoadRefreshSettleTimer, null);
    });

    appendHunk(20, "+late duplicate");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.equal(controllersFor(app).length, 2);
    assert.equal(
      appendedHunkRows[0].querySelector(".hunkmark-hunk-actions"),
      null,
    );
    assert.equal(
      appendedHunkRows[0].classList.contains("hunkmark-sticky-hunk-row"),
      false,
    );

    appendHunk(30, "+late duplicate");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.equal(controllersFor(app).length, 2);
    assert.equal(
      appendedHunkRows.every(
        (row) =>
          row.querySelector(".hunkmark-hunk-actions") === null &&
          !row.classList.contains("hunkmark-sticky-hunk-row"),
      ),
      true,
    );

    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 0);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      const duplicateLines = controllersFor(app)
        .flatMap((controller) => controller.lines)
        .filter((line) => line.text === "+late duplicate");
      assert.equal(duplicateLines.length, 2);
      assert.equal(
        duplicateLines.every(
          (line) =>
            !line.marked &&
            line.control?.disabled === false,
        ),
        true,
      );
      assert.equal(controllersFor(app).length, 4);
      assert.equal(
        appendedHunkRows.every(
          (row) =>
            row.querySelector(".hunkmark-hunk-actions") !== null &&
            row.classList.contains("hunkmark-sticky-hunk-row"),
        ),
        true,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("coalesces concurrent file loads until every diff settles", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 100,
      DIFF_LOAD_REFRESH_SETTLE_MS: 100,
    };
    const fileGrids = Array.from(
      dom.window.document.querySelectorAll(
        '[role="grid"][aria-label^="Diff for: "]',
      ),
    );
    assert.equal(fileGrids.length, 2);
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };
    const loaders = fileGrids.map((fileGrid, index) =>
      appendDiffLoader(dom, fileGrid, `Loading diff ${index + 1}`),
    );

    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 2);

    fileGrids.forEach((fileGrid, index) =>
      appendAdditionHunk(dom, fileGrid, {
        anchor: `diff-load-R${20 + index}`,
        lineNumber: 20 + index,
        text: `+loaded ${index + 1}`,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    const loadedControllersBeforeSettle = controllersFor(app).filter(
      (controller) =>
        controller.lines.some((line) => line.text.startsWith("+loaded ")),
    );
    assert.equal(loadedControllersBeforeSettle.length, 2);
    assert.equal(
      loadedControllersBeforeSettle.every(
        (controller) =>
          controller.actions.isConnected &&
          controller.input.disabled &&
          controller.hunkRow.classList.contains(
            "hunkmark-sticky-hunk-row",
          ),
      ),
      true,
    );
    assert.equal(refreshes, 0);

    loaders[0].remove();
    await waitFor(() => {
      const loadedControllers = controllersFor(app).filter((controller) =>
        controller.lines.some((line) => line.text === "+loaded 1"),
      );
      assert.equal(loadedControllers.length, 1);
      assert.equal(loadedControllers[0].actions.isConnected, true);
      assert.equal(loadedControllers[0].input.disabled, false);
      assert.equal(
        app.reviewControllerIsSuspended(loadedControllers[0]),
        false,
      );
      assert.equal(
        loadedControllers[0].hunkRow.classList.contains(
          "hunkmark-sticky-hunk-row",
        ),
        true,
      );
      assert.equal(refreshes, 0);
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    });
    const individuallySettledController = controllersFor(app).find(
      (controller) =>
        controller.lines.some((line) => line.text === "+loaded 1"),
    );
    changeCheckbox(dom, individuallySettledController.input, true);
    await waitFor(() => {
      assert.equal(individuallySettledController.marked, true);
      assert.equal(individuallySettledController.input.disabled, false);
      assert.equal(
        individuallySettledController.lines.every(
          (line) => Boolean(chrome.snapshot()[line.key]?.viewedAt),
        ),
        true,
      );
    });

    loaders[1].remove();
    await waitFor(() => {
      assert.equal(refreshes, 1);
      const loadedControllers = controllersFor(app).filter((controller) =>
        controller.lines.some((line) => line.text.startsWith("+loaded ")),
      );
      assert.equal(loadedControllers.length, 2);
      assert.equal(
        loadedControllers.every((controller) =>
          controller.hunkRow.classList.contains("hunkmark-sticky-hunk-row"),
        ),
        true,
      );
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
    assert.equal(
      controllersFor(app).every(
        (controller) =>
          !controller.input.disabled &&
          controller.lines.every(
            (line) => !line.control || !line.control.disabled,
          ),
      ),
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("rekeys an existing line before its file settles independently", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.autoCollapseViewed = false;
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 100,
      DIFF_LOAD_REFRESH_SETTLE_MS: 100,
    };
    const fileGrids = Array.from(
      dom.window.document.querySelectorAll(
        '[role="grid"][aria-label^="Diff for: "]',
      ),
    );
    const loaders = fileGrids.map((fileGrid, index) =>
      appendDiffLoader(dom, fileGrid, `Loading ${index}`),
    );
    await waitFor(() =>
      assert.equal(app.deferredDiffLoadRefreshes.size, 2),
    );
    const filePath = "src/react-one.js";
    const originalController = controllerForFile(app, filePath);
    const oldLineKey = originalController.lines[0].key;
    appendAdditionHunk(dom, fileGrids[0], {
      anchor: "diff-duplicate-R30",
      before: loaders[0],
      lineNumber: 30,
      text: "+one",
    });

    await waitFor(() => {
      const fileControllers = controllersForFile(app, filePath);
      assert.equal(originalController.destroyed, true);
      assert.equal(fileControllers.length, 2);
      assert.equal(
        fileControllers.every((controller) =>
          app.reviewControllerIsSuspended(controller),
        ),
        true,
      );
    });

    loaders[0].remove();
    await waitFor(() => {
      const fileControllers = controllersForFile(app, filePath);
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(fileControllers.length, 2);
      assert.equal(
        fileControllers.every(
          (controller) =>
            !app.reviewControllerIsSuspended(controller) &&
            !controller.input.disabled,
        ),
        true,
      );
    });
    const currentControllers = controllersForFile(app, filePath);
    const currentLineKeys = currentControllers.flatMap((controller) =>
      controller.lines.map((line) => line.key),
    );
    const discovered = await app.discoverHunks(
      fileGrids[0].closest('[role="region"]'),
    );
    const discoveredLineKeys = discovered.flatMap((hunk) =>
      hunk.lines.map((line) => line.key),
    );
    assert.equal(currentLineKeys.includes(oldLineKey), false);
    assert.deepEqual(currentLineKeys, Array.from(discoveredLineKeys));

    await app.setLineViewed(currentControllers[0].lines[0], true);
    assert.ok(chrome.snapshot()[currentControllers[0].lines[0].key]);
    assert.equal(oldLineKey in chrome.snapshot(), false);
    loaders[1].remove();
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps appended context collapsed during file hydration", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 100,
    };
    const controller = controllersFor(app)[0];
    assert.ok(controller);
    await app.setCollapsed(controller, true);
    assert.equal(controller.collapsed, true);
    const fileGrid = dom.window.document.querySelector(
      '[aria-label="Diff for: src/react-overlap.js"]',
    );
    const diffBody = fileGrid.querySelector("tbody");
    const loader = appendDiffLoader(dom, fileGrid);
    await waitFor(() => {
      assert.equal(app.reviewControllerIsSuspended(controller), true);
      assert.equal(controller.input.disabled, true);
    });

    const afterFirst = Array.from(
      diffBody.querySelectorAll(
        'tr.diff-line-row[data-line-type="context"]',
      ),
    ).find((row) => row.textContent.includes("after first"));
    const fartherContext = dom.window.document.createElement("tr");
    fartherContext.className = "diff-line-row";
    fartherContext.setAttribute("data-line-type", "context");
    fartherContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
      '<code class="diff-text" data-diff-side="right">' +
      "farther after first</code></td>";
    afterFirst.after(fartherContext);

    await waitFor(() => {
      assert.equal(app.reviewControllerIsCurrent(controller), true);
      assert.equal(controller.collapsed, true);
      assert.equal(app.reviewControllerIsSuspended(controller), true);
      assert.equal(fartherContext.classList.contains("hunkmark-collapsed"), true);
    });
    loader.remove();
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("prioritizes viewport hydration ahead of offscreen aggregation", async () => {
  const contract = await hydrationQueueContract(
    ["offscreen.js", "visible.js"],
    { DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_DELAY_MS: 100 },
  );
  try {
    contract.setRect("visible.js", { bottom: 400, top: 100 });
    contract.schedule("offscreen.js");
    contract.schedule("visible.js");
    await waitFor(() => assert.deepEqual(contract.started, ["visible.js"]));

    contract.setRect("offscreen.js", { bottom: 400, top: 100 });
    contract.app.reprioritizeViewportHydrations();
    await waitFor(() =>
      assert.deepEqual(contract.started, ["visible.js", "offscreen.js"]),
    );
    contract.release("visible.js");
    contract.release("offscreen.js");
  } finally {
    contract.stop();
  }
});

test("does not postpone one file hydration for another file mutation", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 5_000,
    };
    const fileGrids = Array.from(
      dom.window.document.querySelectorAll(
        '[role="grid"][aria-label^="Diff for: "]',
      ),
    );
    const loaders = fileGrids.map((fileGrid, index) =>
      appendDiffLoader(dom, fileGrid, `Loading ${index}`),
    );
    await waitFor(() => assert.equal(app.diffLoadHydrations.size, 2));
    const firstPath = "src/react-one.js";
    const secondPath = "src/react-two.js";
    const firstState = app.diffLoadHydrations.get(firstPath);
    let secondState = app.diffLoadHydrations.get(secondPath);
    assert.ok(firstState);
    assert.ok(secondState);

    for (let index = 0; index < 3; index += 1) {
      const marker = dom.window.document.createElement("span");
      marker.textContent = `tick ${index}`;
      loaders[1].querySelector("td").append(marker);
      await waitFor(() => {
        assert.notEqual(app.diffLoadHydrations.get(secondPath), secondState);
      });
      assert.equal(app.diffLoadHydrations.get(firstPath), firstState);
      secondState = app.diffLoadHydrations.get(secondPath);
    }
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("scopes hydration invalidation to the mutated file", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.scheduleRefresh = () => {};
    const controllers = controllersFor(app);
    const first = controllers.find(
      (controller) => controller.filePath === "src/react-one.js",
    );
    const second = controllers.find(
      (controller) => controller.filePath === "src/react-two.js",
    );
    const firstSnapshot = app.hunkDiscoverySnapshot(first.fileElement);
    const generation = app.diffMutationGeneration;

    second.lines[0].element.querySelector("code").textContent =
      "+other-file-change";
    await waitFor(() =>
      assert.equal(app.diffMutationGeneration > generation, true),
    );
    assert.equal(app.hunkDiscoverySnapshotIsCurrent(firstSnapshot), true);

    const nextFirstSnapshot = app.hunkDiscoverySnapshot(first.fileElement);
    first.lines[0].element.querySelector("code").textContent =
      "+same-file-change";
    await waitFor(() => {
      assert.equal(
        app.hunkDiscoverySnapshotIsCurrent(nextFirstSnapshot),
        false,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("invalidates another file during expected visibility settlement", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.scheduleRefresh = () => {};
    const controllers = controllersFor(app);
    const first = controllers.find(
      (controller) => controller.filePath === "src/react-one.js",
    );
    const second = controllers.find(
      (controller) => controller.filePath === "src/react-two.js",
    );
    assert.ok(first);
    assert.ok(second);
    const staleLine = second.lines[0];
    const staleLineKey = staleLine.key;
    const secondSnapshot = app.hunkDiscoverySnapshot(second.fileElement);
    app.expectFileDiffVisibility(first.fileElement, false);

    first.hunkCell.remove();
    second.lines[0].element.querySelector("code").textContent =
      "+simultaneous other-file change";

    await waitFor(() => {
      assert.equal(
        app.hunkDiscoverySnapshotIsCurrent(secondSnapshot),
        false,
      );
      assert.equal(app.reviewControllerIsSuspended(second), true);
      assert.equal(second.input.disabled, true);
      assert.equal(staleLine.control.disabled, true);
    });
    staleLine.control.disabled = false;
    staleLine.control.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    assert.equal(staleLineKey in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("retries file hydration across queued and running full refreshes", async () => {
  for (const busyField of ["refreshQueued", "refreshRunning"]) {
    const { app, dom } = await startExtension(
      currentReactContextExpansionFixture(),
    );
    try {
      app.observer.disconnect();
      app.constants = {
        ...app.constants,
        DIFF_LOAD_FILE_HYDRATION_RETRY_MS: 10,
        DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
      };
      const filePath = "src/react-one.js";
      const fileGrid = fileGridFor(dom, filePath);
      const fileRegion = fileGrid.closest('[role="region"]');
      appendDiffLoader(dom, fileGrid);
      const { hunkRow } = appendAdditionHunk(dom, fileGrid, {
        anchor: "diff-refresh-collision-R40",
        lineNumber: 40,
        text: `+${busyField} collision`,
      });
      app.rememberDeferredDiffLoadRefresh(filePath, fileRegion);
      app[busyField] = true;

      assert.equal(
        app.scheduleDiffLoadFileHydration(filePath, fileRegion),
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.equal(app.diffLoadHydrations.has(filePath), true);
      assert.equal(
        hunkRow.querySelector(".hunkmark-hunk-actions"),
        null,
      );

      app[busyField] = false;
      app.pumpDiffLoadFileHydrations();
      await waitFor(() => {
        const controller = controllersFor(app).find((candidate) =>
          candidate.lines.some(
            (line) => line.text === `+${busyField} collision`,
          ),
        );
        assert.ok(controller);
        assert.equal(controller.actions.isConnected, true);
        assert.equal(
          controller.hunkRow.classList.contains(
            "hunkmark-sticky-hunk-row",
          ),
          true,
        );
        assert.equal(app.diffLoadHydrations.has(filePath), false);
      });
      assert.equal(app.deferredDiffLoadRefreshes.has(filePath), true);
    } finally {
      app[busyField] = false;
      app.stop();
      dom.window.close();
    }
  }
});

test("yields an initial refresh to a deferred viewport hydration", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
    {},
    { waitForScope: false },
  );
  const preferencesEntered = createDeferred();
  const resumePreferences = createDeferred();
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_RETRY_MS: 10,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
    };
    const loadPreferences = app.loadPreferences.bind(app);
    app.loadPreferences = async () => {
      await loadPreferences();
      preferencesEntered.resolve();
      await resumePreferences.promise;
    };
    let documentDiscoveries = 0;
    const discoverHunks = app.discoverHunks.bind(app);
    app.discoverHunks = async (searchRoot) => {
      if (searchRoot === undefined || searchRoot === app.document) {
        documentDiscoveries += 1;
      }
      return discoverHunks(searchRoot);
    };

    await preferencesEntered.promise;
    assert.equal(app.refreshRunning, true);
    const filePath = "src/react-one.js";
    const fileGrid = fileGridFor(dom, filePath);
    appendDiffLoader(dom, fileGrid);
    appendAdditionHunk(dom, fileGrid, {
      anchor: "diff-initial-refresh-R50",
      lineNumber: 50,
      text: "+deferred before discovery",
    });
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.has(filePath), true);
      assert.equal(app.diffLoadHydrations.has(filePath), true);
    });

    resumePreferences.resolve();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(documentDiscoveries, 0);
      const controller = controllersFor(app).find((candidate) =>
        candidate.lines.some(
          (line) => line.text === "+deferred before discovery",
        ),
      );
      assert.ok(controller);
      assert.equal(controller.actions.isConnected, true);
      assert.equal(
        controller.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-row",
        ),
        true,
      );
    });
    assert.equal(app.deferredDiffLoadRefreshes.has(filePath), true);
  } finally {
    resumePreferences.resolve();
    app.stop();
    dom.window.close();
  }
});

test("hydrates a stable file scrolled into an aborted initial refresh", async () => {
  const fileCount = 30;
  const loadingIndex = fileCount - 1;
  const scrolledIndex = 20;
  const { app, dom } = await startExtension(
    manyFileHunkFixture(fileCount),
    {},
    { waitForScope: false },
  );
  const preferencesEntered = createDeferred();
  const resumePreferences = createDeferred();
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_RETRY_MS: 10,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
    };
    const fileRegions = Array.from(
      dom.window.document.querySelectorAll('[role="region"]'),
    );
    assert.equal(fileRegions.length, fileCount);
    fileRegions.forEach((fileRegion, index) => {
      fileRegion.getBoundingClientRect = () =>
        index === loadingIndex
          ? { bottom: 400, top: 100 }
          : { bottom: 5_200, top: 5_000 };
    });
    const loadPreferences = app.loadPreferences.bind(app);
    app.loadPreferences = async () => {
      await loadPreferences();
      preferencesEntered.resolve();
      await resumePreferences.promise;
    };
    let documentDiscoveries = 0;
    const discoverHunks = app.discoverHunks.bind(app);
    app.discoverHunks = async (searchRoot) => {
      if (searchRoot === undefined || searchRoot === app.document) {
        documentDiscoveries += 1;
      }
      return discoverHunks(searchRoot);
    };

    await preferencesEntered.promise;
    const loadingPath = `src/chunk-${loadingIndex}.js`;
    const loadingGrid = fileGridFor(dom, loadingPath);
    appendDiffLoader(dom, loadingGrid);
    await waitFor(() =>
      assert.equal(app.deferredDiffLoadRefreshes.has(loadingPath), true),
    );

    resumePreferences.resolve();
    const scrolledPath = `src/chunk-${scrolledIndex}.js`;
    await waitFor(() => {
      assert.equal(documentDiscoveries, 0);
      assert.equal(app.diffLoadHydrations.has(scrolledPath), true);
    });
    assert.equal(
      controllersFor(app).some(
        (controller) => controller.filePath === scrolledPath,
      ),
      false,
    );

    fileRegions[scrolledIndex].getBoundingClientRect = () => ({
      bottom: 400,
      top: 100,
    });
    app.reprioritizeViewportHydrations();
    await waitFor(() => {
      const controller = controllersFor(app).find(
        (candidate) => candidate.filePath === scrolledPath,
      );
      assert.ok(controller);
      assert.equal(controller.actions.isConnected, true);
      assert.equal(controller.input.disabled, false);
      assert.equal(
        controller.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-row",
        ),
        true,
      );
    }, 1_000);
    assert.equal(app.deferredDiffLoadRefreshes.has(loadingPath), true);
  } finally {
    resumePreferences.resolve();
    app.stop();
    dom.window.close();
  }
});

test("bootstraps one current root per repeated file path", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.observer.disconnect();
    app.clearDeferredDiffLoadRefreshes();
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 5_000,
    };
    const originalRegion = dom.window.document
      .querySelector('[aria-label="Diff for: src/react-one.js"]')
      .closest('[role="region"]');
    const replacementRegion = originalRegion.cloneNode(true);
    replacementRegion.id = "diff-react-one-replacement";
    replacementRegion
      .querySelectorAll('[data-hunkmark-ui="true"]')
      .forEach((element) => element.remove());
    originalRegion.parentElement.append(replacementRegion);

    app.bootstrapRenderedDiffLoadHydrations();

    const filePath = "src/react-one.js";
    assert.equal(
      app.deferredDiffLoadRefreshes.get(filePath)?.fileElement,
      replacementRegion,
    );
    assert.equal(
      app.diffLoadHydrations.get(filePath)?.fileElement,
      replacementRegion,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bootstrap suspends an existing controller for an attribute-only loader", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.clearDeferredDiffLoadRefreshes();
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
    };
    const filePath = "src/react-one.js";
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === filePath,
    );
    const line = controller.lines[0];
    const staleLineKey = line.key;
    const fileRegion = controller.fileElement;
    fileRegion.id = "diff-react-one-loading";
    fileRegion.setAttribute("aria-label", `Loading ${filePath}`);

    app.bootstrapRenderedDiffLoadHydrations();

    assert.equal(app.fileDiffHasActiveLoadingContent(fileRegion), true);
    assert.equal(app.deferredDiffLoadRefreshes.has(filePath), true);
    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(controller.input.disabled, true);
    assert.equal(line.control.disabled, true);
    line.control.disabled = false;
    line.control.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    assert.equal(staleLineKey in chrome.snapshot(), false);
    await waitFor(() => {
      assert.equal(app.diffLoadHydrations.has(filePath), false);
      assert.equal(app.reviewControllerIsSuspended(controller), true);
      assert.equal(controller.input.disabled, true);
      assert.equal(line.control.disabled, true);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("reserves hydration capacity for a newly visible file", async () => {
  const contract = await hydrationQueueContract(["a.js", "b.js", "c.js"]);
  try {
    ["a.js", "b.js", "c.js"].forEach(contract.schedule);
    await waitFor(() => assert.deepEqual(contract.started, ["a.js"]));
    await waitFor(() => {
      assert.equal(contract.app.diffLoadHydrations.get("b.js")?.ready, true);
      assert.equal(contract.app.diffLoadHydrations.get("c.js")?.ready, true);
    });
    contract.setRect("b.js", { bottom: -100, top: -200 });
    contract.setRect("c.js", { bottom: 400, top: 100 });
    contract.app.reprioritizeViewportHydrations();
    await waitFor(() => assert.deepEqual(contract.started, ["a.js", "c.js"]));
    assert.equal(contract.maxRunning, 2);
    contract.release("c.js");
    contract.release("a.js");
    await waitFor(() =>
      assert.deepEqual(contract.started, ["a.js", "c.js", "b.js"]),
    );
    contract.release("b.js");
    await waitFor(() =>
      assert.equal(contract.app.diffLoadHydrations.size, 0),
    );
    assert.equal(contract.maxRunning, 2);
  } finally {
    contract.stop();
  }
});

test("promotes a file reflowed into view without a scroll event", async () => {
  const contract = await hydrationQueueContract(
    ["a.js", "b.js"],
    { DIFF_LOAD_HYDRATION_SCROLL_SETTLE_MS: 10 },
  );
  try {
    contract.schedule("a.js");
    contract.schedule("b.js");
    await waitFor(() => assert.deepEqual(contract.started, ["a.js"]));
    await waitFor(() =>
      assert.equal(
        contract.app.diffLoadHydrations.get("b.js")?.ready,
        true,
      ),
    );

    contract.setRect("b.js", { bottom: 400, top: 100 });
    contract.dom.window.document.elementsFromPoint = () => [
      contract.elements.get("b.js").querySelector("code"),
    ];
    const hostReflow = contract.dom.window.document.createElement("div");
    contract.app.handleMutations([
      {
        addedNodes: [hostReflow],
        removedNodes: [],
        target: contract.dom.window.document.body,
      },
    ]);

    await waitFor(() =>
      assert.deepEqual(contract.started, ["a.js", "b.js"]),
    );
    contract.release("b.js");
    contract.release("a.js");
    await waitFor(() =>
      assert.equal(contract.app.diffLoadHydrations.size, 0),
    );
  } finally {
    contract.stop();
  }
});

test("rolls back a canceled hydration write before timeout refresh", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  const storageWriteEntered = createDeferred();
  const resumeStorageWrite = createDeferred();
  try {
    app.observer.disconnect();
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
    };
    const filePath = "src/react-one.js";
    const fileGrid = fileGridFor(dom, filePath);
    const fileRegion = fileGrid.closest('[role="region"]');
    const { lineRow } = appendAdditionHunk(dom, fileGrid, {
      anchor: "diff-timeout-barrier-R60",
      lineNumber: 60,
      text: "+timeout barrier",
    });
    app.rememberDeferredDiffLoadRefresh(filePath, fileRegion);
    const discovered = await app.discoverHunks(fileRegion);
    const staleLine = discovered
      .flatMap((hunk) => hunk.lines)
      .find((line) => line.text === "+timeout barrier");
    assert.ok(staleLine);
    await app.setReviewStorage({
      [staleLine.legacyKey]: {
        contextFingerprint: staleLine.contextFingerprint,
        viewedAt: Date.now() - 1_000,
      },
    });
    let holdStorageWrite = true;
    const setReviewStorageValuesUnlocked =
      app.setReviewStorageValuesUnlocked.bind(app);
    app.setReviewStorageValuesUnlocked = async (values) => {
      if (holdStorageWrite && staleLine.key in values) {
        holdStorageWrite = false;
        storageWriteEntered.resolve();
        await resumeStorageWrite.promise;
      }
      return setReviewStorageValuesUnlocked(values);
    };
    let documentDiscoveries = 0;
    const discoverHunks = app.discoverHunks.bind(app);
    app.discoverHunks = async (searchRoot, options) => {
      if (searchRoot === undefined || searchRoot === app.document) {
        documentDiscoveries += 1;
      }
      return discoverHunks(searchRoot, options);
    };
    app.scheduleDiffLoadFileHydration(filePath, fileRegion);
    await storageWriteEntered.promise;
    assert.equal(app.diffLoadHydrationRunningStates.size, 1);
    lineRow.querySelector("code").textContent = "+timeout replacement";

    app.deferredDiffLoadRefreshTimedOut = true;
    app.clearDeferredDiffLoadRefreshes();
    app.scheduleRefresh({ immediate: true });
    await waitFor(() => {
      assert.equal(app.refreshAfterDiffLoadHydrations, true);
      assert.equal(app.refreshRunning, false);
      assert.equal(documentDiscoveries, 0);
    });

    resumeStorageWrite.resolve();
    await waitFor(() => {
      assert.equal(app.diffLoadHydrationRunningStates.size, 0);
      assert.equal(app.refreshAfterDiffLoadHydrations, false);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(documentDiscoveries, 1);
    });
    const stored = chrome.snapshot();
    assert.equal(staleLine.key in stored, false);
    assert.equal(staleLine.legacyKey in stored, true);
  } finally {
    resumeStorageWrite.resolve();
    app.stop();
    dom.window.close();
  }
});

test("rolls back a canceled full-refresh migration write", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  const storageWriteEntered = createDeferred();
  const resumeStorageWrite = createDeferred();
  try {
    app.observer.disconnect();
    const fileGrid = fileGridFor(dom, "src/react-one.js");
    const fileRegion = fileGrid.closest('[role="region"]');
    const { lineRow } = appendAdditionHunk(dom, fileGrid, {
      anchor: "diff-full-refresh-race-R70",
      lineNumber: 70,
      text: "+old full-refresh race",
    });
    const discovered = await app.discoverHunks(fileRegion);
    const staleLine = discovered
      .flatMap((hunk) => hunk.lines)
      .find((line) => line.text === "+old full-refresh race");
    assert.ok(staleLine);
    await app.setReviewStorage({
      [staleLine.legacyKey]: {
        contextFingerprint: staleLine.contextFingerprint,
        viewedAt: Date.now() - 1_000,
      },
    });
    let holdStorageWrite = true;
    const setReviewStorageValuesUnlocked =
      app.setReviewStorageValuesUnlocked.bind(app);
    app.setReviewStorageValuesUnlocked = async (values) => {
      if (holdStorageWrite && staleLine.key in values) {
        holdStorageWrite = false;
        storageWriteEntered.resolve();
        await resumeStorageWrite.promise;
      }
      return setReviewStorageValuesUnlocked(values);
    };

    const refreshPromise = app.refresh();
    await storageWriteEntered.promise;
    lineRow.querySelector("code").textContent = "+new full-refresh race";
    app.diffMutationGeneration += 1;
    resumeStorageWrite.resolve();
    await refreshPromise;

    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      const replacementLine = controllersFor(app)
        .flatMap((controller) => controller.lines)
        .find((line) => line.text === "+new full-refresh race");
      assert.ok(replacementLine);
      assert.equal(replacementLine.marked, false);
      assert.equal(replacementLine.key in chrome.snapshot(), false);
    });
    const stored = chrome.snapshot();
    assert.equal(staleLine.key in stored, false);
    assert.equal(staleLine.legacyKey in stored, true);
  } finally {
    resumeStorageWrite.resolve();
    app.stop();
    dom.window.close();
  }
});

test("rolls back a canceled migration after post-write pruning", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  const pruneEntered = createDeferred();
  const resumePrune = createDeferred();
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const line = controller.lines[0];
    const viewedAt = Date.now() - 1_000;
    const removalKey = "hunkmark:test:cancel-removal";
    await app.setLocalStorage({
      [removalKey]: { retained: true },
    });
    await app.setReviewStorage({
      [line.legacyKey]: {
        contextFingerprint: line.contextFingerprint,
        viewedAt,
      },
    });
    app.reviewStorageLimitExceeded = () => true;
    const removedKeyBatches = [];
    const removeReviewStorageUnlocked =
      app.removeReviewStorageUnlocked.bind(app);
    app.removeReviewStorageUnlocked = async (keys) => {
      removedKeyBatches.push(Array.isArray(keys) ? [...keys] : [keys]);
      return removeReviewStorageUnlocked(keys);
    };
    app.ensureStoredReviewStatePrunedUnlocked = async () => {
      if (removedKeyBatches.length === 0) {
        return;
      }
      pruneEntered.resolve();
      await resumePrune.promise;
    };
    let current = true;
    const pendingMutation = app.withReviewStorageLock(() =>
      app.mutateReviewStorageUnlocked({
        isCurrent: () => current,
        now: viewedAt,
        removals: [line.legacyKey, removalKey],
        scope: app.currentReviewScope,
        values: {
          [line.key]: app.lineReviewStorageValue(line, viewedAt),
        },
      }),
    );
    await pruneEntered.promise;
    assert.equal(line.key in chrome.snapshot(), true);
    assert.deepEqual(removedKeyBatches, [[line.legacyKey, removalKey]]);
    assert.equal(removalKey in chrome.snapshot(), false);

    current = false;
    resumePrune.resolve();
    assert.equal(await pendingMutation, false);
    assert.equal(line.key in chrome.snapshot(), false);
    assert.equal(removalKey in chrome.snapshot(), true);
    assert.equal(line.legacyKey in chrome.snapshot(), true);
  } finally {
    resumePrune.resolve();
    app.stop();
    dom.window.close();
  }
});

test("does not wait for pending file hydration before full settlement", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 5_000,
      DIFF_LOAD_REFRESH_SETTLE_MS: 20,
    };
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };
    const fileElement = dom.window.document.querySelector(".js-file");
    const diffBody = fileElement.querySelector("tbody");
    const loader = appendDiffLoader(dom, fileElement);
    await waitFor(() =>
      assert.equal(app.deferredDiffLoadRefreshes.size, 1),
    );

    const hunkRow = dom.window.document.createElement("tr");
    hunkRow.innerHTML =
      '<td class="blob-code-hunk">@@ -40 +40 @@</td>';
    const lineRow = dom.window.document.createElement("tr");
    lineRow.innerHTML =
      '<td class="blob-num">40</td>' +
      '<td class="blob-code-addition">+settled before hydration</td>';
    diffBody.append(hunkRow, lineRow);
    await waitFor(() => assert.equal(app.diffLoadHydrations.size, 1));

    const settledAt = Date.now();
    loader.remove();
    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
      assert.equal(
        controllersFor(app).some((controller) =>
          controller.lines.some(
            (line) => line.text === "+settled before hydration",
          ),
        ),
        true,
      );
    }, 500);

    assert.equal(Date.now() - settledAt < 500, true);
    assert.equal(app.diffLoadHydrations.size, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("settles after pruning a disconnected file from a concurrent diff load", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 500,
      DIFF_LOAD_REFRESH_SETTLE_MS: 10,
    };
    const fileGrids = Array.from(
      dom.window.document.querySelectorAll(
        '[role="grid"][aria-label^="Diff for: "]',
      ),
    );
    assert.equal(fileGrids.length, 2);
    const firstRegion = fileGrids[0].closest('[role="region"]');
    assert.ok(firstRegion);
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };

    const loaders = fileGrids.map((fileGrid, index) =>
      appendDiffLoader(dom, fileGrid, `Loading diff ${index + 1}`),
    );
    await waitFor(() =>
      assert.equal(app.deferredDiffLoadRefreshes.size, 2),
    );

    firstRegion.remove();
    await waitFor(() => {
      assert.equal(app.deferredDiffLoadRefreshes.size, 1);
      assert.equal(controllersFor(app).length, 1);
      assert.equal(refreshes, 0);
    });

    const settledAt = Date.now();
    loaders[1].remove();
    await waitFor(() => assert.equal(refreshes, 1), 250);

    assert.equal(Date.now() - settledAt < 500, true);
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
    assert.equal(controllersFor(app).length, 1);
    assert.equal(
      dom.window.document.querySelector(".hunkmark-panel-summary")
        .textContent,
      "Hunks 0 / 1 · Lines 0 / 1",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("discards loading hydration invalidated during reconciliation", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.observer.disconnect();
    const fileGrid = fileGridFor(dom, "src/react-one.js");
    const fileRegion = fileGrid.closest('[role="region"]');
    appendAdditionHunk(dom, fileGrid, {
      anchor: "diff-hydration-R20",
      lineNumber: 20,
      text: "+hydrated",
    });

    let invalidatedController = null;
    const reconcile = app.reconcileNewReviewControllers.bind(app);
    app.reconcileNewReviewControllers = async (options) => {
      [invalidatedController] = options.newControllers;
      app.reconcileNewReviewControllers = reconcile;
      app.diffMutationGenerationByFileElement.set(
        fileRegion,
        (app.diffMutationGenerationByFileElement.get(fileRegion) ?? 0) + 1,
      );
      return true;
    };

    const hydrated = await app.hydrateDiffLoadFile(
      fileRegion,
      "src/react-one.js",
    );

    assert.equal(hydrated, null);
    assert.ok(invalidatedController);
    assert.equal(invalidatedController.destroyed, true);
    assert.notEqual(
      app.controllersByRow.get(invalidatedController.hunkRow),
      invalidatedController,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test(
  "upgrades loading reconciliation only when migrations are required",
  async () => {
    const locks = createExclusiveLockManager();
    const { app, dom } = await startExtension(
      duplicateHunkFixture(),
      {},
      { lockManager: locks },
    );
    try {
      const controller = controllerAt(app);
      const lockRequestsBeforeReconciliation = locks.requests.length;
      const reconciled = await app.reconcileNewReviewControllers({
        deferStorageMigrations: true,
        expansionAssessmentByController: new Map([
          [
            controller,
            {
              opensHunk: true,
              previous: [],
              reviewIntents: [],
            },
          ],
        ]),
        newControllers: [controller],
      });

      assert.equal(reconciled, true);
      assert.deepEqual(
        locks.requests
          .slice(lockRequestsBeforeReconciliation)
          .map(({ mode }) => mode),
        ["shared", "exclusive"],
      );
    } finally {
      app.stop();
      dom.window.close();
    }
  },
);

test("settles a deferred React diff load from its aria label", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const fileGrid = dom.window.document.querySelector(
      '[aria-label="Diff for: src/react-one.js"]',
    );
    assert.ok(fileGrid);
    const fileRegion = fileGrid.closest('[role="region"]');
    assert.ok(fileRegion);
    const diffBody = fileGrid.querySelector("tbody");
    assert.ok(diffBody);
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };

    fileRegion.id = "diff-react-one";
    fileRegion.setAttribute("aria-label", "Loading src/react-one.js");
    const partialDiffRow = dom.window.document.createElement("tr");
    partialDiffRow.className = "diff-line-row";
    partialDiffRow.setAttribute("data-line-type", "context");
    partialDiffRow.innerHTML =
      '<td class="diff-text-cell"><code>partial context</code></td>';
    diffBody.append(partialDiffRow);

    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshes, 0);
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);

    fileRegion.setAttribute("aria-label", "Diff file src/react-one.js");

    await waitFor(() => assert.equal(refreshes, 1));
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("cleans deferred diff loading refresh state on stop", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const fileGrid = fileGridFor(dom, "src/react-one.js");
    appendDiffLoader(dom, fileGrid);

    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(app.deferredDiffLoadRefreshes.size, 1);
    assert.notEqual(app.deferredDiffLoadRefreshTimer, null);

    app.stop();

    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bounds a stalled deferred diff load with a fail-closed refresh", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    app.constants = {
      ...app.constants,
      DIFF_LOAD_REFRESH_MAX_WAIT_MS: 40,
    };
    const fileGrid = fileGridFor(dom, "src/react-one.js");
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };
    appendDiffLoader(dom, fileGrid);

    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.refreshRunning, false);
    });
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.deferredDiffLoadRefreshTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps file auxiliary mutations fail-closed without a diff grid", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const fileGrid = dom.window.document.querySelector(
      '[aria-label="Diff for: src/react-one.js"]',
    );
    assert.ok(fileGrid);
    const fileRegion = fileGrid.closest('[role="region"]');
    assert.ok(fileRegion);
    const fileBody = fileGrid.parentElement;
    assert.ok(fileBody);
    let refreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async (...args) => {
      refreshes += 1;
      return refresh(...args);
    };

    fileGrid.removeAttribute("role");
    fileGrid.removeAttribute("aria-label");
    fileBody.prepend(dom.window.document.createElement("aside"));

    await waitFor(() => assert.equal(refreshes, 1));
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("uses direct current React progress ownership before controller scans", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const fileElements = [
      ...new Set(
        controllersFor(app).map((controller) => controller.fileElement),
      ),
    ];
    const badges = Array.from(
      dom.window.document.querySelectorAll(".hunkmark-file-progress"),
    );
    assert.equal(badges.length, fileElements.length);
    badges.forEach((badge) => {
      assert.equal(
        fileElements.includes(app.directFileElementForProgressBadge(badge)),
        true,
      );
    });

    const directOwner =
      app.directFileElementForProgressBadge.bind(app);
    let directOwnerLookups = 0;
    app.directFileElementForProgressBadge = (badge) => {
      directOwnerLookups += 1;
      return directOwner(badge);
    };
    app.updateProgress();
    assert.equal(app.removeProgressForFilesWithoutRenderedHunks(), false);
    assert.equal(directOwnerLookups, badges.length * 2);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("refreshes when an untracked context identity changes", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const originalController = controllersFor(app).find(
      (controller) => controller.lines[0]?.text === "+first",
    );
    const originalContextFingerprint =
      originalController.lines[0].contextFingerprint;
    const originalRefresh = app.refresh.bind(app);
    let refreshes = 0;
    app.refresh = async (...args) => {
      refreshes += 1;
      return originalRefresh(...args);
    };

    const contextCode = Array.from(
      dom.window.document.querySelectorAll(
        'tr.diff-line-row[data-line-type="context"] code',
      ),
    ).find((code) => code.textContent === "before first");
    contextCode.textContent = "replaced before first";

    await waitFor(() => {
      assert.equal(refreshes, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      const refreshedController = controllersFor(app).find(
        (controller) => controller.lines[0]?.text === "+first",
      );
      assert.notEqual(refreshedController, originalController);
      assert.notEqual(
        refreshedController.lines[0].contextFingerprint,
        originalContextFingerprint,
      );
    });
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
    assert.doesNotMatch(
      style.textContent,
      /\.hunkmark-line-viewed\s+(?:code|pre|\.blob-code-inner|\.diff-text-inner)\s+\*/,
    );
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
      controller.hunkCell.style.getPropertyValue(
        "--hunkmark-host-hunk-action-inset",
      ),
      "16px",
    );
    const hunkCellRule = Array.from(style.sheet.cssRules).find(
      (rule) => rule.selectorText?.includes(".hunkmark-hunk-cell"),
    );
    assert.match(
      hunkCellRule.style.paddingRight,
      /--hunkmark-hunk-actions-clearance/,
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
