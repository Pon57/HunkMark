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
  currentReactContextExpansionFixture,
  currentReactContextEvidenceFixture,
  currentReactSplitContextExpansionFixture,
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

    const preview = dom.window.document.createElement("div");
    preview.innerHTML = `
      <pre><code>const draft = true;</code></pre>
      <h3><a href="#diff-user-content">Linked preview</a></h3>
      <table><tbody><tr><td>Table preview</td></tr></tbody></table>
      <div role="row"><span role="cell">Grid preview</span></div>`;
    auxiliaryUi.append(preview);
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
    const diffRow = dom.window.document.createElement("tr");
    diffRow.className = "diff-line-row";
    diffRow.setAttribute("data-line-type", "context");
    diffRow.innerHTML =
      '<td class="diff-text-cell"><code>new context</code></td>';
    const diffBody = fileGrid.querySelector("tbody");
    assert.ok(diffBody);
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
