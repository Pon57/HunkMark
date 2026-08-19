const {
  test,
  assert,
  path,
  JSDOM,
  Core,
  LEGACY_ACCOUNT_REVIEW_STORAGE_NAMESPACE,
  LEGACY_CONTENT_REVIEW_STORAGE_NAMESPACE,
  createChromeApi,
  createExclusiveLockManager,
  installContentStyles,
  controllersFor,
  controllerAt,
  stopExtensions,
  startLockedExtension,
  captureWarnings,
  lineControls,
  waitFor,
  startExtension,
  duplicateHunkFixture,
  commitSelectionFixture,
  initiallyViewedCommitSelectionFixture,
  replacePageBody,
  dragFixture,
  modernGridFixture,
  contextualLineFixture,
} = require("./content-test-support.cjs");

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

    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 600;
    controller.lines[2].control.focus();
    app.startLineDrag(controller.lines[2], true, 8);
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
