const {
  test,
  assert,
  JSDOM,
  Core,
  lineReviewContextFingerprint,
  withViewerMeta,
  createChromeApi,
  createExclusiveLockManager,
  installContentStyles,
  recordCachedDiscoveryRoots,
  controllerAt,
  changeCheckbox,
  lineControls,
  stopExtensions,
  waitFor,
  assertFileRevealState,
  startExtension,
  duplicateHunkFixture,
  commitSelectionFixture,
  evolvingCommitFixture,
  replacePageBody,
  modernGridFixture,
  layoutReviewFixture,
  contextualLineFixture,
} = require("./content-test-support.cjs");

function lineByText(app, text) {
  return Array.from(app.controllersByRow.values())
    .flatMap((controller) => controller.lines)
    .find((line) => line.text === text);
}

async function startLayoutPair() {
  const chrome = createChromeApi();
  const locks = createExclusiveLockManager();
  const options = { chromeInstance: chrome, lockManager: locks };
  const split = await startExtension(layoutReviewFixture(), {}, options);
  const unified = await startExtension(
    layoutReviewFixture({ layout: "unified" }),
    {},
    options,
  );
  return { chrome, options, split, unified };
}

async function withDateNow(dom, now, callback) {
  const dateNow = dom.window.Date.now;
  dom.window.Date.now = () => now;
  try {
    return await callback();
  } finally {
    dom.window.Date.now = dateNow;
  }
}

test("keeps partial lines local and shares completed hunk state", async () => {
  const { chrome, options, split, unified } = await startLayoutPair();
  let reloaded = null;
  try {
    const splitController = controllerAt(split.app);
    const unifiedController = controllerAt(unified.app);
    const splitDeletion = lineByText(split.app, "-oldAlpha");
    const splitUnpairedDeletion = lineByText(split.app, "-oldBeta");
    const sharedCompletionKey = splitController.sharedCompletionKey;

    assert.notEqual(
      splitDeletion.contextFingerprint,
      unifiedController.lines[0].contextFingerprint,
    );
    assert.equal(sharedCompletionKey, unifiedController.sharedCompletionKey);
    assert.ok(sharedCompletionKey);

    splitDeletion.control.click();
    await waitFor(() => {
      assert.equal(splitController.indeterminate, true);
      assert.equal(
        unifiedController.lines.every((line) => !line.marked),
        true,
      );
    });

    await split.app.setLineViewed(splitUnpairedDeletion, true);
    await waitFor(() => {
      assert.equal(splitController.marked, true);
      assert.equal(unifiedController.marked, true);
      assert.equal(unifiedController.collapsed, true);
      assert.equal(chrome.snapshot()[sharedCompletionKey]?.viewed, true);
    });

    await unified.app.setCollapsed(unifiedController, false);
    await waitFor(() => {
      assert.equal(unifiedController.collapsed, false);
      assert.equal(splitController.collapsed, false);
    });

    let authoritativeClearAt = 0;
    let stalePartialAt = 0;
    chrome.api.storage.onChanged.removeListener(
      unified.app.boundStorageChanged,
    );
    try {
      await split.app.setHunkViewed(splitController, false);
      const authoritativeClear =
        chrome.snapshot()[sharedCompletionKey];
      authoritativeClearAt =
        unified.app.sharedHunkCompletionClearTimestamp(authoritativeClear);
      assert.ok(authoritativeClearAt > 0);
      assert.equal(unifiedController.marked, true);
      await withDateNow(
        unified.dom,
        authoritativeClearAt - 1000,
        () => unified.app.setLineViewed(unifiedController.lines[0], false),
      );
      const stalePartial = chrome.snapshot()[sharedCompletionKey];
      stalePartialAt = unified.app.reviewEntryTimestamp(stalePartial);
      assert.equal(stalePartial?.partial, true);
      assert.ok(stalePartialAt > authoritativeClearAt);
      assert.equal(
        unified.app.sharedHunkCompletionClearTimestamp(stalePartial),
        authoritativeClearAt,
      );
    } finally {
      chrome.api.storage.onChanged.addListener(
        unified.app.boundStorageChanged,
      );
    }
    await waitFor(() => {
      assert.equal(
        splitController.lines.every((line) => !line.marked),
        true,
      );
    });
    await withDateNow(split.dom, stalePartialAt, () =>
      split.app.setHunkViewed(splitController, true),
    );
    const completionAt = split.app.reviewEntryTimestamp(
      chrome.snapshot()[sharedCompletionKey],
    );
    assert.ok(completionAt > stalePartialAt);
    await withDateNow(unified.dom, completionAt, () =>
      unified.app.setHunkViewed(unifiedController, false),
    );
    await waitFor(() => {
      assert.equal(
        [splitController, unifiedController].every((controller) =>
          controller.lines.every((line) => !line.marked),
        ),
        true,
      );
      assert.equal(chrome.snapshot()[sharedCompletionKey]?.viewed, false);
      assert.ok(chrome.snapshot()[splitDeletion.key]);
    });
    const firstClearAt = unified.app.sharedHunkCompletionClearTimestamp(
      chrome.snapshot()[sharedCompletionKey],
    );
    assert.ok(firstClearAt > completionAt);
    await unified.app.setHunkViewed(unifiedController, true);
    await waitFor(() => {
      const completion = chrome.snapshot()[sharedCompletionKey];
      assert.equal(completion?.viewed, true);
      assert.equal(
        unified.app.sharedHunkCompletionClearTimestamp(completion),
        firstClearAt,
      );
    });
    await unified.app.setLineViewed(unifiedController.lines[0], false);
    await waitFor(() => {
      const partial = chrome.snapshot()[sharedCompletionKey];
      assert.equal(partial?.partial, true);
      assert.equal(
        unified.app.sharedHunkCompletionClearTimestamp(partial),
        firstClearAt,
      );
      assert.equal(
        splitController.lines.every((line) => !line.marked),
        true,
      );
      assert.equal(unifiedController.indeterminate, true);
    });
    await split.app.setCollapsed(splitController, true);
    reloaded = await startExtension(layoutReviewFixture(), {}, options);
    assert.equal(
      controllerAt(reloaded.app).lines.every((line) => !line.marked),
      true,
    );
    assert.equal(controllerAt(reloaded.app).collapsed, true);
  } finally {
    stopExtensions(
      split,
      unified,
      ...(reloaded ? [reloaded] : []),
    );
  }
});

test("migrates legacy v3 lines only from their matching layout", async () => {
  const seed = await startExtension(layoutReviewFixture());
  const viewedAt = Date.now() - 1000;
  const seedController = controllerAt(seed.app);
  const seedLines = seedController.lines;
  const seedCollapsedKey = seedController.collapsedKey;
  const initial = Object.fromEntries(
    seedLines.map((line) => [
      line.legacyKey,
      { contextFingerprint: line.contextFingerprint, viewedAt },
    ]),
  );
  stopExtensions(seed);

  const directChrome = createChromeApi(initial);
  const direct = await startExtension(
    layoutReviewFixture(),
    {},
    { chromeInstance: directChrome },
  );
  try {
    const directController = controllerAt(direct.app);
    assert.equal(directController.marked, true);
    assert.equal(
      directChrome.snapshot()[directController.sharedCompletionKey]?.viewed,
      true,
    );
  } finally {
    stopExtensions(direct);
  }

  const mismatchChrome = createChromeApi({
    ...initial,
    [seedCollapsedKey]: { collapsed: true, updatedAt: viewedAt },
  });
  const mismatch = await startExtension(
    layoutReviewFixture({
      after: "changedAfter();",
      before: "changedBefore();",
      beforeRight: "changedBefore();",
    }),
    {},
    { chromeInstance: mismatchChrome },
  );
  try {
    const mismatchController = controllerAt(mismatch.app);
    assert.equal(mismatchController.collapsedKey, seedCollapsedKey);
    assert.equal(mismatchController.marked, false);
    assert.equal(mismatchController.collapsed, false);
    seedLines.forEach((line) => {
      assert.equal(line.legacyKey in mismatchChrome.snapshot(), true);
    });
    assert.equal(seedCollapsedKey in mismatchChrome.snapshot(), true);
    mismatch.app.startOfficialViewedRestoreGuard(
      mismatchController.officialSuppressionKey,
      mismatchController.filePath,
    );
    assert.equal(mismatch.app.preserveOfficialViewedRestoredState(), true);
    assert.equal(
      mismatchController.groupRows.some(
        (row) =>
          row !== mismatchController.hunkRow &&
          row.classList.contains("hunkmark-collapsed"),
      ),
      false,
    );
  } finally {
    stopExtensions(mismatch);
  }

  const chrome = createChromeApi(initial);
  const locks = createExclusiveLockManager();
  const options = { chromeInstance: chrome, lockManager: locks };
  const unified = await startExtension(
    layoutReviewFixture({ layout: "unified" }),
    {},
    options,
  );
  let split = null;
  try {
    assert.equal(controllerAt(unified.app).marked, false);
    await unified.app.setLineViewed(
      lineByText(unified.app, "-oldAlpha"),
      true,
    );
    const sharedCompletionKey =
      controllerAt(unified.app).sharedCompletionKey;
    assert.equal(chrome.snapshot()[sharedCompletionKey]?.partial, true);
    seedLines.forEach((line) => {
      assert.equal(line.legacyKey in chrome.snapshot(), true);
    });

    split = await startExtension(layoutReviewFixture(), {}, options);
    await waitFor(() => {
      const splitController = controllerAt(split.app);
      assert.equal(splitController.marked, true);
      splitController.lines.forEach((line) => {
        assert.ok(chrome.snapshot()[line.key]);
        assert.equal(line.legacyKey in chrome.snapshot(), false);
      });
      assert.equal(
        chrome.snapshot()[splitController.sharedCompletionKey]?.partial,
        true,
      );
      assert.equal(controllerAt(unified.app).marked, false);
      assert.equal(controllerAt(unified.app).indeterminate, true);
    });
  } finally {
    stopExtensions(unified, ...(split ? [split] : []));
  }
});

test("derives shared completion identity only for equivalent hunks", async () => {
  const evidenceFor = async (options = {}) => {
    const extension = await startExtension(layoutReviewFixture(options));
    const controller = controllerAt(extension.app);
    const evidence = {
      completionKey: controller.sharedCompletionKey,
      layout: controller.lines[0].layout,
      lineKey: controller.lines[0].key,
    };
    stopExtensions(extension);
    return evidence;
  };
  const duplicates = {
    additions: ["same"],
    deletions: ["same", "same"],
  };
  const evidence = await Promise.all([
    evidenceFor(),
    evidenceFor({ layout: "unified" }),
    evidenceFor({ before: "fartherBefore();" }),
    evidenceFor({ before: "fartherBefore();", layout: "unified" }),
    evidenceFor({ beforeRight: "differentBefore();" }),
    evidenceFor({ additions: ["only"], deletions: [] }),
    evidenceFor({ additions: ["only"], deletions: [], layout: "unified" }),
    evidenceFor(duplicates),
    evidenceFor({ ...duplicates, layout: "unified" }),
    evidenceFor({
      additions: ["same"],
      deletions: ["same", "same", "same"],
      layout: "unified",
    }),
  ]);
  const [
    split,
    unified,
    expandedSplit,
    expandedUnified,
    ambiguous,
    pureSplit,
    pureUnified,
    duplicateSplit,
    duplicateUnified,
    changedCount,
  ] = evidence;

  assert.equal(split.completionKey, unified.completionKey);
  assert.equal(expandedSplit.completionKey, expandedUnified.completionKey);
  assert.notEqual(split.completionKey, expandedSplit.completionKey);
  assert.equal(ambiguous.completionKey, null);
  assert.equal(pureSplit.layout, "split");
  assert.equal(pureUnified.layout, "unified");
  assert.notEqual(pureSplit.lineKey, pureUnified.lineKey);
  assert.equal(pureSplit.completionKey, pureUnified.completionKey);
  assert.equal(duplicateSplit.completionKey, duplicateUnified.completionKey);
  assert.notEqual(duplicateSplit.completionKey, changedCount.completionKey);

  const chrome = createChromeApi();
  const locks = createExclusiveLockManager();
  const options = { chromeInstance: chrome, lockManager: locks };
  const duplicateSplitLayout = await startExtension(
    layoutReviewFixture({
      hunks: [
        { beforeRight: "differentBefore();" },
        { headerText: "@@ -30,4 +30,3 @@ example()" },
      ],
      layout: "split",
    }),
    {},
    options,
  );
  const duplicateUnifiedLayout = await startExtension(
    layoutReviewFixture({
      hunks: [
        {},
        { headerText: "@@ -30,4 +30,3 @@ example()" },
      ],
      layout: "unified",
    }),
    {},
    options,
  );
  try {
    const splitHunks = Array.from(
      duplicateSplitLayout.app.controllersByRow.values(),
    );
    const unifiedHunks = Array.from(
      duplicateUnifiedLayout.app.controllersByRow.values(),
    );
    assert.equal(splitHunks[0].sharedCompletionKey, null);
    assert.equal(
      splitHunks[1].sharedCompletionKey,
      unifiedHunks[1].sharedCompletionKey,
    );
    assert.notEqual(
      splitHunks[1].sharedCompletionKey,
      unifiedHunks[0].sharedCompletionKey,
    );
    await duplicateSplitLayout.app.setHunkViewed(splitHunks[1], true);
    await waitFor(() => {
      assert.deepEqual(
        unifiedHunks.map((controller) => controller.marked),
        [false, true],
      );
    });
  } finally {
    stopExtensions(duplicateSplitLayout, duplicateUnifiedLayout);
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

test("restores cached collapsed state before materializing line controls", async () => {
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
      0,
    );
    assert.equal(
      Array.from(app.controllersByRow.values()).every((controller) =>
        controller.lines.every((line) => line.control === null),
      ),
      true,
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
      false,
    );
    assert.equal(app.fileDiffVisibilityPending.size, 0);

    const immediateRefreshCountAfterCollapse = scheduled.filter(
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
      scheduled.filter(({ immediate }) => immediate === true).length,
      immediateRefreshCountAfterCollapse,
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
      assert.equal(
        controller.collapseButton.getAttribute("aria-label"),
        "Expand this diff hunk",
      );
      assert.equal(
        controller.collapseButton.getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        controller.collapseButton.classList.contains("is-collapsed"),
        true,
      );
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
      const controllers = Array.from(second.app.controllersByRow.values());
      assert.equal(controls.length, 1);
      assert.equal(controls[0].getAttribute("aria-pressed"), "false");
      assert.equal(controllers[0].collapsed, true);
      assert.equal(controllers[0].lines[0].control, null);
      assert.equal(controllers[1].lines[0].control, controls[0]);
    });

    const firstController = Array.from(
      second.app.controllersByRow.values(),
    )[0];
    firstController.collapseButton.click();
    await waitFor(() => {
      assert.equal(firstController.collapsed, false);
      assert.equal(lineControls(second.dom).length, 2);
      assert.equal(
        firstController.lines[0].control?.getAttribute("aria-pressed"),
        "true",
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

test("does not sync official Viewed while a host loading spinner remains", async () => {
  const fixture = contextualLineFixture({ officialControl: true }).replace(
    "<table>",
    '<div class="js-diff-progressive-container"><span data-component="Spinner">Loading</span></div><table>',
  );
  const { app, dom } = await startExtension(fixture);
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
    const controller = controllerAt(app);
    changeCheckbox(dom, controller.input, true);
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.input.disabled, false);
    });
    assert.equal(officialClicks, 0);

    dom.window.document.querySelector('[data-component="Spinner"]').remove();
    changeCheckbox(dom, controller.input, false);
    await waitFor(() => {
      assert.equal(controller.marked, false);
      assert.equal(controller.input.disabled, false);
    });
    changeCheckbox(dom, controller.input, true);
    await waitFor(() => assert.equal(officialClicks, 1));
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
