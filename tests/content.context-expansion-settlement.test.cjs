const {
  test,
  assert,
  JSDOM,
  createDeferred,
  delayReviewStorageSet,
  delayReviewStorageRemove,
  controllersFor,
  contextExpansionIntentFor,
  stopExtensions,
  startLockedExtension,
  captureWarnings,
  changeCheckbox,
  waitFor,
  startExtension,
  semanticMergeableHunkFixture,
  replaceSemanticMergeFixtureRows,
  currentReactContextExpansionFixture,
  currentReactContextEvidenceFixture,
  currentReactOverlappingContextExpansionFixture,
  replaceCurrentReactOverlappingContextRows,
  replaceCurrentReactDirectionalRegion,
} = require("./content-test-support.cjs");

function controllerFor(app, filePath) {
  return controllersFor(app).find((controller) => controller.filePath === filePath);
}

function assertExpandedReview(current, originalLine, marked = true) {
  const line = current.lines[0];
  assert.notEqual(line.contextFingerprint, originalLine.contextFingerprint);
  assert.equal(line.marked, marked);
  assert.equal(current.input.disabled, false);
  return line;
}

function trailingNativeExpansionFixture() {
  return currentReactContextExpansionFixture().replace(
    "</tbody></table>",
    `<tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">
      <button class="ExpandableHunkHeaderDiffLine-module__expand-button-line__one"
        aria-label="Expand file down from line 10">Expand down</button>
    </td></tr></tbody></table>`,
  );
}

function appendNativeFile(document, suffix, id) {
  const region = document.querySelectorAll('[role="region"]')[1].cloneNode(true);
  if (id) region.id = id;
  region.innerHTML = region.innerHTML
    .replaceAll("react-two", `react-${suffix}`)
    .replaceAll("diff-two", `diff-${suffix}`)
    .replaceAll("+two", `+${suffix}`);
  document.body.append(region);
}

function nativeContextRow(document, text) {
  const row = document.createElement("tr");
  row.className = "diff-line-row";
  row.dataset.lineType = "context";
  row.innerHTML = '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
    `<code class="diff-text" data-diff-side="right">${text}</code></td>`;
  return row;
}

async function reviewFirstWithBackgroundLoader(app, chrome, dom) {
  app.constants = {
    ...app.constants,
    DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
    DIFF_LOAD_REFRESH_SETTLE_MS: 50,
  };
  const first = controllerFor(app, "src/react-one.js");
  const second = controllerFor(app, "src/react-two.js");
  const originalLine = first.lines[0];
  changeCheckbox(dom, first.input);
  await waitFor(() => {
    assert.equal(originalLine.marked, true);
    assert.equal(first.collapsed, true);
    assert.equal(first.input.disabled, false);
    assert.ok(chrome.snapshot()[originalLine.key]);
  });
  const loader = dom.window.document.createElement("tr");
  loader.dataset.component = "loadingSpinner";
  loader.innerHTML = '<td role="progressbar">Loading another file</td>';
  second.fileElement.querySelector("tbody").append(loader);
  await waitFor(() => assert.equal(second.input.disabled, true));
  assert.equal(first.input.disabled, false);
  return { first, second, originalLine, loader };
}

function expandNativeContext(dom, first, control, changesContent = false) {
  if (changesContent) {
    first.lines[0].element.querySelector("code").textContent = "+replacement";
  }
  const headerText = Array.from(first.hunkCell.childNodes).find(
    (node) => node.nodeType === 3 && node.nodeValue.includes("@@"),
  );
  headerText.nodeValue = "@@ -10,3 +10,3 @@";
  const controlRow = control.closest("tr");
  for (let index = 0; index < 2; index += 1) {
    controlRow.before(nativeContextRow(dom.window.document, `expanded context ${index}`));
  }
  controlRow.remove();
}

test("does not authorize context migration from a rejected activation", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  try {
    const target = controllersFor(app)[2].hunkRow.querySelector(".js-expand");
    [
      { isTrusted: false },
      { defaultPrevented: true },
      { button: 1 },
    ].forEach((activation) => {
      app.handleHostContextExpansionClick({
        isTrusted: true,
        target,
        ...activation,
      });
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

for (const scenario of [
  {
    name: "preserves partial reviews through context expansion and background loading",
    pauseDuringStorage: true,
  },
  {
    name: "preserves partial reviews when a staged expansion has another hunk in its file",
    stagedSource: true,
  },
  {
    name: "does not retain reviews when captured context changes during expansion",
    changesContext: true,
  },
  {
    name: "keeps ready files usable when expansion rejects changed lines",
    changesContent: true,
    pauseDuringStorage: true,
  },
  {
    name: "keeps ready files usable when a pending expansion expires",
    expiresIntent: true,
  },
]) {
  test(scenario.name, async () => {
    const fixture = new JSDOM(trailingNativeExpansionFixture());
    const fixtureDocument = fixture.window.document;
    const firstRow = fixtureDocument.querySelector(
      '[data-line-type="addition"]',
    );
    const unreviewedRow = firstRow.cloneNode(true);
    unreviewedRow.querySelector("[data-line-anchor]").dataset.lineAnchor =
      "diff-oneR11";
    unreviewedRow.querySelector("code").textContent = "+one-unreviewed";
    firstRow.after(unreviewedRow);
    firstRow.before(nativeContextRow(fixtureDocument, "original context"));
    if (scenario.stagedSource) {
      firstRow.parentElement.insertAdjacentHTML("beforeend", `
        <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -40 +40 @@</td></tr>
        <tr class="diff-line-row" data-line-type="addition">
          <td role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-oneR40">
            <code class="addition" data-diff-side="right">+later-hunk</code>
          </td>
        </tr>`);
    }
    appendNativeFile(fixtureDocument, "three");
    const html = fixture.serialize()
      .replace("@@ -10 +10 @@", "@@ -9,2 +9,3 @@")
      .replaceAll(
        "Expand file down from line 10",
        "Expand file down from line 11",
      );
    fixture.window.close();
    const { app, chrome, dom } = await startExtension(html);
    const resume = createDeferred();
    try {
      const { first, second, originalLine, loader } =
        await reviewFirstWithBackgroundLoader(app, chrome, dom);
      const ready = controllerFor(app, "src/react-three.js");
      if (scenario.expiresIntent) {
        ready.fileElement.getBoundingClientRect = () => ({
          top: 5_000,
          bottom: 5_200,
        });
      }
      first.lines[1].control.click();
      await waitFor(() => {
        assert.deepEqual(
          Array.from(first.lines, (line) => line.marked),
          [true, false],
        );
        assert.equal(first.collapsed, false);
        assert.equal(first.input.disabled, false);
        assert.notEqual(
          chrome.snapshot()[first.sharedCompletionKey]?.viewed,
          true,
        );
      });
      app.constants = {
        ...app.constants,
        LARGE_REFRESH_INTERACTION_YIELD_THRESHOLD: 1,
      };
      let yields = 0;
      let storagePaused = false;
      // Interrupt the host update either before discovery or during restoration.
      const interruptionYield = scenario.expiresIntent ? 1 : 2;
      const yieldForRefresh = app.yieldForLargeRefreshInteraction.bind(app);
      app.yieldForLargeRefreshInteraction = async (...args) => {
        yields += 1;
        if (yields === interruptionYield && !scenario.pauseDuringStorage) {
          await resume.promise;
        }
        await yieldForRefresh(...args);
      };
      const getLocalStorage = app.getLocalStorage.bind(app);
      app.getLocalStorage = async (keys) => {
        const stored = await getLocalStorage(keys);
        if (
          scenario.pauseDuringStorage &&
          !storagePaused &&
          yields === 2 &&
          keys.includes(
            app.controllersByRow.get(first.hunkRow)?.lines[0]?.key,
          )
        ) {
          storagePaused = true;
          await resume.promise;
        }
        return stored;
      };
      const control = first.fileElement.querySelector(
        '[aria-label="Expand file down from line 11"]',
      );
      const controlRow = control.closest("tr");
      const controlParent = controlRow.parentElement;
      const controlNextSibling = controlRow.nextSibling;
      app.handleHostContextExpansionClick({ isTrusted: true, target: control });
      const intent = contextExpansionIntentFor(app, first.filePath);
      assert.ok(intent);
      expandNativeContext(dom, first, control, scenario.changesContent);
      if (scenario.stagedSource) {
        controlParent.insertBefore(controlRow, controlNextSibling);
      }
      const headerText = Array.from(first.hunkCell.childNodes).find(
        (node) => node.nodeType === 3 && node.nodeValue.includes("@@"),
      );
      headerText.nodeValue = "@@ -9,4 +9,5 @@";
      await waitFor(() => {
        assert.equal(yields, interruptionYield);
        if (scenario.pauseDuringStorage) {
          assert.equal(storagePaused, true);
        }
      });
      assert.equal(controllerFor(app, first.filePath).input.disabled, true);
      const generation = app.diffMutationGeneration;
      const replacementLoader = loader.cloneNode(true);
      loader.replaceWith(replacementLoader);
      if (scenario.changesContext) {
        first.fileElement.querySelector(
          '[data-line-type="context"] code',
        ).textContent = "replaced original context";
      }
      if (scenario.expiresIntent) {
        intent.createdAt -=
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS + 1;
      }
      await waitFor(() => assert.ok(app.diffMutationGeneration > generation));
      resume.resolve();
      if (scenario.stagedSource) {
        await waitFor(() => assert.equal(app.refreshRunning, false));
        assert.equal(
          chrome.snapshot()[originalLine.key].contextFingerprint,
          originalLine.contextFingerprint,
        );
        controlRow.remove();
      }
      const preservesReviews = !(
        scenario.changesContent ||
        scenario.changesContext ||
        scenario.expiresIntent
      );
      await waitFor(() => {
        for (const filePath of [first.filePath, ready.filePath]) {
          const current = controllerFor(app, filePath);
          assert.equal(current.input.disabled, false);
          assert.equal(current.collapseButton.disabled, false);
          current.lines.forEach((line) => assert.equal(line.control.disabled, false));
        }
        assert.deepEqual(
          Array.from(controllerFor(app, first.filePath).lines, (line) => line.marked),
          [preservesReviews, false],
        );
      });
      assert.equal(replacementLoader.isConnected, true);
      assert.equal(controllerFor(app, second.filePath).input.disabled, true);
      replacementLoader.remove();
      await waitFor(() => {
        assert.equal(app.refreshRunning, false);
        assert.equal(app.refreshQueued, false);
        const current = controllerFor(app, first.filePath);
        assert.ok(current);
        assert.deepEqual(
          Array.from(current.lines, (line) => line.marked),
          [preservesReviews, false],
        );
        const line = assertExpandedReview(current, originalLine, preservesReviews);
        assert.equal(current.collapsed, false);
        if (preservesReviews) {
          assert.equal(line.key, originalLine.key);
        }
        assert.equal(
          chrome.snapshot()[originalLine.key].contextFingerprint,
          (preservesReviews ? line : originalLine).contextFingerprint,
        );
        if (scenario.changesContent) {
          assert.equal(chrome.snapshot()[line.key], undefined);
        }
        assert.equal(controllerFor(app, second.filePath).input.disabled, false);
      });
    } finally {
      resume.resolve();
      stopExtensions({ app, dom });
    }
  });
}

test("keeps each file usable only when ready through expansion hide and reveal", async () => {
  const fixture = new JSDOM(trailingNativeExpansionFixture());
  for (const suffix of ["three", "four"]) {
    appendNativeFile(fixture.window.document, suffix, `diff-${suffix}`);
  }
  const html = fixture.serialize();
  fixture.window.close();
  const { app, chrome, dom } = await startExtension(html);
  try {
    const { first, second, originalLine, loader } =
      await reviewFirstWithBackgroundLoader(app, chrome, dom);
    const quiet = controllerFor(app, "src/react-three.js");
    const ready = controllerFor(app, "src/react-four.js");
    app.constants = {
      ...app.constants,
      DIFF_LOAD_FILE_HYDRATION_OFFSCREEN_DELAY_MS: 5_000,
    };
    [quiet, ready].forEach((controller) => {
      controller.fileElement.getBoundingClientRect = () => ({
        top: 5_000,
        bottom: 5_200,
      });
    });
    second.fileElement.id = "diff-aria-background";
    second.fileElement.setAttribute("aria-label", `Loading ${second.filePath}`);
    loader.remove();
    const quietLoader = loader.cloneNode(true);
    quiet.fileElement.querySelector("tbody").append(quietLoader);
    await waitFor(() => assert.equal(quiet.input.disabled, true));
    quietLoader.remove();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const assertOtherFilesGuarded = () => {
      for (const [filePath, disabled] of [
        [quiet.filePath, true],
        [second.filePath, true],
        [ready.filePath, false],
      ]) {
        const current = controllerFor(app, filePath);
        assert.equal(current.input.disabled, disabled, filePath);
        assert.equal(current.collapseButton.disabled, disabled, filePath);
        current.lines.forEach((line) =>
          assert.equal(line.control.disabled, disabled, filePath),
        );
      }
    };
    const control = first.fileElement.querySelector(
      '[aria-label="Expand file down from line 10"]',
    );
    app.handleHostContextExpansionClick({ isTrusted: true, target: control });
    const intent = contextExpansionIntentFor(app, first.filePath);
    const table = first.hunkRow.closest("table");
    const tableParent = table.parentElement;
    app.expectFileDiffVisibility(first.fileElement, false);
    table.remove();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(intent.fileHiddenWhilePending, true);
      assertOtherFilesGuarded();
    });
    app.expectFileDiffVisibility(first.fileElement, true);
    tableParent.append(table);
    expandNativeContext(dom, first, control);

    await waitFor(() => {
      const current = controllerFor(app, first.filePath);
      assertExpandedReview(current, originalLine);
      assert.equal(current.collapsed, false);
      assertOtherFilesGuarded();
    });

    second.fileElement.setAttribute("aria-label", `Diff file ${second.filePath}`);
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(
        controllersFor(app).every((controller) => !controller.input.disabled),
        true,
      );
      const current = controllerFor(app, first.filePath);
      assert.equal(current.lines[0].marked, true);
      assert.equal(
        chrome.snapshot()[originalLine.key].contextFingerprint,
        current.lines[0].contextFingerprint,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not authorize another hunk from a pending expansion click", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    const intent = contextExpansionIntentFor(app);
    assert.ok(intent);

    const unrelatedContext = dom.window.document.createElement("tr");
    unrelatedContext.innerHTML =
      '<td class="blob-num">0</td><td class="blob-code-context">unrelated rerender</td>';
    first.lines[0].row.before(unrelatedContext);

    await waitFor(() => {
      const currentFirst = controllersFor(app)[0];
      assert.notEqual(currentFirst, first);
      assert.equal(currentFirst.marked, false);
      assert.equal(currentFirst.lines[0].marked, false);
    });
    assert.notEqual(intent.phase, "observed");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a reused unrelated hunk collapsed while an expansion is pending", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.equal(first.collapsed, true);
    });
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    const unrelatedContext = dom.window.document.createElement("tr");
    unrelatedContext.className = "diff-line-row";
    unrelatedContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="diff-text" data-diff-side="right">unrelated pending context</code></td>';
    first.groupRows
      .find((row) => row.textContent.trim() === "after first")
      .after(unrelatedContext);

    await waitFor(() => {
      const currentFirst = controllersFor(app)[0];
      assert.equal(currentFirst, first);
      assert.equal(currentFirst.collapsed, true);
      assert.equal(
        unrelatedContext.classList.contains("hunkmark-collapsed"),
        true,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not share review evidence with a same-header changed sequence", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const intent = {
      affectedReviewKeys: new Set(["target"]),
      phase: "observed",
      source: { expandsWholeFile: false },
    };
    const assessment = app.hostContextExpansionAssessment(
      {
        groupRows: [],
        headerText: "@@ -1 +1 @@ same()",
        key: "current",
        lines: [{ key: "new" }],
      },
      [
        {
          groupRows: [],
          headerText: "@@ -1 +1 @@ same()",
          key: "previous",
          lines: [{ key: "old" }],
        },
      ],
      [intent],
      new Set(),
    );
    assert.deepEqual(assessment.reviewIntents, []);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a clicked hunk fail-closed until its source control transitions", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
    const third = controllersFor(app)[2];
    changeCheckbox(dom, third.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[third.lines[0].key]);
    });

    const sourceControl = third.hunkRow.querySelector(".js-expand");
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: sourceControl,
    });
    const intent = contextExpansionIntentFor(app);
    assert.ok(intent);

    const unrelatedContext = dom.window.document.createElement("tr");
    unrelatedContext.innerHTML =
      '<td class="blob-num">18</td><td class="blob-code-context">unrelated same-hunk rebuild</td>';
    third.lines[0].row.before(unrelatedContext);

    await waitFor(() => {
      const currentThird = controllersFor(app).find(
        (controller) => controller.lines[0].text === "+third",
      );
      assert.notEqual(currentThird, third);
      assert.equal(sourceControl.isConnected, true);
      assert.equal(currentThird.lines[0].marked, false);
    });
    assert.notEqual(intent.phase, "observed");

    sourceControl.remove();
    await waitFor(() => {
      const currentThird = controllersFor(app).find(
        (controller) => controller.lines[0].text === "+third",
      );
      assert.equal(currentThird.lines[0].marked, true);
      assert.equal(currentThird.collapsed, false);
      assert.equal(
        chrome.snapshot()[currentThird.lines[0].key].contextFingerprint,
        currentThird.lines[0].contextFingerprint,
      );
    });
    assert.equal(intent.phase, "observed");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("persists a baseline for a line reviewed during staged React expansion", async () => {
  const firstPage = await startLockedExtension(
    currentReactContextExpansionFixture(),
  );
  let reloadedPage = null;
  let delayedMutation = null;
  try {
    const initial = controllersFor(firstPage.app).find(
      (controller) => controller.filePath === "src/react-one.js",
    );
    const contractedContext = initial.lines[0].contextFingerprint;
    const lineKey = initial.lines[0].key;
    const expansionControl = initial.hunkRow.querySelector(
      '[aria-label="Expand file from line 2 to line 9"]',
    );

    firstPage.app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    const intent = contextExpansionIntentFor(
      firstPage.app,
      "src/react-one.js",
    );
    assert.ok(intent);

    const stagedContext = firstPage.dom.window.document.createElement("tr");
    stagedContext.className = "diff-line-row";
    stagedContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right"><code class="diff-text">staged context</code></td>';
    initial.lines[0].row.before(stagedContext);

    let staged;
    await waitFor(() => {
      staged = controllersFor(firstPage.app).find(
        (controller) => controller.filePath === "src/react-one.js",
      );
      assert.notEqual(staged, initial);
      assert.notEqual(staged.lines[0].contextFingerprint, contractedContext);
      assert.equal(staged.lines[0].marked, false);
      assert.notEqual(intent.phase, "observed");
      assert.equal(expansionControl.isConnected, true);
    });

    delayedMutation = delayReviewStorageSet(firstPage.app, 1);
    staged.lines[0].control.click();
    await delayedMutation.started;
    assert.equal(staged.lines[0].marked, true);
    assert.equal(firstPage.chrome.snapshot()[lineKey], undefined);

    expansionControl.remove();
    await waitFor(() => {
      assert.equal(firstPage.app.refreshRunning, true);
    });
    delayedMutation.release();
    await waitFor(() => {
      const current = controllersFor(firstPage.app).find(
        (controller) => controller.filePath === "src/react-one.js",
      );
      const stored = firstPage.chrome.snapshot()[lineKey];
      assert.equal(intent.phase, "observed");
      assert.equal(current.lines[0].marked, true);
      assert.equal(stored.contextFingerprint, current.lines[0].contextFingerprint);
      assert.equal(stored.baselineContextFingerprint, contractedContext);
    });

    firstPage.app.stop();
    firstPage.dom.window.close();
    reloadedPage = await startExtension(
      currentReactContextExpansionFixture(),
      {},
      { chromeInstance: firstPage.chrome },
    );
    const reloaded = controllersFor(reloadedPage.app).find(
      (controller) => controller.filePath === "src/react-one.js",
    );
    assert.equal(reloaded.lines[0].contextFingerprint, contractedContext);
    assert.equal(reloaded.lines[0].marked, true);
  } finally {
    delayedMutation?.release();
    if (reloadedPage) {
      stopExtensions(reloadedPage);
    } else if (!firstPage.app.stopped) {
      stopExtensions(firstPage);
    }
  }
});

test("preserves context expansion reviews after an earlier hunk rebuild", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
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

    const replacement = first.hunkCell.cloneNode(false);
    replacement.textContent = "@@ -1 +1 @@ function first() {";
    first.hunkCell.replaceWith(replacement);
    await waitFor(() => {
      const rebuilt = controllersFor(app);
      assert.equal(rebuilt[0].hunkCell, replacement);
      assert.deepEqual(
        rebuilt.map((controller) => controller.lines[0].text),
        ["+first", "+second", "+third"],
      );
    });

    const expansionControl = dom.window.document.querySelector(".js-expand");
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    replaceSemanticMergeFixtureRows(dom.window.document);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const [merged] = controllersFor(app);
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, true, false],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps context expansion intent through staged host rendering", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
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

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    const intent = contextExpansionIntentFor(app);
    const partialRow = dom.window.document.createElement("tr");
    partialRow.innerHTML =
      '<td class="blob-num">18</td><td class="blob-code-context">partially loaded context</td>';
    third.hunkRow.after(partialRow);
    await waitFor(() => {
      const currentThird = controllersFor(app).find(
        (controller) => controller.lines[0].text === "+third",
      );
      assert.ok(currentThird.groupRows.includes(partialRow));
      assert.equal(app.refreshRunning, false);
      assert.equal(contextExpansionIntentFor(app), intent);
    });
    assert.equal(app.hostContextExpansionSettlementReady(intent), false);

    await new Promise((resolve) =>
      dom.window.setTimeout(
        resolve,
        app.constants.HOST_CONTEXT_EXPANSION_SETTLE_MS + 50,
      ),
    );
    assert.equal(contextExpansionIntentFor(app), intent);

    replaceSemanticMergeFixtureRows(dom.window.document);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const [merged] = controllersFor(app);
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, true, false],
      );
    });
    assert.equal(intent.phase, "observed");
    assert.equal(app.hostContextExpansionSettlementReady(intent), true);
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("bounds a slow observed expansion without the old five-second cutoff", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  try {
    const third = controllersFor(app)[2];
    const expansionControl = third.hunkRow.querySelector(".js-expand");
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    const intent = contextExpansionIntentFor(app);
    intent.phase = "observed";
    expansionControl.remove();
    const loading = dom.window.document.createElement("include-fragment");
    loading.setAttribute("src", "/octo/repo/diff/slow");
    third.fileElement.append(loading);

    assert.equal(app.hostContextExpansionSettlementReady(intent), false);
    assert.equal(
      app.hostContextExpansionIntentIsActive(
        intent,
        intent.createdAt + 5_001,
      ),
      true,
    );
    assert.equal(
      app.hostContextExpansionIntentIsActive(
        intent,
        intent.createdAt +
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS +
          1,
      ),
      false,
    );
    assert.equal(
      app.activeHostContextExpansionIntents(
        intent.createdAt +
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS +
          1,
      ).length,
      0,
    );
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps an expand-all intent while another expansion control remains", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
    const [first, , third] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });

    const remainingControl = third.hunkRow.querySelector(".js-expand");

    const expansionControl = dom.window.document.createElement("button");
    expansionControl.className = "js-expand-all-difflines-button";
    expansionControl.dataset.filePath = "src/semantic-merge.js";
    expansionControl.setAttribute(
      "aria-label",
      "Expand all lines: src/semantic-merge.js",
    );
    third.fileElement.querySelector(".file-header").append(expansionControl);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    const intent = contextExpansionIntentFor(app);
    assert.equal(intent.source.expandsWholeFile, true);

    const contextRow = dom.window.document.createElement("tr");
    contextRow.innerHTML =
      '<td class="blob-num">18</td><td class="blob-code-context">loaded context</td>';
    first.lines[0].row.before(contextRow);

    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.notEqual(intent.phase, "observed");
      assert.equal(controllersFor(app)[0].lines[0].marked, false);
    });
    expansionControl.remove();
    await waitFor(() => {
      assert.equal(intent.phase, "observed");
      assert.equal(app.refreshRunning, false);
      assert.equal(controllersFor(app)[0].lines[0].marked, true);
    });
    assert.equal(remainingControl.isConnected, true);
    assert.equal(app.hostContextExpansionSettlementReady(intent), false);

    remainingControl.remove();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.hostContextExpansionSettlementReady(intent), true);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps legacy full-gap expansion scoped to its hunks", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  try {
    const third = controllersFor(app)[2];
    const expansionControl = third.hunkRow.querySelector(".js-expand");
    expansionControl.className = "js-expand-full";
    expansionControl.setAttribute("aria-label", "Expand all");

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });

    const intent = contextExpansionIntentFor(app);
    assert.ok(intent);
    assert.equal(intent.source.expandsWholeFile, false);
    assert.deepEqual(
      Array.from(
        app.hostContextExpansionControllersForControl(
          app.describeHostContextExpansionControl(expansionControl),
        ),
        (controller) => controller.lines[0]?.text,
      ),
      ["+third", "+second"],
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves an observed expansion through a same-size context render", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
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

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(dom.window.document);

    let merged;
    await waitFor(() => {
      [merged] = controllersFor(app);
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, true, false],
      );
    });
    const intent = contextExpansionIntentFor(app);
    const previousFingerprint = merged.lines[0].contextFingerprint;
    assert.equal(intent.phase, "observed");
    app.cancelHostContextExpansionSettlement(intent);

    dom.window.document.querySelector(".blob-code-context").textContent =
      "late rendered merged context";

    let rerendered;
    await waitFor(() => {
      [rerendered] = controllersFor(app);
      assert.notEqual(rerendered, merged);
      assert.notEqual(
        rerendered.lines[0].contextFingerprint,
        previousFingerprint,
      );
    });
    assert.deepEqual(
      Array.from(rerendered.lines, (line) => line.marked),
      [true, true, false],
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves reviews across overlapping same-file GitHub expansions", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second, third] = controllersFor(app);
    assert.equal(app.controllersByRow.size, 3);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const expandAll = dom.window.document.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expandAll,
    });
    const expandAllIntent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(expandAllIntent);
    assert.equal(expandAllIntent.source.expandsWholeFile, true);

    const gapControl = third.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    const oppositeGapControl = third.hunkRow.querySelector(
      '[aria-label="Expand file up from line 20"]',
    );
    assert.deepEqual(
      Array.from(
        app.hostContextExpansionControllersForControl(
          app.describeHostContextExpansionControl(gapControl),
        ),
        (controller) => controller.lines[0].text,
      ),
      ["+third", "+second"],
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: gapControl,
    });
    const gapIntent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(gapIntent);
    assert.notEqual(gapIntent, expandAllIntent);
    assert.equal(gapIntent.source.expandsWholeFile, false);
    assert.deepEqual(Array.from(gapIntent.source.boundaryLineKeys), [
      third.lines[0].key,
      second.lines[0].key,
    ]);
    assert.equal(app.hostContextExpansionIntents.size, 2);

    const previousSecondFingerprint = second.lines[0].contextFingerprint;
    const gapContext = dom.window.document.createElement("tr");
    gapContext.className = "diff-line-row";
    gapContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell left-side-diff-cell" data-diff-side="left" data-line-anchor="diff-overlap-L11"><code class="diff-text"><div class="diff-text-inner">gap response</div></code></td>' +
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right" data-line-anchor="diff-overlap-R11"><code class="diff-text"><div class="diff-text-inner">gap response</div></code></td>';
    third.hunkRow.before(gapContext);
    gapControl.setAttribute("aria-label", "Expand file down from line 13");

    await waitFor(() => {
      assert.equal(gapIntent.phase, "observed");
      assert.deepEqual(
        controllersFor(app).map((controller) => controller.marked),
        [true, true, false],
      );
      const currentSecond = controllersFor(app).find((candidate) =>
        candidate.hunkRow.textContent.includes("second()"),
      );
      assert.notEqual(
        currentSecond.lines[0].contextFingerprint,
        previousSecondFingerprint,
      );
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 1);
    });
    assert.equal(
      app.hostContextExpansionIntents.values().next().value,
      expandAllIntent,
    );
    assert.equal(expandAll.isConnected, true);
    assert.equal(oppositeGapControl.isConnected, true);

    expandAll.remove();
    replaceCurrentReactOverlappingContextRows(dom.window.document);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [true, true, false],
      );
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps unrelated React hunk reviews fail-closed during directional expansion", async () => {
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
    const firstFingerprint = first.lines[0].contextFingerprint;
    const secondFingerprint = second.lines[0].contextFingerprint;

    const gapControl = third.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: gapControl,
    });
    const { previousRegion } = replaceCurrentReactDirectionalRegion(
      dom.window.document,
      { firstHeader: "@@ -1 +1 @@ relocated()" },
    );

    let currentFirst;
    let currentSecond;
    await waitFor(() => {
      [currentFirst, currentSecond] = controllersFor(app);
      assert.equal(previousRegion.isConnected, false);
      assert.notEqual(currentFirst.headerText, first.headerText);
      assert.notEqual(currentFirst.lines[0].contextFingerprint, firstFingerprint);
      assert.notEqual(
        currentSecond.lines[0].contextFingerprint,
        secondFingerprint,
      );
      assert.deepEqual(
        controllersFor(app).map((controller) => controller.marked),
        [false, true, false],
      );
    });
    assert.equal(
      chrome.snapshot()[currentFirst.lines[0].key].contextFingerprint,
      firstFingerprint,
    );
    assert.equal(
      chrome.snapshot()[currentSecond.lines[0].key].contextFingerprint,
      currentSecond.lines[0].contextFingerprint,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps unrelated React hunks collapsed during directional expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second, third] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.equal(first.collapsed, true);
      assert.equal(second.collapsed, true);
      assert.ok(chrome.snapshot()[first.collapsedKey]);
      assert.ok(chrome.snapshot()[second.collapsedKey]);
    });
    const firstCollapsedKey = first.collapsedKey;
    const secondCollapsedKey = second.collapsedKey;
    const originalMeasure = app.measureControllerHostLayout.bind(app);
    let unrelatedRowsStayedCollapsed = false;
    app.measureControllerHostLayout = (hunk, options) => {
      if (hunk.lines[0]?.text === "+first") {
        unrelatedRowsStayedCollapsed = hunk.lines[0].row.classList.contains(
          "hunkmark-collapsed",
        );
      }
      return originalMeasure(hunk, options);
    };

    const gapControl = third.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: gapControl,
    });
    const intent = contextExpansionIntentFor(app);
    const { replacementRegion } =
      replaceCurrentReactDirectionalRegion(dom.window.document);
    const unrelatedContext = dom.window.document.createElement("tr");
    unrelatedContext.className = "diff-line-row";
    unrelatedContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
      '<code class="diff-text" data-diff-side="right">' +
      "unrelated first-hunk context" +
      "</code></td>";
    replacementRegion
      .querySelector('[data-line-anchor="diff-overlap-R1"]')
      .closest("tr")
      .after(unrelatedContext);

    let currentFirst;
    let currentSecond;
    await waitFor(() => {
      [currentFirst, currentSecond] = controllersFor(app);
      assert.equal(currentFirst.collapsed, true);
      assert.equal(currentSecond.collapsed, false);
      assert.equal(unrelatedRowsStayedCollapsed, true);
      assert.deepEqual(
        controllersFor(app).map((controller) => controller.marked),
        [true, true, false],
      );
    });
    app.cancelHostContextExpansionSettlement(intent);
    const laterUnrelatedRow = dom.window.document.createElement("tr");
    laterUnrelatedRow.className = "diff-line-row";
    laterUnrelatedRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell"></td>';
    currentFirst.lines[0].row.after(laterUnrelatedRow);
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(currentFirst.groupRows.includes(laterUnrelatedRow), true);
    });
    assert.equal(currentFirst.collapsed, true);
    assert.ok(chrome.snapshot()[firstCollapsedKey]);
    assert.ok(chrome.snapshot()[currentFirst.collapsedKey]);
    assert.equal(chrome.snapshot()[secondCollapsedKey], undefined);
    assert.equal(chrome.snapshot()[currentSecond.collapsedKey], undefined);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("anchors only the collapsed layout opened by a directional expansion", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [first, second, third] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.equal(first.collapsed, true);
      assert.equal(second.collapsed, true);
    });

    const gapControl = third.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    let sourceTopOverride = null;
    third.hunkRow.getBoundingClientRect = () => {
      const sourceTop =
        sourceTopOverride ??
        (second.lines[0].row.classList.contains("hunkmark-collapsed")
          ? 300
          : 420);
      return {
        height: 48,
        top: sourceTop,
      };
    };
    const scrollCalls = [];
    dom.window.scrollBy = (options) => scrollCalls.push(options);
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: gapControl,
    });
    const intent = contextExpansionIntentFor(app);
    app.rememberHostContextExpansionAffectedReviews(
      intent,
      [second, third],
      third,
    );
    sourceTopOverride = dom.window.innerHeight + 1;
    assert.equal(
      app.hostContextExpansionCollapsedLayoutAnchor(
        new Set([intent]),
        new Map([[third, [second, third]]]),
      ),
      null,
    );
    sourceTopOverride = null;

    const contextRow = dom.window.document.createElement("tr");
    contextRow.className = "diff-line-row";
    contextRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
      '<code class="diff-text" data-diff-side="right">expanded context</code>' +
      "</td>";
    second.lines[0].row.after(contextRow);
    gapControl.setAttribute(
      "aria-label",
      "Expand file down from line 13",
    );
    await waitFor(() => {
      const [currentFirst, currentSecond] = controllersFor(app);
      assert.equal(currentFirst.collapsed, true);
      assert.equal(currentSecond.collapsed, false);
      assert.equal(scrollCalls.length, 1);
    });
    assert.equal(scrollCalls[0].behavior, "auto");
    assert.equal(scrollCalls[0].left, 0);
    assert.equal(scrollCalls[0].top, 120);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves concurrent context expansions in separate files", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  const fixtureDom = new JSDOM(semanticMergeableHunkFixture());
  try {
    const secondFile = dom.window.document.importNode(
      fixtureDom.window.document.querySelector(".js-file"),
      true,
    );
    secondFile.setAttribute("data-file-path", "src/semantic-other.js");
    secondFile.querySelector(".file-info").textContent =
      "src/semantic-other.js";
    dom.window.document.body.append(secondFile);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 6);
    });

    const firstFileControllers = controllersFor(app).filter(
      (controller) => controller.filePath === "src/semantic-merge.js",
    );
    const secondFileControllers = controllersFor(app).filter(
      (controller) => controller.filePath === "src/semantic-other.js",
    );
    [
      ...firstFileControllers.slice(0, 2),
      ...secondFileControllers.slice(0, 2),
    ].forEach((controller) => changeCheckbox(dom, controller.input));
    await waitFor(() => {
      assert.equal(
        [...firstFileControllers, ...secondFileControllers]
          .filter((controller) => controller.lines[0].text !== "+third")
          .every((controller) => controller.marked),
        true,
      );
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: firstFileControllers[2].hunkRow.querySelector(".js-expand"),
    });
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: secondFileControllers[2].hunkRow.querySelector(".js-expand"),
    });
    assert.equal(app.hostContextExpansionIntents.size, 2);

    const replaceRows = (fileElement) => {
      fileElement.querySelector("tbody").innerHTML =
        `<tr><td class="blob-code-hunk">@@ -1,20 +1,20 @@ function merged() {</td></tr>
         <tr><td class="blob-num">0</td><td class="blob-code-context">merged before</td></tr>
         <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
         <tr><td class="blob-num">5</td><td class="blob-code-context">between first and second</td></tr>
         <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
         <tr><td class="blob-num">15</td><td class="blob-code-context">between second and third</td></tr>
         <tr><td class="blob-num">20</td><td class="blob-code-addition">+third</td></tr>
         <tr><td class="blob-num">21</td><td class="blob-code-context">merged after</td></tr>`;
    };
    replaceRows(firstFileControllers[0].fileElement);
    replaceRows(secondFileControllers[0].fileElement);

    await waitFor(() => {
      const mergedControllers = controllersFor(app).filter(
        (controller) => controller.lines.length === 3,
      );
      assert.equal(mergedControllers.length, 2);
      mergedControllers.forEach((controller) => {
        assert.deepEqual(
          Array.from(controller.lines, (line) => line.marked),
          [true, true, false],
        );
      });
    });
    await waitFor(() => {
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
  } finally {
    fixtureDom.window.close();
    stopExtensions({ app, dom });
  }
});

test("keeps unrelated files debounced during a context expansion", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  const fixtureDom = new JSDOM(semanticMergeableHunkFixture());
  try {
    const secondFile = dom.window.document.importNode(
      fixtureDom.window.document.querySelector(".js-file"),
      true,
    );
    secondFile.setAttribute("data-file-path", "src/semantic-other.js");
    secondFile.querySelector(".file-info").textContent =
      "src/semantic-other.js";
    dom.window.document.body.append(secondFile);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 6);
    });

    const firstFileControllers = controllersFor(app).filter(
      (controller) => controller.filePath === "src/semantic-merge.js",
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: firstFileControllers[2].hunkRow.querySelector(".js-expand"),
    });
    const intent = contextExpansionIntentFor(
      app,
      "src/semantic-merge.js",
    );
    assert.ok(intent);

    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const hostUpdate = dom.window.document.createElement("span");
    hostUpdate.textContent = "unrelated file update";
    secondFile.querySelector(".blob-code-hunk").append(hostUpdate);

    await waitFor(() => {
      assert.equal(scheduled.length > 0, true);
    });
    assert.equal(
      scheduled.some(({ immediate }) => immediate === true),
      false,
    );
    assert.equal(
      contextExpansionIntentFor(app, "src/semantic-merge.js"),
      intent,
    );
  } finally {
    fixtureDom.window.close();
    stopExtensions({ app, dom });
  }
});

test("reconciles context expansion reviews from the validated baseline when migration storage fails", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
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
    const warnings = captureWarnings(dom);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    chrome.failNextSet("context migration failed");
    replaceSemanticMergeFixtureRows(dom.window.document);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(warnings.length, 1);
    });
    const [merged] = controllersFor(app);
    assert.deepEqual(
      Array.from(merged.lines, (line) => line.marked),
      [true, true, false],
    );
    assert.equal(
      warnings[0][0],
      "HunkMark could not preserve review state after GitHub updated the diff.",
    );
    assert.equal(
      chrome.snapshot()[merged.lines[1].key].contextFingerprint ===
        merged.lines[1].contextFingerprint,
      false,
    );
    assert.equal(merged.input.disabled, false);
    assert.equal(
      merged.lines.every((line) => line.control?.disabled === false),
      true,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("reenables review controls after a recovered context migration read", async () => {
  const { app, dom } = await startExtension(semanticMergeableHunkFixture());
  try {
    const [first, second, third] = controllersFor(app);
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.equal(first.marked && second.marked, true);
    });
    const warnings = captureWarnings(dom);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    const getLocalStorage = app.getLocalStorage.bind(app);
    let readFailed = false;
    app.getLocalStorage = async (keys) => {
      if (!readFailed && Array.isArray(keys) && keys.length >= 9) {
        readFailed = true;
        throw new Error("context migration read failed");
      }
      return getLocalStorage(keys);
    };
    replaceSemanticMergeFixtureRows(dom.window.document);

    await waitFor(() => {
      assert.equal(readFailed, true);
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(warnings.length, 1);
    });
    const [merged] = controllersFor(app);
    assert.deepEqual(
      Array.from(merged.lines, (line) => line.marked),
      [false, false, false],
    );
    assert.equal(merged.input.disabled, false);
    assert.equal(
      merged.lines.every((line) => line.control?.disabled === false),
      true,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("fails closed when context migration cannot be reconciled", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
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
    const warnings = captureWarnings(dom);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    chrome.failNextSet("context migration failed");
    app.reconcileReviewControllersFromStorage = async () => {
      throw new Error("context reconciliation read failed");
    };
    replaceSemanticMergeFixtureRows(dom.window.document);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(warnings.length, 1);
    });
    const [merged] = controllersFor(app);
    assert.deepEqual(
      Array.from(merged.lines, (line) => line.marked),
      [false, false, false],
    );
    assert.equal(merged.marked, false);
    assert.equal(merged.indeterminate, false);
    assert.equal(merged.input.disabled, true);
    assert.equal(merged.collapseButton.disabled, true);
    assert.equal(
      merged.lines.every((line) => line.control?.disabled === true),
      true,
    );
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 0 \/ 1 · Lines 0 \/ 3/,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps semantic relocation fail-closed without a context expansion click", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
    const [first, second] = Array.from(app.controllersByRow.values());
    [first, second].forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(first.marked, true);
      assert.equal(second.marked, true);
      assert.equal(first.input.disabled, false);
      assert.equal(second.input.disabled, false);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });
    const previousSecondFingerprint = second.lines[0].contextFingerprint;

    replaceSemanticMergeFixtureRows(dom.window.document);

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(
      chrome.snapshot()[merged.lines[1].key].contextFingerprint,
      previousSecondFingerprint,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not migrate reviewed context when expansion changes diff lines", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
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
      assert.equal(first.marked, true);
      assert.equal(second.marked, true);
    });
    const previousSecondKey = second.lines[0].key;
    const previousSecondFingerprint = second.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    replaceSemanticMergeFixtureRows(dom.window.document, { changed: true });

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
    assert.equal(
      chrome.snapshot()[previousSecondKey].contextFingerprint,
      previousSecondFingerprint,
    );
    assert.equal(merged.lines[1].key in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not resurrect review state removed after an expansion click", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
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
      assert.equal(first.marked, true);
      assert.equal(second.marked, true);
      assert.equal(first.input.disabled, false);
      assert.equal(second.input.disabled, false);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    await chrome.api.storage.local.remove(second.lines[0].key);
    assert.equal(second.marked, false);
    replaceSemanticMergeFixtureRows(dom.window.document);

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, false, false],
      );
    });
    assert.equal(merged.lines[1].key in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not migrate review state replaced with another context after expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    semanticMergeableHunkFixture(),
  );
  try {
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
      assert.equal(first.marked, true);
      assert.equal(second.marked, true);
      assert.equal(first.input.disabled, false);
      assert.equal(second.input.disabled, false);
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(".js-expand"),
    });
    const secondKey = second.lines[0].key;
    const replacementContext = first.lines[0].contextFingerprint;
    assert.notEqual(replacementContext, second.lines[0].contextFingerprint);
    chrome.api.storage.onChanged.removeListener(app.boundStorageChanged);
    await chrome.api.storage.local.set({
      [secondKey]: {
        contextFingerprint: replacementContext,
        viewedAt: Date.now(),
      },
    });
    assert.equal(second.marked, true);

    replaceSemanticMergeFixtureRows(dom.window.document);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const [merged] = Array.from(app.controllersByRow.values());
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [true, false, false],
      );
    });
    assert.equal(
      chrome.snapshot()[secondKey].contextFingerprint,
      replacementContext,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("serializes context migration with concurrent review persistence", async (t) => {
  const scenarios = [
    {
      expectedMarked: true,
      initiallyMarked: false,
      name: "commits a pending mark",
      writeFails: false,
    },
    {
      expectedMarked: false,
      initiallyMarked: false,
      name: "rejects a failed pending mark",
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
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { app, chrome, dom, locks } = await startLockedExtension(
        currentReactOverlappingContextExpansionFixture(),
      );
      let delayedMutation;
      try {
        const [, second, third] = controllersFor(app);
        if (scenario.initiallyMarked) {
          changeCheckbox(dom, second.input);
          await waitFor(() => {
            assert.ok(chrome.snapshot()[second.lines[0].key]);
            assert.equal(second.input.disabled, false);
          });
        }

        const secondLineKey = second.lines[0].key;
        const previousFingerprint = second.lines[0].contextFingerprint;
        const warnings = captureWarnings(dom);
        const initialLockRequests = locks.requests.length;
        const failureMessage = scenario.writeFails
          ? "review persistence failed during expansion"
          : null;
        delayedMutation = scenario.initiallyMarked
          ? delayReviewStorageRemove(app, 1, { failureMessage })
          : delayReviewStorageSet(app, 1, { failureMessage });

        changeCheckbox(dom, second.input, !scenario.initiallyMarked);
        await delayedMutation.started;
        assert.equal(second.marked, !scenario.initiallyMarked);

        const expansionControl = third.hunkRow.querySelector(
          '[aria-label="Expand file down from line 12"]',
        );
        app.handleHostContextExpansionClick({
          isTrusted: true,
          target: expansionControl,
        });
        const contextRow = dom.window.document.createElement("tr");
        contextRow.className = "diff-line-row";
        contextRow.setAttribute("data-line-type", "context");
        contextRow.innerHTML =
          '<td role="gridcell" class="diff-text-cell left-side-diff-cell" data-diff-side="left"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>' +
          '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right"><code class="diff-text"><div class="diff-text-inner">expanded context</div></code></td>';
        third.hunkRow.before(contextRow);
        expansionControl.setAttribute(
          "aria-label",
          "Expand file down from line 13",
        );
        await waitFor(() => {
          assert.equal(app.refreshRunning, true);
          assert.equal(locks.requests.length >= initialLockRequests + 2, true);
        });

        delayedMutation.release();
        await waitFor(() => {
          assert.equal(app.refreshRunning, false);
          assert.equal(app.controllersByRow.size, 3);
          assert.equal(warnings.length, Number(scenario.writeFails));
        });

        const currentSecond = controllersFor(app).find((controller) =>
          controller.hunkRow.textContent.includes("second()"),
        );
        assert.notEqual(
          currentSecond.lines[0].contextFingerprint,
          previousFingerprint,
        );
        assert.equal(currentSecond.marked, scenario.expectedMarked);
        assert.equal(
          currentSecond.lines[0].marked,
          scenario.expectedMarked,
        );
        const storedLine = chrome.snapshot()[secondLineKey];
        if (scenario.expectedMarked) {
          assert.equal(
            storedLine.contextFingerprint,
            currentSecond.lines[0].contextFingerprint,
          );
        } else {
          assert.equal(storedLine, undefined);
        }
      } finally {
        delayedMutation?.release();
        stopExtensions({ app, dom });
      }
    });
  }
});
