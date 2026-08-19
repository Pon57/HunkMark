const {
  test,
  assert,
  JSDOM,
  delayReviewStorageSet,
  delayReviewStorageRemove,
  controllersFor,
  contextExpansionIntentFor,
  fileReviewSnapshotFor,
  stopExtensions,
  startSharedExtensions,
  startLockedExtension,
  captureWarnings,
  changeCheckbox,
  waitFor,
  startExtension,
  semanticMergeableHunkFixture,
  replaceSemanticMergeFixtureRows,
  currentReactOverlappingContextExpansionFixture,
  replaceCurrentReactOverlappingContextRows,
  currentReactMergedExpansionTable,
  currentReactContextEvidenceFixture,
  replaceCurrentReactContextEvidenceRows,
  appendCurrentReactTrailingContextEvidence,
  currentReactMergedContextEvidenceTable,
} = require("./content-test-support.cjs");

test("rejects an ambiguous cached hunk mapping", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const filePath = controllersFor(app)[0].filePath;
    const cached = app.hostContextExpansionCachedFileSnapshot(filePath);
    const discovered = app.discoverCachedHunks();
    assert.equal(
      app.hostContextExpansionCachedHunkGroupsVerdict(
        cached.cachedHunkGroups,
        [discovered[0], ...discovered],
        filePath,
      ),
      "rejected",
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves reviewed lines without programmatic scrolling across a semantic context expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 3);
    });
    const [first, second, third] = Array.from(
      app.controllersByRow.values(),
    );
    [first, second].forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(first.collapsed, true);
      assert.equal(second.collapsed, true);
      assert.equal(third.marked, false);
    });

    const previousSecondFingerprint = second.lines[0].contextFingerprint;
    const previousCollapsedKeys = [first.collapsedKey, second.collapsedKey];
    const expansionControl = third.hunkRow.querySelector(".js-expand");
    const scrollCalls = [];
    dom.window.scrollBy = (...args) => scrollCalls.push(["by", ...args]);
    dom.window.scrollTo = (...args) => scrollCalls.push(["to", ...args]);
    const refresh = app.refresh.bind(app);
    let completedRefreshes = 0;
    app.refresh = async () => {
      try {
        return await refresh();
      } finally {
        completedRefreshes += 1;
      }
    };

    expansionControl.click();
    assert.equal(app.hostContextExpansionIntents.size, 0);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    assert.ok(contextExpansionIntentFor(app));
    expansionControl.append(dom.window.document.createElement("span"));
    await waitFor(() => {
      assert.equal(completedRefreshes, 1);
    });
    assert.ok(contextExpansionIntentFor(app));
    replaceSemanticMergeFixtureRows(dom.window.document);

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, true, false],
      );
      assert.equal(merged.marked, false);
      assert.equal(merged.indeterminate, true);
      assert.equal(merged.collapsed, false);
    });

    const stored = chrome.snapshot();
    const migratedSecond = stored[merged.lines[1].key];
    assert.notEqual(
      merged.lines[1].contextFingerprint,
      previousSecondFingerprint,
    );
    assert.equal(
      migratedSecond.contextFingerprint,
      merged.lines[1].contextFingerprint,
    );
    assert.equal(
      migratedSecond.baselineContextFingerprint,
      previousSecondFingerprint,
    );
    assert.deepEqual(
      Object.keys(migratedSecond).sort(),
      ["baselineContextFingerprint", "contextFingerprint", "viewedAt"],
    );
    assert.equal(
      previousCollapsedKeys.some((key) => key in stored),
      false,
    );
    assert.deepEqual(scrollCalls, []);
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 0 \/ 1 · Lines 2 \/ 3/,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves reviewed lines after GitHub reloads contracted context", async () => {
  const firstPage = await startExtension(semanticMergeableHunkFixture());
  let secondPage = null;
  try {
    const [first, second, third] = controllersFor(firstPage.app);
    [first, second].forEach((controller) =>
      changeCheckbox(firstPage.dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(firstPage.chrome.snapshot()[first.lines[0].key]);
      assert.ok(firstPage.chrome.snapshot()[second.lines[0].key]);
    });

    firstPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(firstPage.dom.window.document);
    await waitFor(() => {
      const [merged] = controllersFor(firstPage.app);
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, true, false],
      );
    });

    firstPage.app.stop();
    firstPage.dom.window.close();
    secondPage = await startExtension(semanticMergeableHunkFixture(), {}, {
      chromeInstance: firstPage.chrome,
    });

    assert.deepEqual(
      controllersFor(secondPage.app).map((controller) => controller.marked),
      [true, true, false],
    );
    const [reloadedFirst, reloadedSecond] = controllersFor(secondPage.app);
    assert.equal(
      secondPage.app.cachedLineReviewMatches(reloadedFirst.lines[0]),
      true,
    );
    assert.equal(
      secondPage.app.cachedLineReviewMatches(reloadedSecond.lines[0]),
      true,
    );

    changeCheckbox(secondPage.dom, reloadedFirst.input, false);
    await waitFor(() => {
      assert.equal(
        reloadedFirst.lines[0].key in secondPage.chrome.snapshot(),
        false,
      );
      assert.equal(
        secondPage.app.cachedLineReviewMatches(reloadedFirst.lines[0]),
        false,
      );
    });
  } finally {
    if (secondPage) {
      stopExtensions(secondPage);
    } else if (!firstPage.app.stopped) {
      stopExtensions(firstPage);
    }
  }
});

test("keeps the contracted baseline across different expansion paths", async () => {
  const firstPage = await startExtension(semanticMergeableHunkFixture());
  let secondPage = null;
  let thirdPage = null;
  try {
    const [, firstContracted, firstExpansionSource] = controllersFor(
      firstPage.app,
    );
    changeCheckbox(firstPage.dom, firstContracted.input);
    await waitFor(() => {
      assert.ok(firstPage.chrome.snapshot()[firstContracted.lines[0].key]);
    });
    const lineKey = firstContracted.lines[0].key;
    const contractedContext = firstContracted.lines[0].contextFingerprint;

    firstPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: firstExpansionSource.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(firstPage.dom.window.document);

    let firstExpandedContext;
    await waitFor(() => {
      const [firstExpanded] = controllersFor(firstPage.app);
      firstExpandedContext = firstExpanded.lines[1].contextFingerprint;
      const stored = firstPage.chrome.snapshot()[lineKey];
      assert.equal(stored.contextFingerprint, firstExpandedContext);
      assert.equal(stored.baselineContextFingerprint, contractedContext);
    });

    firstPage.app.stop();
    firstPage.dom.window.close();
    secondPage = await startExtension(
      semanticMergeableHunkFixture(),
      {},
      { chromeInstance: firstPage.chrome },
    );
    const [, secondContracted, secondExpansionSource] = controllersFor(
      secondPage.app,
    );
    assert.equal(secondContracted.marked, true);
    assert.equal(
      secondContracted.lines[0].contextFingerprint,
      contractedContext,
    );
    assert.equal(
      secondContracted.lines[0]
        .hostContextExpansionBaselineContextFingerprint,
      undefined,
    );
    assert.equal(
      fileReviewSnapshotFor(secondPage.app, "src/semantic-merge.js")
        .hunks[1].lines[0].baselineContextFingerprint,
      null,
    );

    secondPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: secondExpansionSource.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(secondPage.dom.window.document);
    secondPage.dom.window.document.querySelectorAll(
      ".blob-code-context",
    )[1].textContent = "alternate context between first and second";

    await waitFor(() => {
      const [secondExpanded] = controllersFor(secondPage.app);
      const secondExpandedContext =
        secondExpanded.lines[1].contextFingerprint;
      assert.notEqual(secondExpandedContext, firstExpandedContext);
      const stored = secondPage.chrome.snapshot()[lineKey];
      assert.equal(stored.contextFingerprint, secondExpandedContext);
      assert.equal(stored.baselineContextFingerprint, contractedContext);
    });

    secondPage.app.stop();
    secondPage.dom.window.close();
    thirdPage = await startExtension(
      semanticMergeableHunkFixture(),
      {},
      { chromeInstance: firstPage.chrome },
    );
    assert.equal(controllersFor(thirdPage.app)[1].marked, true);
  } finally {
    if (thirdPage) {
      stopExtensions(thirdPage);
    } else if (secondPage && !secondPage.app.stopped) {
      stopExtensions(secondPage);
    } else if (!firstPage.app.stopped) {
      stopExtensions(firstPage);
    }
  }
});

test("synchronizes contracted and trusted expanded reviews across tabs", async () => {
  const shared = await startSharedExtensions(semanticMergeableHunkFixture());
  try {
    const firstInitialControllers = controllersFor(shared.first.app);
    const originalSecondContext =
      firstInitialControllers[1].lines[0].contextFingerprint;
    shared.first.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: firstInitialControllers[2].hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(shared.first.dom.window.document);

    let firstExpanded;
    await waitFor(() => {
      [firstExpanded] = controllersFor(shared.first.app);
      assert.equal(
        firstExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        originalSecondContext,
      );
    });
    const secondContracted = controllersFor(shared.second.app)[1];

    changeCheckbox(shared.second.dom, secondContracted.input);
    await waitFor(() => {
      assert.equal(firstExpanded.lines[1].marked, true);
      assert.equal(secondContracted.marked, true);
    });

    replaceSemanticMergeFixtureRows(shared.first.dom.window.document);
    await waitFor(() => {
      const [rebuiltExpanded] = controllersFor(shared.first.app);
      assert.notEqual(rebuiltExpanded, firstExpanded);
      assert.equal(rebuiltExpanded.lines[1].marked, true);
      firstExpanded = rebuiltExpanded;
    });

    changeCheckbox(shared.second.dom, secondContracted.input, false);
    await waitFor(() => {
      assert.equal(firstExpanded.lines[1].marked, false);
      assert.equal(secondContracted.marked, false);
    });

    firstExpanded.lines[1].control.click();
    await waitFor(() => {
      assert.equal(firstExpanded.lines[1].marked, true);
      assert.equal(secondContracted.marked, true);
    });

    firstExpanded.lines[1].control.click();
    await waitFor(() => {
      assert.equal(firstExpanded.lines[1].marked, false);
      assert.equal(secondContracted.marked, false);
    });
  } finally {
    stopExtensions(shared.first, shared.second);
  }
});

test("adopts a trusted baseline received by an already-expanded tab", async () => {
  const shared = await startSharedExtensions(semanticMergeableHunkFixture());
  let contractedPage = null;
  try {
    // This tab reached the expanded DOM without a trusted native expansion,
    // so it correctly starts without a baseline alias.
    replaceSemanticMergeFixtureRows(shared.first.dom.window.document);
    let untrustedExpanded;
    await waitFor(() => {
      [untrustedExpanded] = controllersFor(shared.first.app);
      assert.equal(shared.first.app.controllersByRow.size, 1);
      assert.equal(
        untrustedExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        undefined,
      );
      assert.equal(untrustedExpanded.lines[1].marked, false);
    });

    const secondInitial = controllersFor(shared.second.app);
    const contractedContext = secondInitial[1].lines[0].contextFingerprint;
    shared.second.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: secondInitial[2].hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(shared.second.dom.window.document);

    let trustedExpanded;
    await waitFor(() => {
      [trustedExpanded] = controllersFor(shared.second.app);
      assert.equal(shared.second.app.controllersByRow.size, 1);
      assert.equal(
        trustedExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
    });
    trustedExpanded.lines[1].control.click();

    const lineKey = trustedExpanded.lines[1].key;
    await waitFor(() => {
      assert.equal(untrustedExpanded.lines[1].marked, true);
      const stored = shared.first.chrome.snapshot()[lineKey];
      assert.equal(
        stored.contextFingerprint,
        untrustedExpanded.lines[1].contextFingerprint,
      );
      assert.equal(stored.baselineContextFingerprint, contractedContext);
    });

    assert.equal(
      fileReviewSnapshotFor(shared.first.app, "src/semantic-merge.js")
        .hunks[0].lines[1].baselineContextFingerprint,
      contractedContext,
    );

    const expandedFile = untrustedExpanded.fileElement;
    const expandedTable = expandedFile.querySelector("table");
    const fileToggle = shared.first.dom.window.document.createElement(
      "button",
    );
    fileToggle.setAttribute("aria-label", "Collapse file");
    expandedFile.querySelector(".file-header").append(fileToggle);
    shared.first.app.handleFileVisibilityClick({ target: fileToggle });
    expandedTable.remove();
    await waitFor(() => {
      assert.equal(shared.first.app.controllersByRow.size, 0);
    });
    fileToggle.setAttribute("aria-label", "Expand file");
    shared.first.app.handleFileVisibilityClick({ target: fileToggle });
    expandedFile.append(expandedTable);
    await waitFor(() => {
      const [restoredExpanded] = controllersFor(shared.first.app);
      assert.notEqual(restoredExpanded, untrustedExpanded);
      assert.equal(restoredExpanded.lines[1].marked, true);
      assert.equal(
        restoredExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
      untrustedExpanded = restoredExpanded;
    });

    // A real contracted tab can now make the contracted fingerprint primary.
    // The already-expanded tab must retain the validated equivalence it just
    // received, rather than dropping the review on the second storage event.
    contractedPage = await startExtension(
      semanticMergeableHunkFixture(),
      {},
      { chromeInstance: shared.first.chrome },
    );
    const contractedController = controllersFor(contractedPage.app)[1];
    const contractedLine = contractedController.lines[0];
    assert.equal(contractedLine.marked, true);
    changeCheckbox(contractedPage.dom, contractedController.input, false);
    await waitFor(() => {
      assert.equal(untrustedExpanded.lines[1].marked, false);
      assert.equal(contractedLine.marked, false);
      assert.equal(contractedPage.chrome.snapshot()[lineKey], undefined);
    });
    changeCheckbox(contractedPage.dom, contractedController.input, true);
    await waitFor(() => {
      assert.equal(contractedLine.marked, true);
      assert.equal(untrustedExpanded.lines[1].marked, true);
    });
  } finally {
    if (contractedPage) {
      stopExtensions(contractedPage);
    }
    stopExtensions(shared.first, shared.second);
  }
});

test("adopts a trusted baseline received while an expanded file is hidden", async () => {
  const shared = await startSharedExtensions(
    currentReactOverlappingContextExpansionFixture(),
  );
  let contractedPage = null;
  try {
    replaceCurrentReactOverlappingContextRows(
      shared.first.dom.window.document,
    );
    let hiddenExpanded;
    await waitFor(() => {
      [hiddenExpanded] = controllersFor(shared.first.app);
      assert.equal(shared.first.app.controllersByRow.size, 1);
      assert.equal(hiddenExpanded.lines[1].marked, false);
    });

    const expandedFile = hiddenExpanded.fileElement;
    const expandedTable = expandedFile.querySelector('table[role="grid"]');
    const fileToggle = shared.first.dom.window.document.createElement(
      "button",
    );
    fileToggle.setAttribute("aria-label", "Collapse file");
    expandedFile
      .querySelector(
        '[class*="DiffFileHeader-module__diff-file-header__"]',
      )
      .append(fileToggle);
    shared.first.app.handleFileVisibilityClick({ target: fileToggle });
    expandedTable.remove();
    await waitFor(() => {
      assert.equal(shared.first.app.controllersByRow.size, 0);
    });

    const secondInitial = controllersFor(shared.second.app);
    const contractedContext = secondInitial[1].lines[0].contextFingerprint;
    shared.second.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: secondInitial[2].hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactOverlappingContextRows(
      shared.second.dom.window.document,
    );
    let trustedExpanded;
    await waitFor(() => {
      [trustedExpanded] = controllersFor(shared.second.app);
      assert.equal(shared.second.app.controllersByRow.size, 1);
    });
    trustedExpanded.lines[1].control.click();
    const lineKey = trustedExpanded.lines[1].key;
    await waitFor(() => {
      const stored = shared.first.chrome.snapshot()[lineKey];
      assert.equal(stored.baselineContextFingerprint, contractedContext);
    });

    // Keep the expanded tab hidden while the contracted tab removes and then
    // recreates the mark with the contracted fingerprint as primary.
    contractedPage = await startExtension(
      currentReactOverlappingContextExpansionFixture(),
      {},
      { chromeInstance: shared.first.chrome },
    );
    const contractedController = controllersFor(contractedPage.app)[1];
    changeCheckbox(contractedPage.dom, contractedController.input, false);
    await waitFor(() => {
      assert.equal(contractedPage.chrome.snapshot()[lineKey], undefined);
    });
    changeCheckbox(contractedPage.dom, contractedController.input, true);
    await waitFor(() => {
      const stored = contractedPage.chrome.snapshot()[lineKey];
      assert.equal(stored.contextFingerprint, contractedContext);
      assert.equal(stored.baselineContextFingerprint, undefined);
    });

    fileToggle.setAttribute("aria-label", "Expand file");
    shared.first.app.handleFileVisibilityClick({ target: fileToggle });
    expandedFile.append(expandedTable);
    let restoredExpanded;
    await waitFor(() => {
      [restoredExpanded] = controllersFor(shared.first.app);
      assert.equal(restoredExpanded.lines[1].marked, true);
      assert.equal(
        restoredExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
    });
  } finally {
    if (contractedPage) {
      stopExtensions(contractedPage);
    }
    stopExtensions(shared.first, shared.second);
  }
});

test("keeps a concurrent contracted-tab mark during context expansion", async () => {
  const shared = await startSharedExtensions(
    currentReactOverlappingContextExpansionFixture(),
  );
  const delayedWrite = delayReviewStorageSet(shared.second.app, 1);
  try {
    const [, firstContracted, expansionSource] = controllersFor(
      shared.first.app,
    );
    const [, secondContracted] = controllersFor(shared.second.app);
    const lineKey = firstContracted.lines[0].key;
    const contractedContext =
      firstContracted.lines[0].contextFingerprint;
    const expansionControl = expansionSource.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );

    changeCheckbox(shared.second.dom, secondContracted.input);
    await delayedWrite.started;
    assert.equal(secondContracted.marked, true);
    assert.equal(shared.chrome.snapshot()[lineKey], undefined);

    shared.first.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    const contextRow = shared.first.dom.window.document.createElement("tr");
    contextRow.className = "diff-line-row";
    contextRow.setAttribute("data-line-type", "context");
    contextRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell left-side-diff-cell" data-diff-side="left"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>' +
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>';
    expansionSource.hunkRow.before(contextRow);
    expansionControl.setAttribute(
      "aria-label",
      "Expand file down from line 13",
    );

    await waitFor(() => {
      assert.equal(shared.first.app.refreshRunning, true);
      const expandingController = controllersFor(shared.first.app).find(
        (controller) => controller.lines[0]?.key === lineKey,
      );
      assert.ok(expandingController);
      assert.notEqual(expandingController, firstContracted);
      assert.notEqual(
        expandingController.lines[0].contextFingerprint,
        contractedContext,
      );
    });

    delayedWrite.release();
    await waitFor(() => {
      assert.equal(shared.first.app.refreshRunning, false);
      const current = controllersFor(shared.first.app).find(
        (controller) => controller.lines[0]?.key === lineKey,
      );
      assert.ok(current);
      assert.equal(current.marked, true);
      assert.equal(current.lines[0].marked, true);
      assert.equal(
        shared.chrome.snapshot()[lineKey].contextFingerprint,
        current.lines[0].contextFingerprint,
      );
      assert.equal(
        shared.chrome.snapshot()[lineKey].baselineContextFingerprint,
        contractedContext,
      );
    });
  } finally {
    delayedWrite.release();
    stopExtensions(shared.first, shared.second);
  }
});

test("keeps a pending context expansion across file hiding", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expandAll,
    });
    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    const expandedTable = currentReactMergedExpansionTable(
      dom.window.document,
    );
    fileElement.querySelector('table[role="grid"]').replaceWith(expandedTable);

    // GitHub retains the expanded table state when the file is folded. Hide it
    // before HunkMark finishes the asynchronous migration, then reveal that
    // exact expanded DOM again.
    app.handleFileVisibilityClick({ target: fileToggle });
    expandedTable.remove();
    expandAll.replaceWith(collapseNonDiff);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(expandedTable);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [true, true, false],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a pending directional expansion across file hiding", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second, third] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const fileElement = first.fileElement;
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });

    const expandedTable = currentReactMergedExpansionTable(
      dom.window.document,
    );
    fileElement.querySelector('table[role="grid"]').replaceWith(expandedTable);
    app.handleFileVisibilityClick({ target: fileToggle });
    expandedTable.remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(expandedTable);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [true, true, false],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a pending expansion when React replaces the hidden file region", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  const fixtureDom = new JSDOM(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const previousFileElement = first.fileElement;
    const expandAll = previousFileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expandAll,
    });

    const replacementFileElement = dom.window.document.importNode(
      fixtureDom.window.document.querySelector(
        '[role="region"].Diff-module__diff__overlap',
      ),
      true,
    );
    const replacementExpandAll = replacementFileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const collapseNonDiff = replacementExpandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    replacementExpandAll.replaceWith(collapseNonDiff);
    const expandedTable = currentReactMergedExpansionTable(
      dom.window.document,
    );
    replacementFileElement
      .querySelector('table[role="grid"]')
      .replaceWith(expandedTable);
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    replacementFileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    previousFileElement.replaceWith(replacementFileElement);

    app.handleFileVisibilityClick({ target: fileToggle });
    expandedTable.remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    replacementFileElement.append(expandedTable);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [true, true, false],
      );
    });
  } finally {
    fixtureDom.window.close();
    stopExtensions({ app, dom });
  }
});

test("does not authorize a hidden no-op context expansion", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first] = controllersFor(app);
    const fileElement = first.fileElement;
    const originalTable = fileElement.querySelector('table[role="grid"]');
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expandAll,
    });
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    app.handleFileVisibilityClick({ target: fileToggle });
    originalTable.remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    assert.notEqual(intent.timers.expiry, null);

    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(originalTable);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 3);
    });
    assert.equal(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
      intent,
    );
    assert.notEqual(intent.phase, "observed");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not extend context expansion expiry when a file hide is cancelled", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    const fileElement = first.fileElement;
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });

    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    const originalCreatedAt = intent.createdAt;
    const originalExpiryTimerId = intent.timers.expiry;
    app.handleFileVisibilityClick({ target: fileToggle });
    const expectation = app.fileDiffVisibilityPending.get(fileElement);
    assert.ok(expectation);
    assert.equal(intent.fileHiddenWhilePending, true);
    assert.equal(intent.timers.expiry, originalExpiryTimerId);

    const replacementExpectation = app.expectFileDiffVisibility(
      fileElement,
      false,
    );
    assert.notEqual(replacementExpectation, expectation);
    app.cancelExpectedFileDiffVisibility(fileElement, expectation);
    assert.equal(intent.fileHiddenWhilePending, true);
    assert.equal(intent.timers.expiry, originalExpiryTimerId);

    // Model GitHub rejecting or otherwise failing to apply the collapse before
    // the visibility expectation times out. The rendered hunk rows remain in
    // place, so the original fail-closed lifetime must continue to apply.
    app.cancelExpectedFileDiffVisibility(fileElement, replacementExpectation);

    assert.equal(intent.fileHiddenWhilePending, false);
    assert.equal(intent.createdAt, originalCreatedAt);
    assert.equal(intent.timers.expiry, originalExpiryTimerId);
    assert.equal(
      app.activeHostContextExpansionIntents(
        originalCreatedAt +
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS +
          1,
      ).length,
      0,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not extend context expansion expiry when a file reveal is cancelled", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    const fileElement = first.fileElement;
    const originalTable = fileElement.querySelector('table[role="grid"]');
    const fileToggle = dom.window.document.createElement("button");
    const fileToggleLabel = dom.window.document.createElement("span");
    fileToggleLabel.id = "react-noop-file-toggle-label";
    fileToggleLabel.textContent = "Collapse file";
    fileToggle.setAttribute("aria-labelledby", fileToggleLabel.id);
    fileElement
      .querySelector('[class*="DiffFileHeader-module__diff-file-header__"]')
      .append(fileToggle, fileToggleLabel);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });

    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    const originalCreatedAt = intent.createdAt;
    const originalExpiryTimerId = intent.timers.expiry;
    app.handleFileVisibilityClick({ target: fileToggle });
    originalTable.remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    assert.equal(intent.fileHiddenWhilePending, true);
    assert.equal(intent.timers.expiry, originalExpiryTimerId);

    // GitHub can ignore the first Expand file click while leaving the file
    // folded. Cancelling that failed reveal must retain hidden ownership for a
    // later retry without extending the original wall-clock deadline.
    fileToggleLabel.textContent = "Expand file";
    app.handleFileVisibilityClick({ target: fileToggle });
    const revealExpectation =
      app.fileDiffVisibilityPending.get(fileElement);
    assert.ok(revealExpectation);
    app.cancelExpectedFileDiffVisibility(fileElement, revealExpectation);

    assert.equal(intent.fileHiddenWhilePending, true);
    assert.equal(intent.createdAt, originalCreatedAt);
    assert.equal(intent.timers.expiry, originalExpiryTimerId);

    app.handleFileVisibilityClick({ target: fileToggle });
    if (!originalTable.isConnected) {
      fileElement.append(originalTable);
    }
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 3);
    });
    assert.equal(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
      intent,
    );
    assert.notEqual(intent.phase, "observed");
    assert.equal(
      app.activeHostContextExpansionIntents(
        originalCreatedAt +
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS +
          1,
      ).length,
      0,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("expires a hidden context expansion when a reveal stalls", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    const fileElement = first.fileElement;
    const originalTable = fileElement.querySelector('table[role="grid"]');
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });

    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    app.handleFileVisibilityClick({ target: fileToggle });
    originalTable.remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    // Model GitHub accepting the click event but leaving the file folded. A
    // failed reveal must not turn the bounded activation into an indefinite
    // authorization for a later, unrelated render.
    const productionConstants = app.constants;
    app.constants = {
      ...productionConstants,
      FILE_DIFF_VISIBILITY_EXPECTATION_TIMEOUT_MS: 20,
      HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS: 20,
    };
    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    await new Promise((resolve) => dom.window.setTimeout(resolve, 80));

    assert.equal(contextExpansionIntentFor(app, "src/react-overlap.js"), null);
    app.constants = productionConstants;
  } finally {
    stopExtensions({ app, dom });
  }
});

test("fails closed when a hidden pending expansion changes lines", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expandAll,
    });

    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    const changedTable = currentReactMergedExpansionTable(
      dom.window.document,
      { secondLine: "+changed" },
    );
    fileElement.querySelector('table[role="grid"]').replaceWith(changedTable);
    app.handleFileVisibilityClick({ target: fileToggle });
    changedTable.remove();
    expandAll.replaceWith(collapseNonDiff);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(changedTable);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("serializes a hidden pending expansion with review persistence", async (t) => {
  for (const scenario of [
    {
      expectedMarked: true,
      initiallyMarked: false,
      name: "preserves a committed pending mark",
      writeFails: false,
    },
    {
      expectedMarked: false,
      initiallyMarked: false,
      name: "does not revive a failed pending mark",
      writeFails: true,
    },
    {
      expectedMarked: false,
      initiallyMarked: true,
      name: "commits a pending clear",
      writeFails: false,
    },
    {
      expectedMarked: true,
      initiallyMarked: true,
      name: "retains a failed pending clear",
      writeFails: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { app, chrome, dom } = await startLockedExtension(
        currentReactOverlappingContextExpansionFixture(),
      );
      let delayedMutation;
      try {
        const [first] = controllersFor(app);
        const fileElement = first.fileElement;
        const expandAll = fileElement.querySelector(
          '[aria-label="Expand all lines: src/react-overlap.js"]',
        );
        const fileToggle = dom.window.document.createElement("button");
        fileToggle.setAttribute("aria-label", "Collapse file");
        fileElement.querySelector(
          '[class*="DiffFileHeader-module__diff-file-header__"]',
        ).append(fileToggle);
        const lineKey = first.lines[0].key;
        if (scenario.initiallyMarked) {
          changeCheckbox(dom, first.input);
          await waitFor(() => {
            assert.ok(chrome.snapshot()[lineKey]);
          });
        }
        const warnings = captureWarnings(dom);

        const failureMessage = scenario.writeFails
          ? "pending review write failed"
          : null;
        delayedMutation = scenario.initiallyMarked
          ? delayReviewStorageRemove(app, 1, { failureMessage })
          : delayReviewStorageSet(app, 1, { failureMessage });
        changeCheckbox(dom, first.input, !scenario.initiallyMarked);
        await delayedMutation.started;
        assert.equal(first.lines[0].marked, !scenario.initiallyMarked);
        assert.equal(
          Boolean(chrome.snapshot()[lineKey]),
          scenario.initiallyMarked,
        );

        app.handleHostContextExpansionClick({
          isTrusted: true,
          target: expandAll,
        });
        const collapseNonDiff = expandAll.cloneNode(true);
        collapseNonDiff.className = "prc-Button-ButtonBase";
        collapseNonDiff.setAttribute(
          "aria-label",
          "Collapse non-diff lines: src/react-overlap.js",
        );
        const expandedTable = currentReactMergedExpansionTable(
          dom.window.document,
        );
        fileElement
          .querySelector('table[role="grid"]')
          .replaceWith(expandedTable);
        app.handleFileVisibilityClick({ target: fileToggle });
        expandedTable.remove();
        expandAll.replaceWith(collapseNonDiff);
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 0);
        });

        fileToggle.setAttribute("aria-label", "Expand file");
        app.handleFileVisibilityClick({ target: fileToggle });
        fileElement.append(expandedTable);
        await waitFor(() => {
          assert.equal(app.refreshRunning, true);
        });

        delayedMutation.release();
        await waitFor(() => {
          assert.equal(app.refreshRunning, false);
          assert.equal(warnings.length, Number(scenario.writeFails));
          assert.equal(
            controllersFor(app)[0].lines[0].marked,
            scenario.expectedMarked,
          );
          assert.equal(
            Boolean(chrome.snapshot()[lineKey]),
            scenario.expectedMarked,
          );
        });
      } finally {
        delayedMutation?.release();
        stopExtensions({ app, dom });
      }
    });
  }
});

test("restores a validated expanded baseline after the file is hidden", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const lineKey = first.lines[0].key;
    const contractedContext = first.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactOverlappingContextRows(dom.window.document);

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.equal(expanded.lines[0].marked, true);
      assert.equal(
        expanded.lines[0].hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });

    // Another contracted tab can make the contracted fingerprint primary.
    // The visible expanded controller remains valid through its attached
    // baseline, and GitHub retains that expanded DOM across file hiding.
    await chrome.api.storage.local.set({
      [lineKey]: {
        contextFingerprint: contractedContext,
        viewedAt: Date.now(),
      },
    });
    await waitFor(() => {
      assert.equal(app.lineReviewContextByKey.get(lineKey), contractedContext);
      assert.equal(app.lineReviewBaselineContextByKey.has(lineKey), false);
      assert.equal(expanded.lines[0].marked, true);
    });

    const expandedSnapshot = fileReviewSnapshotFor(
      app,
      "src/react-overlap.js",
    );
    assert.equal(
      expandedSnapshot.hunks[0].lines[0].contextFingerprint,
      expanded.lines[0].contextFingerprint,
    );
    assert.equal(
      expandedSnapshot.hunks[0].lines[0].baselineContextFingerprint,
      contractedContext,
    );

    const fileElement = expanded.fileElement;
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    const restoredExpandedTable = currentReactMergedExpansionTable(
      dom.window.document,
    );
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(restoredExpandedTable);

    await waitFor(() => {
      const [restored] = controllersFor(app);
      assert.notEqual(restored, expanded);
      assert.equal(
        restored.lines[0].contextFingerprint,
        expanded.lines[0].contextFingerprint,
      );
      assert.equal(restored.lines[0].marked, true);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not restore a cached expanded baseline into changed hidden context", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const lineKey = first.lines[0].key;
    const contractedContext = first.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactOverlappingContextRows(dom.window.document);

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(expanded.lines[0].marked, true);
      assert.equal(
        expanded.lines[0].hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
    await chrome.api.storage.local.set({
      [lineKey]: {
        contextFingerprint: contractedContext,
        viewedAt: Date.now(),
      },
    });
    await waitFor(() => {
      assert.equal(app.lineReviewContextByKey.get(lineKey), contractedContext);
      assert.equal(app.lineReviewBaselineContextByKey.has(lineKey), false);
      assert.equal(expanded.lines[0].marked, true);
    });

    const changedScenarioSnapshot = fileReviewSnapshotFor(
      app,
      "src/react-overlap.js",
    );
    assert.equal(
      changedScenarioSnapshot.hunks[0].lines[0].contextFingerprint,
      expanded.lines[0].contextFingerprint,
    );
    assert.equal(
      changedScenarioSnapshot.hunks[0].lines[0]
        .baselineContextFingerprint,
      contractedContext,
    );

    const fileElement = expanded.fileElement;
    const changedExpandedTable = currentReactMergedExpansionTable(
      dom.window.document,
    );
    changedExpandedTable.querySelector(".diff-hunk-cell").textContent =
      "@@ -1,20 +1,20 @@ hiddenReplacement()";
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    fileElement.append(changedExpandedTable);

    await waitFor(() => {
      const [restored] = controllersFor(app);
      assert.notEqual(restored, expanded);
      assert.notEqual(
        restored.lines[0].contextFingerprint,
        expanded.lines[0].contextFingerprint,
      );
      assert.notEqual(
        restored.lines[0].contextFingerprint,
        contractedContext,
      );
      assert.equal(
        restored.lines[0].hostContextExpansionBaselineContextFingerprint,
        undefined,
      );
      assert.equal(restored.lines[0].marked, false);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not restore a cached expanded baseline after hidden context-only replacement", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const lineKey = first.lines[0].key;
    const contractedContext = first.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactContextEvidenceRows(dom.window.document);
    appendCurrentReactTrailingContextEvidence(
      dom.window.document,
      "far trailing context",
    );

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(expanded.lines[0].marked, true);
      assert.equal(
        expanded.lines[0].hostContextExpansionBaselineContextFingerprint,
        contractedContext,
      );
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
    const expandedContext = expanded.lines[0].contextFingerprint;
    await chrome.api.storage.local.set({
      [lineKey]: {
        contextFingerprint: contractedContext,
        viewedAt: Date.now(),
      },
    });
    await waitFor(() => {
      assert.equal(app.lineReviewContextByKey.get(lineKey), contractedContext);
      assert.equal(expanded.lines[0].marked, true);
    });

    const fileElement = expanded.fileElement;
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    const changedExpandedTable = currentReactMergedContextEvidenceTable(
      dom.window.document,
      { trailingContext: "replaced far trailing context" },
    );
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(changedExpandedTable);

    await waitFor(() => {
      const [restored] = controllersFor(app);
      assert.notEqual(restored, expanded);
      assert.equal(restored.lines[0].contextFingerprint, expandedContext);
      assert.equal(
        restored.lines[0].hostContextExpansionBaselineContextFingerprint,
        undefined,
      );
      assert.equal(restored.lines[0].marked, false);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves lines first reviewed after expansion when GitHub reloads contracted context", async (t) => {
  const scenarios = [
    {
      expectedMarks: [true, true, true],
      mark: (dom, merged) => changeCheckbox(dom, merged.input),
      name: "hunk review",
    },
    {
      expectedMarks: [false, true, false],
      mark: (_dom, merged) => merged.lines[1].control.click(),
      name: "line review",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const firstPage = await startExtension(semanticMergeableHunkFixture());
      let secondPage = null;
      try {
        const initialControllers = controllersFor(firstPage.app);
        const originalContextByLineKey = new Map(
          initialControllers.flatMap((controller) =>
            controller.lines.map((line) => [line.key, line.contextFingerprint]),
          ),
        );
        const third = initialControllers[2];
        firstPage.app.handleHostContextExpansionClick({
          isTrusted: true,
          target: third.hunkRow.querySelector(".js-expand"),
        });
        replaceSemanticMergeFixtureRows(firstPage.dom.window.document);

        let merged;
        await waitFor(() => {
          [merged] = controllersFor(firstPage.app);
          assert.deepEqual(
            Array.from(merged.lines, (line) => line.marked),
            [false, false, false],
          );
        });
        scenario.mark(firstPage.dom, merged);
        await waitFor(() => {
          assert.deepEqual(
            Array.from(merged.lines, (line) => line.marked),
            scenario.expectedMarks,
          );
          merged.lines.forEach((line, index) => {
            const stored = firstPage.chrome.snapshot()[line.key];
            if (scenario.expectedMarks[index]) {
              assert.equal(stored.contextFingerprint, line.contextFingerprint);
              assert.equal(
                stored.baselineContextFingerprint,
                originalContextByLineKey.get(line.key),
              );
            } else {
              assert.equal(stored, undefined);
            }
          });
        });

        firstPage.app.stop();
        firstPage.dom.window.close();
        secondPage = await startExtension(semanticMergeableHunkFixture(), {}, {
          chromeInstance: firstPage.chrome,
        });

        assert.deepEqual(
          controllersFor(secondPage.app).map((controller) => controller.marked),
          scenario.expectedMarks,
        );
      } finally {
        if (secondPage) {
          stopExtensions(secondPage);
        } else if (!firstPage.app.stopped) {
          stopExtensions(firstPage);
        }
      }
    });
  }
});

test("does not reuse a stale baseline after an unprompted context replacement", async () => {
  const firstPage = await startExtension(semanticMergeableHunkFixture());
  let secondPage = null;
  try {
    const initialControllers = controllersFor(firstPage.app);
    const originalSecondContext = initialControllers[1].lines[0].contextFingerprint;
    const third = initialControllers[2];
    firstPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(firstPage.dom.window.document);

    let firstExpanded;
    await waitFor(() => {
      [firstExpanded] = controllersFor(firstPage.app);
      assert.equal(firstExpanded.lines.length, 3);
      assert.notEqual(
        firstExpanded.lines[1].contextFingerprint,
        originalSecondContext,
      );
    });
    firstExpanded.lines[1].control.click();
    await waitFor(() => {
      const stored = firstPage.chrome.snapshot()[firstExpanded.lines[1].key];
      assert.equal(
        stored.contextFingerprint,
        firstExpanded.lines[1].contextFingerprint,
      );
      assert.equal(stored.baselineContextFingerprint, originalSecondContext);
      assert.equal(firstPage.app.hostContextExpansionIntents.size, 0);
    });

    const firstExpandedContext = firstExpanded.lines[1].contextFingerprint;
    const hunkCell = firstPage.dom.window.document.querySelector(
      ".blob-code-hunk",
    );
    const nextExpansionControl = firstPage.dom.window.document.createElement(
      "button",
    );
    nextExpansionControl.className = "js-expand";
    nextExpansionControl.setAttribute("aria-label", "Expand up");
    hunkCell.prepend(nextExpansionControl);
    firstPage.dom.window.document.querySelectorAll(
      ".blob-code-context",
    )[1].textContent = "unprompted replacement context";

    let unpromptedController;
    await waitFor(() => {
      [unpromptedController] = controllersFor(firstPage.app);
      assert.notEqual(unpromptedController, firstExpanded);
      assert.notEqual(
        unpromptedController.lines[1].contextFingerprint,
        firstExpandedContext,
      );
      assert.equal(unpromptedController.lines[1].marked, false);
    });
    const currentContractedContext =
      unpromptedController.lines[1].contextFingerprint;

    firstPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: nextExpansionControl,
    });
    const addedContext = firstPage.dom.window.document.createElement("tr");
    addedContext.innerHTML =
      '<td class="blob-num">0</td><td class="blob-code-context">new trusted expansion context</td>';
    unpromptedController.lines[1].row.before(addedContext);
    nextExpansionControl.remove();

    let secondExpanded;
    await waitFor(() => {
      [secondExpanded] = controllersFor(firstPage.app);
      assert.notEqual(secondExpanded, unpromptedController);
      assert.equal(
        secondExpanded.lines[1]
          .hostContextExpansionBaselineContextFingerprint,
        currentContractedContext,
      );
    });
    secondExpanded.lines[1].control.click();
    await waitFor(() => {
      const stored = firstPage.chrome.snapshot()[secondExpanded.lines[1].key];
      assert.equal(
        stored.contextFingerprint,
        secondExpanded.lines[1].contextFingerprint,
      );
      assert.equal(
        stored.baselineContextFingerprint,
        currentContractedContext,
      );
    });

    firstPage.app.stop();
    firstPage.dom.window.close();
    secondPage = await startExtension(semanticMergeableHunkFixture(), {}, {
      chromeInstance: firstPage.chrome,
    });
    assert.equal(controllersFor(secondPage.app)[1].marked, false);
  } finally {
    if (secondPage) {
      stopExtensions(secondPage);
    } else if (!firstPage.app.stopped) {
      stopExtensions(firstPage);
    }
  }
});
