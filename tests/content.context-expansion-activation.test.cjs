const {
  test,
  assert,
  path,
  root,
  delayReviewStorageSet,
  controllersFor,
  contextExpansionIntentFor,
  stopExtensions,
  startLockedExtension,
  captureWarnings,
  changeCheckbox,
  waitFor,
  startExtension,
  duplicateHunkFixture,
  mergeableHunkFixture,
  replaceMergeFixtureRows,
  currentReactContextExpansionFixture,
  currentReactSplitContextExpansionFixture,
  currentReactOverlappingContextExpansionFixture,
  currentReactContextEvidenceFixture,
  currentReactCachedExpandAllTable,
  replaceCurrentReactContextEvidenceRows,
  moveCurrentReactSecondContextAfterChangedLine,
  currentReactBlankContextEvidenceFixture,
  insertCurrentReactBlankContextAfterSecondLine,
} = require("./content-test-support.cjs");

async function hideRenderedDiff(app, fileElement) {
  const table = fileElement.querySelector('table[role="grid"]');
  table.remove();
  await waitFor(() => {
    assert.equal(app.controllersByRow.size, 0);
  });
}

function completeExpandAllControl(expandAll, filePath) {
  const collapseNonDiff = expandAll.cloneNode(true);
  collapseNonDiff.className = "prc-Button-ButtonBase";
  collapseNonDiff.setAttribute(
    "aria-label",
    `Collapse non-diff lines: ${filePath}`,
  );
  expandAll.replaceWith(collapseNonDiff);
}

function activateTrustedExpansion(app, target, options = {}) {
  app.handleHostContextExpansionClick({
    button: 0,
    isTrusted: true,
    target,
    ...options,
  });
}

async function hideCachedExpandAll(app, controller) {
  assert.ok(
    app.hostContextExpansionCachedFileSnapshot(controller.filePath),
  );
  const fileElement = controller.fileElement;
  const expandAll = fileElement.querySelector(
    `[aria-label="Expand all lines: ${controller.filePath}"]`,
  );
  await hideRenderedDiff(app, fileElement);
  return { expandAll, fileElement };
}

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
      assert.equal(
        merged.collapseButton.getAttribute("aria-label"),
        "Collapse this diff hunk",
      );
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

test("captures GitHub's current file-header Expand all control", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const control = dom.window.document.querySelector(
      '[aria-label="Expand all lines: src/react-one.js"]',
    );
    assert.ok(controller);
    assert.ok(control);
    const description = app.describeHostContextExpansionControl(control);
    assert.equal(control.getAttribute("data-file-path"), "src/react-one.js");
    assert.equal(control.closest('[role="region"]'), controller.fileElement);
    assert.equal(description.filePath, "src/react-one.js");
    assert.equal(description.fileElement, controller.fileElement);
    assert.deepEqual(
      Array.from(
        app.hostContextExpansionControllersForControl(description),
        (candidate) => candidate.filePath,
      ),
      ["src/react-one.js"],
    );
    assert.equal(
      control.closest('tr, [role="row"], [data-testid="diff-line"]'),
      null,
    );
    activateTrustedExpansion(app, control);

    const intent = contextExpansionIntentFor(app, "src/react-one.js");
    assert.ok(intent);
    assert.equal(intent.source.expandsWholeFile, true);
    assert.equal(intent.source.row, controller.hunkRow);
    assert.deepEqual(
      intent.capture.lineKeys,
      controller.lines.map((line) => line.key),
    );
    assert.equal(intent.source.control, control);

    intent.phase = "observed";
    controller.hunkRow
      .querySelector(app.constants.HUNK_EXPANSION_CONTROL_SELECTOR)
      .remove();
    assert.equal(app.hostContextExpansionSettlementReady(intent), false);
    control.remove();
    assert.equal(app.hostContextExpansionSettlementReady(intent), true);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("captures GitHub context expansion with modifier keys", async (t) => {
  const modifierKeys = ["altKey", "ctrlKey", "metaKey", "shiftKey"];

  for (const modifierKey of modifierKeys) {
    await t.test(modifierKey, async () => {
      const { app, dom } = await startExtension(
        currentReactContextExpansionFixture(),
      );
      try {
        const controller = controllersFor(app).find(
          (candidate) => candidate.filePath === "src/react-one.js",
        );
        const control = controller.hunkRow.querySelector(
          '[aria-label="Expand file from line 2 to line 9"]',
        );

        activateTrustedExpansion(app, control, {
          [modifierKey]: true,
        });

        const intent = contextExpansionIntentFor(app, "src/react-one.js");
        assert.ok(intent);
        assert.equal(intent.source.control, control);
      } finally {
        stopExtensions({ app, dom });
      }
    });
  }
});

test("preserves both sides of GitHub's current split diff expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactSplitContextExpansionFixture(),
  );
  try {
    const [controller] = controllersFor(app);
    assert.equal(controller.lines.length, 2);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.side),
      ["left", "right"],
    );
    changeCheckbox(dom, controller.input);
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(
        controller.lines.every((line) => chrome.snapshot()[line.key]),
        true,
      );
    });
    const originalContexts = controller.lines.map(
      (line) => line.contextFingerprint,
    );
    const expansionControl = controller.hunkRow.querySelector(
      '[aria-label="Expand file up from line 10"]',
    );
    activateTrustedExpansion(app, expansionControl);

    const contextRow = dom.window.document.createElement("tr");
    contextRow.className = "diff-line-row";
    contextRow.innerHTML =
      '<td role="gridcell" class="new-diff-line-number left-side" data-diff-side="left">9</td>' +
      '<td role="gridcell" class="diff-text-cell left-side-diff-cell" data-diff-side="left"><code class="diff-text"><span class="diff-text-inner">split context</span></code></td>' +
      '<td role="gridcell" class="new-diff-line-number left-side" data-diff-side="right">9</td>' +
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell" data-diff-side="right"><code class="diff-text"><span class="diff-text-inner">split context</span></code></td>';
    controller.lines[0].row.before(contextRow);
    expansionControl.setAttribute(
      "aria-label",
      "Expand file up from line 9",
    );

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.notEqual(expanded, controller);
      assert.equal(expanded.lines.length, 2);
      assert.deepEqual(
        Array.from(expanded.lines, (line) => line.marked),
        [true, true],
      );
    });
    expanded.lines.forEach((line, index) => {
      assert.notEqual(line.contextFingerprint, originalContexts[index]);
      const stored = chrome.snapshot()[line.key];
      assert.equal(stored.contextFingerprint, line.contextFingerprint);
      assert.equal(stored.baselineContextFingerprint, originalContexts[index]);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves reviewed lines when React Expand all starts from a collapsed file", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
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
    const previousFingerprints = [
      first.lines[0].contextFingerprint,
      second.lines[0].contextFingerprint,
    ];
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(intent.source.expandsWholeFile, true);
    assert.notEqual(intent.timers.expiry, null);

    let completedHiddenRefreshes = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async () => {
      try {
        return await refresh();
      } finally {
        completedHiddenRefreshes += 1;
      }
    };
    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    expandAll.replaceWith(collapseNonDiff);
    await waitFor(() => {
      assert.equal(completedHiddenRefreshes > 0, true);
    });
    assert.equal(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
      intent,
    );
    const expandedTable = currentReactCachedExpandAllTable(
      dom.window.document,
    );
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
    const [merged] = controllersFor(app);
    assert.notEqual(
      merged.lines[0].contextFingerprint,
      previousFingerprints[0],
    );
    assert.notEqual(
      merged.lines[1].contextFingerprint,
      previousFingerprints[1],
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("captures hidden Expand all for an extensionless root file", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture().replaceAll(
      "src/react-overlap.js",
      "WORKSPACE",
    ),
  );
  try {
    const [first, second] = controllersFor(app);
    assert.equal(first.filePath, "WORKSPACE");
    assert.equal(second.filePath, "WORKSPACE");
    [first, second].forEach((controller) =>
      changeCheckbox(dom, controller.input),
    );
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: WORKSPACE"]',
    );
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(app, "WORKSPACE");
    assert.ok(intent);
    assert.equal(intent.source.expandsWholeFile, true);
    assert.equal(intent.origin, "cached");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("rejects a hidden Expand all when its authoritative file path changes", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [first] = controllersFor(app);
    const { expandAll, fileElement } = await hideCachedExpandAll(app, first);
    expandAll.dataset.filePath = "src/replaced.js";
    expandAll.setAttribute(
      "aria-label",
      "Expand all lines: src/replaced.js",
    );

    activateTrustedExpansion(app, expandAll);
    assert.equal(app.hostContextExpansionIntents.size, 0);
    assert.equal(
      app.knownFilePath(fileElement),
      "src/replaced.js",
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a cached machine path when only presentation text differs", async () => {
  const fixture = currentReactContextEvidenceFixture().replace(
    "src/react-overlap.js</code>",
    "src/{old =&gt; new}/react-overlap.js</code>",
  );
  const { app, dom } = await startExtension(fixture);
  try {
    const [first] = controllersFor(app);
    const { expandAll } = await hideCachedExpandAll(app, first);
    expandAll.removeAttribute("data-file-path");
    expandAll.setAttribute("aria-label", "Expand all lines");

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(intent.origin, "cached");
  } finally {
    stopExtensions({ app, dom });
  }
});

for (const scenario of [
  {
    fixture: currentReactContextEvidenceFixture,
    name: "rejects hidden React Expand all when rendered context is replaced",
    render(staging) {
      replaceCurrentReactContextEvidenceRows(staging, {
        replaceSecondContext: true,
      });
    },
  },
  {
    fixture: currentReactContextEvidenceFixture,
    name: "rejects hidden React Expand all when context moves across a changed line",
    render(staging) {
      replaceCurrentReactContextEvidenceRows(staging);
      moveCurrentReactSecondContextAfterChangedLine(staging);
    },
  },
  {
    fixture: currentReactBlankContextEvidenceFixture,
    name: "rejects hidden React Expand all when blank context moves across a changed line",
    render(staging) {
      replaceCurrentReactContextEvidenceRows(staging);
      insertCurrentReactBlankContextAfterSecondLine(staging);
    },
  },
]) {
  test(scenario.name, async () => {
    const { app, chrome, dom } = await startExtension(scenario.fixture());
    try {
      const [, second] = controllersFor(app);
      changeCheckbox(dom, second.input);
      await waitFor(() => {
        assert.ok(chrome.snapshot()[second.lines[0].key]);
      });

      const fileElement = second.fileElement;
      const originalTable = fileElement.querySelector('table[role="grid"]');
      const expandAll = fileElement.querySelector(
        '[aria-label="Expand all lines: src/react-overlap.js"]',
      );
      const fileToggle = dom.window.document.createElement("button");
      fileToggle.setAttribute("aria-label", "Collapse file");
      fileElement
        .querySelector('[class*="DiffFileHeader-module__diff-file-header__"]')
        .append(fileToggle);

      app.handleFileVisibilityClick({ target: fileToggle });
      originalTable.remove();
      await waitFor(() => {
        assert.equal(app.controllersByRow.size, 0);
      });

      activateTrustedExpansion(app, expandAll);
      const intent = contextExpansionIntentFor(
        app,
        "src/react-overlap.js",
      );
      assert.ok(intent);
      const collapseNonDiff = expandAll.cloneNode(true);
      collapseNonDiff.className = "prc-Button-ButtonBase";
      collapseNonDiff.setAttribute(
        "aria-label",
        "Collapse non-diff lines: src/react-overlap.js",
      );
      expandAll.replaceWith(collapseNonDiff);

      const staging = dom.window.document.createElement("div");
      const expandedTable = originalTable.cloneNode(false);
      expandedTable.innerHTML = "<tbody></tbody>";
      staging.append(expandedTable);
      scenario.render(staging);
      fileToggle.setAttribute("aria-label", "Expand file");
      app.handleFileVisibilityClick({ target: fileToggle });
      fileElement.append(expandedTable);

      await waitFor(() => {
        const [replacementController] = controllersFor(app);
        assert.equal(app.controllersByRow.size, 1);
        assert.deepEqual(
          Array.from(replacementController.lines, (line) => line.marked),
          [false, false, false],
        );
      });
      assert.notEqual(intent.phase, "observed");
    } finally {
      stopExtensions({ app, dom });
    }
  });
}

test("rejects a hidden Expand all semantic replacement within its lifetime", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  const replacementDocument = new dom.window.DOMParser().parseFromString(
    currentReactContextEvidenceFixture(),
    "text/html",
  );
  try {
    const second = controllersFor(app)[1];
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });
    const previousContext = second.lines[0].contextFingerprint;
    const { expandAll, fileElement } = await hideCachedExpandAll(app, second);
    const replacementTable = dom.window.document.importNode(
      replacementDocument.querySelector('table[role="grid"]'),
      true,
    );
    replacementTable.querySelectorAll(".diff-hunk-cell")[1].textContent =
      "@@ -10 +10 @@ unrelatedRelocation()";

    activateTrustedExpansion(app, expandAll);
    assert.ok(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
    );
    completeExpandAllControl(expandAll, "src/react-overlap.js");
    fileElement.append(replacementTable);

    await waitFor(() => {
      const replacement = controllersFor(app)[1];
      assert.equal(replacement.marked, false);
      assert.notEqual(
        replacement.lines[0].contextFingerprint,
        previousContext,
      );
      assert.equal(app.hostContextExpansionIntents.size, 0);
    });
    assert.equal(
      chrome.snapshot()[second.lines[0].key].contextFingerprint,
      previousContext,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("defers a hidden Expand all until its staged header suffix returns", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const first = controllersFor(app)[0];
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const { expandAll, fileElement } = await hideCachedExpandAll(app, first);

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    completeExpandAllControl(expandAll, "src/react-overlap.js");
    const stagedTable = currentReactCachedExpandAllTable(
      dom.window.document,
    );
    const hunkCell = stagedTable.querySelector(".diff-hunk-cell");
    hunkCell.textContent = "@@ -1,20 +1,20 @@";
    fileElement.append(stagedTable);

    await waitFor(() => {
      const [staged] = controllersFor(app);
      assert.equal(staged.lines[0].marked, false);
    });
    hunkCell.textContent = "@@ -1,20 +1,20 @@ first()";

    await waitFor(() => {
      const [expanded] = controllersFor(app);
      assert.equal(expanded.lines[0].marked, true);
      assert.equal(intent.phase, "observed");
      assert.equal(
        chrome.snapshot()[expanded.lines[0].key].contextFingerprint,
        expanded.lines[0].contextFingerprint,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("defers a hidden Expand all until changed lines return", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const first = controllersFor(app)[0];
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const { expandAll, fileElement } = await hideCachedExpandAll(app, first);
    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    completeExpandAllControl(expandAll, "src/react-overlap.js");
    const headerOnlyTable = dom.window.document.createElement("table");
    headerOnlyTable.setAttribute("role", "grid");
    headerOnlyTable.setAttribute(
      "aria-label",
      "Diff for: src/react-overlap.js",
    );
    headerOnlyTable.innerHTML =
      '<tbody><tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1,20 +1,20 @@ first()</td></tr></tbody>';
    fileElement.append(headerOnlyTable);

    await waitFor(() => {
      const [staged] = controllersFor(app);
      assert.equal(staged.lines.length, 0);
      assert.notEqual(intent.phase, "observed");
    });
    headerOnlyTable.replaceWith(
      currentReactCachedExpandAllTable(dom.window.document),
    );

    await waitFor(() => {
      const [expanded] = controllersFor(app);
      assert.equal(expanded.lines[0].marked, true);
      assert.equal(intent.phase, "observed");
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("expires a hidden Expand all before a later semantic replacement", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [first] = controllersFor(app);
    changeCheckbox(dom, first.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[first.lines[0].key]);
    });
    const originalContext = first.lines[0].contextFingerprint;
    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const fileToggle = dom.window.document.createElement("button");
    fileToggle.setAttribute("aria-label", "Collapse file");
    fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    ).append(fileToggle);

    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(
      app.activeHostContextExpansionIntents(
        intent.createdAt +
          app.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS +
          1,
      ).length,
      0,
    );

    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    expandAll.replaceWith(collapseNonDiff);
    const changedContextTable = currentReactCachedExpandAllTable(
      dom.window.document,
    );
    changedContextTable.querySelector(".diff-hunk-cell").textContent =
      "@@ -1,20 +1,20 @@ unrelatedReplacement()";
    fileToggle.setAttribute("aria-label", "Expand file");
    app.handleFileVisibilityClick({ target: fileToggle });
    fileElement.append(changedContextTable);

    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.notEqual(
        replacement.lines[0].contextFingerprint,
        originalContext,
      );
      assert.equal(replacement.lines[0].marked, false);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("supersedes an older hidden Expand all intent", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [first] = controllersFor(app);
    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    activateTrustedExpansion(app, expandAll);
    const firstIntent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    activateTrustedExpansion(app, expandAll);
    const secondIntent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );

    assert.notEqual(secondIntent, firstIntent);
    assert.equal(app.hostContextExpansionIntents.size, 1);
    assert.equal(firstIntent.timers.expiry, null);
    assert.notEqual(secondIntent.timers.expiry, null);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves a line first reviewed after hidden React Expand all", async () => {
  const firstPage = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  let secondPage = null;
  try {
    const initialControllers = controllersFor(firstPage.app);
    const originalContextByLineKey = new Map(
      initialControllers.flatMap((controller) =>
        controller.lines.map((line) => [line.key, line.contextFingerprint]),
      ),
    );
    const fileElement = initialControllers[0].fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(firstPage.app.controllersByRow.size, 0);
    });

    activateTrustedExpansion(firstPage.app, expandAll);
    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    expandAll.replaceWith(collapseNonDiff);
    fileElement.append(
      currentReactCachedExpandAllTable(firstPage.dom.window.document),
    );

    let merged;
    await waitFor(() => {
      [merged] = controllersFor(firstPage.app);
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [false, false, false],
      );
    });
    merged.lines[2].control.click();
    await waitFor(() => {
      assert.equal(merged.lines[2].marked, true);
      const stored = firstPage.chrome.snapshot()[merged.lines[2].key];
      assert.equal(stored.contextFingerprint, merged.lines[2].contextFingerprint);
      assert.equal(
        stored.baselineContextFingerprint,
        originalContextByLineKey.get(merged.lines[2].key),
      );
    });

    firstPage.app.stop();
    firstPage.dom.window.close();
    secondPage = await startExtension(
      currentReactContextEvidenceFixture(),
      {},
      { chromeInstance: firstPage.chrome },
    );

    assert.deepEqual(
      controllersFor(secondPage.app).map((controller) => controller.marked),
      [false, false, true],
    );
  } finally {
    if (secondPage) {
      stopExtensions(secondPage);
    } else if (!firstPage.app.stopped) {
      stopExtensions(firstPage);
    }
  }
});

test("serializes hidden React Expand all with a pending mark", async (t) => {
  const scenarios = [
    {
      commits: true,
      name: "preserves a committed pending mark",
    },
    {
      commits: false,
      name: "does not revive a failed pending mark",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { app, chrome, dom } = await startLockedExtension(
        currentReactContextEvidenceFixture(),
      );
      let delayedMutation;
      try {
        const [first] = controllersFor(app);
        const fileElement = first.fileElement;
        const expandAll = fileElement.querySelector(
          '[aria-label="Expand all lines: src/react-overlap.js"]',
        );
        const lineKey = first.lines[0].key;
        const previousFingerprint = first.lines[0].contextFingerprint;
        const warnings = captureWarnings(dom);

        delayedMutation = delayReviewStorageSet(app, 1, {
          failureMessage: scenario.commits ? null : "pending mark failed",
        });
        changeCheckbox(dom, first.input);
        await delayedMutation.started;
        assert.equal(first.lines[0].marked, true);
        assert.equal(chrome.snapshot()[lineKey], undefined);

        fileElement.querySelector('table[role="grid"]').remove();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 0);
        });
        activateTrustedExpansion(app, expandAll);
        const intent = contextExpansionIntentFor(
          app,
          "src/react-overlap.js",
        );
        assert.ok(intent);

        const collapseNonDiff = expandAll.cloneNode(true);
        collapseNonDiff.className = "prc-Button-ButtonBase";
        collapseNonDiff.setAttribute(
          "aria-label",
          "Collapse non-diff lines: src/react-overlap.js",
        );
        expandAll.replaceWith(collapseNonDiff);
        fileElement.append(
          currentReactCachedExpandAllTable(dom.window.document),
        );
        await waitFor(() => {
          assert.equal(app.refreshRunning, true);
        });

        delayedMutation.release();
        await waitFor(() => {
          assert.equal(app.refreshRunning, false);
          assert.equal(app.controllersByRow.size, 1);
          assert.equal(warnings.length, Number(!scenario.commits));
          const [merged] = controllersFor(app);
          assert.notEqual(
            merged.lines[0].contextFingerprint,
            previousFingerprint,
          );
          assert.deepEqual(
            Array.from(merged.lines, (line) => line.marked),
            [scenario.commits, false, false],
          );
          if (scenario.commits) {
            assert.equal(
              chrome.snapshot()[lineKey].contextFingerprint,
              merged.lines[0].contextFingerprint,
            );
          } else {
            assert.equal(chrome.snapshot()[lineKey], undefined);
          }
        });
      } finally {
        delayedMutation?.release();
        stopExtensions({ app, dom });
      }
    });
  }
});

test("fails closed when collapsed-file Expand all reveals changed lines", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
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
    const previousLineKeys = [first.lines[0].key, second.lines[0].key];
    const previousContexts = previousLineKeys.map(
      (key) => chrome.snapshot()[key].contextFingerprint,
    );

    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    activateTrustedExpansion(app, expandAll);
    assert.ok(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
    );

    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    expandAll.replaceWith(collapseNonDiff);
    const changedTable = currentReactCachedExpandAllTable(
      dom.window.document,
    );
    changedTable.querySelector(
      '[data-line-anchor="diff-overlap-R10"] code',
    ).textContent = "+changed";
    fileElement.append(changedTable);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
    previousLineKeys.forEach((key, index) => {
      assert.equal(
        chrome.snapshot()[key].contextFingerprint,
        previousContexts[index],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("rejects unusable hidden file snapshots", async (t) => {
  for (const scenario of [
    {
      fixture: currentReactContextEvidenceFixture,
      invalidate(app) {
        app.fileReviewSnapshotsByKey.clear();
      },
      name: "missing cached progress",
    },
    {
      fixture: currentReactOverlappingContextExpansionFixture,
      invalidate() {},
      name: "no independently anchored hunk",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(scenario.fixture());
      try {
        const [first] = controllersFor(app);
        const fileElement = first.fileElement;
        const expandAll = fileElement.querySelector(
          '[aria-label="Expand all lines: src/react-overlap.js"]',
        );
        scenario.invalidate(app);
        assert.equal(
          app.hostContextExpansionCachedFileSnapshot(first.filePath),
          null,
        );
        await hideRenderedDiff(app, fileElement);

        activateTrustedExpansion(app, expandAll);
        assert.equal(app.hostContextExpansionIntents.size, 0);
      } finally {
        stopExtensions({ app, dom });
      }
    });
  }
});

test("does not activate a cached hidden file with fallback identity", async () => {
  const fixture = currentReactContextEvidenceFixture()
    .replace(
      'role="region" class="Diff-module__diffTargetable__overlap',
      'role="region" id="diff-unknown" class="Diff-module__diffTargetable__overlap',
    )
    .replace(
      '<h3><a href="#diff-overlap"><code>src/react-overlap.js</code></a></h3>',
      "<h3>unknown file</h3>",
    )
    .replace(
      'data-file-path="src/react-overlap.js" aria-label="Expand all lines: src/react-overlap.js"',
      'aria-label="Expand all lines"',
    )
    .replace(
      'role="grid" aria-label="Diff for: src/react-overlap.js"',
      'role="grid"',
    );
  const { app, dom } = await startExtension(fixture);
  try {
    const [first] = controllersFor(app);
    assert.match(first.filePath, /^unknown-file:/);
    assert.ok(app.hostContextExpansionCachedFileSnapshot(first.filePath));
    const fileElement = first.fileElement;
    const expandAll = fileElement.querySelector(
      ".js-expand-all-difflines-button",
    );
    await hideRenderedDiff(app, fileElement);

    activateTrustedExpansion(app, expandAll);
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not migrate a one-sided hunk from a mixed cached file", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const initialSecond = controllersFor(app)[1];
    const fileElement = initialSecond.fileElement;
    const afterSecond = Array.from(
      fileElement.querySelectorAll("tr"),
    ).find((row) => row.textContent.trim() === "after second");
    afterSecond.remove();

    let second;
    await waitFor(() => {
      second = controllersFor(app)[1];
      assert.notEqual(second, initialSecond);
      const snapshot = app.hostContextExpansionCachedFileSnapshot(
        second.filePath,
      );
      assert.equal(snapshot.cachedHunkGroups[1].independentlyAnchored, false);
      assert.equal(snapshot.lineReviewSnapshot.has(second.lines[0].key), false);
    });
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });
    const previousContext = second.lines[0].contextFingerprint;
    const { expandAll } = await hideCachedExpandAll(app, second);

    activateTrustedExpansion(app, expandAll);
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(intent.capture.linesByKey.has(second.lines[0].key), false);
    completeExpandAllControl(expandAll, "src/react-overlap.js");
    fileElement.append(
      currentReactCachedExpandAllTable(dom.window.document),
    );

    await waitFor(() => {
      const [merged] = controllersFor(app);
      assert.equal(merged.lines[1].marked, false);
      assert.notEqual(merged.lines[1].contextFingerprint, previousContext);
    });
    assert.equal(
      chrome.snapshot()[second.lines[0].key].contextFingerprint,
      previousContext,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not capture cached Expand all with blocking host state", async (t) => {
  for (const scenario of [
    {
      create(document) {
        const spinner = document.createElement("span");
        spinner.setAttribute("data-component", "Spinner");
        return spinner;
      },
      name: "active loading spinner",
    },
    {
      create(document) {
        const loadMore = document.createElement("button");
        loadMore.setAttribute("data-testid", "load-more-lines");
        return loadMore;
      },
      name: "load-more placeholder",
    },
    {
      assertBlockedByRows(app, fileElement) {
        assert.equal(app.findHunkMarkers(fileElement).length, 0);
      },
      create(document) {
        const table = document.createElement("table");
        table.setAttribute("role", "grid");
        table.setAttribute("aria-label", "Diff for: src/react-overlap.js");
        table.innerHTML =
          '<tbody><tr class="diff-line-row"><td>staged row</td></tr></tbody>';
        return table;
      },
      name: "staged row without a hunk",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(
        currentReactContextEvidenceFixture(),
      );
      try {
        const [first] = controllersFor(app);
        const { expandAll, fileElement } =
          await hideCachedExpandAll(app, first);
        fileElement.append(scenario.create(dom.window.document));
        scenario.assertBlockedByRows?.(app, fileElement);

        activateTrustedExpansion(app, expandAll);
        assert.equal(app.hostContextExpansionIntents.size, 0);
      } finally {
        stopExtensions({ app, dom });
      }
    });
  }
});

test("does not use a cached Expand all snapshot for a visible replacement", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  const replacementDocument = new dom.window.DOMParser().parseFromString(
    currentReactContextEvidenceFixture(),
    "text/html",
  );
  try {
    const [first, second] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });
    const lineKey = second.lines[0].key;
    const previousContext = second.lines[0].contextFingerprint;
    const filePath = first.filePath;
    const previousFileElement = first.fileElement;
    assert.ok(app.hostContextExpansionCachedFileSnapshot(filePath));

    const replacementFileElement = dom.window.document.importNode(
      replacementDocument.querySelector(
        '[role="region"].Diff-module__diff__overlap',
      ),
      true,
    );
    replacementFileElement
      .querySelector('table[role="grid"]')
      .replaceWith(
        currentReactCachedExpandAllTable(dom.window.document),
      );
    previousFileElement.replaceWith(replacementFileElement);
    const expandAll = replacementFileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    assert.equal(first.hunkRow.isConnected, false);
    assert.equal(app.findHunkMarkers(replacementFileElement).length > 0, true);
    assert.equal(
      app.hostContextExpansionControllersForControl(
        app.describeHostContextExpansionControl(expandAll),
      ).length,
      0,
    );

    activateTrustedExpansion(app, expandAll);
    assert.equal(app.hostContextExpansionIntents.size, 0);

    expandAll.remove();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(controllersFor(app).length, 1);
      const [merged] = controllersFor(app);
      assert.notEqual(merged.lines[1].contextFingerprint, previousContext);
      assert.equal(merged.lines[1].marked, false);
    });
    assert.equal(
      chrome.snapshot()[lineKey].contextFingerprint,
      previousContext,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("does not revive hidden-file state replaced before Expand all", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
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
    const expandAll = fileElement.querySelector(
      '[aria-label="Expand all lines: src/react-overlap.js"]',
    );
    const replacementContext = third.lines[0].contextFingerprint;
    assert.notEqual(replacementContext, first.lines[0].contextFingerprint);
    fileElement.querySelector('table[role="grid"]').remove();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });
    await chrome.api.storage.local.set({
      [first.lines[0].key]: {
        contextFingerprint: replacementContext,
        viewedAt: Date.now(),
      },
    });
    await waitFor(() => {
      assert.equal(
        app.lineReviewContextByKey.get(first.lines[0].key),
        replacementContext,
      );
    });

    activateTrustedExpansion(app, expandAll);
    const collapseNonDiff = expandAll.cloneNode(true);
    collapseNonDiff.className = "prc-Button-ButtonBase";
    collapseNonDiff.setAttribute(
      "aria-label",
      "Collapse non-diff lines: src/react-overlap.js",
    );
    expandAll.replaceWith(collapseNonDiff);
    fileElement.append(
      currentReactCachedExpandAllTable(dom.window.document),
    );

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(controllersFor(app)[0].lines, (line) => line.marked),
        [false, true, false],
      );
    });
    assert.equal(
      chrome.snapshot()[first.lines[0].key].contextFingerprint,
      replacementContext,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});
