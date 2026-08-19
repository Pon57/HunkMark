const {
  test,
  assert,
  path,
  Core,
  createDeferred,
  holdReviewStorageLock,
  delayReviewStorageSet,
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
  setOfficialViewed,
  respondToOfficialClicks,
  assertOfficialIntentSettled,
  waitFor,
  startExtension,
  duplicateHunkFixture,
  commitSelectionFixture,
  initiallyViewedCommitSelectionFixture,
} = require("./content-test-support.cjs");

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

test("defers discovery when HunkMark Viewed sync hides the diff", async () => {
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
      false,
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
