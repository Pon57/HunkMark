const {
  test,
  assert,
  controllersFor,
  contextExpansionIntentFor,
  fileReviewSnapshotFor,
  stopExtensions,
  changeCheckbox,
  waitFor,
  startExtension,
  currentReactContextExpansionFixture,
  currentReactOverlappingContextExpansionFixture,
  currentReactContextEvidenceFixture,
  replaceCurrentReactContextEvidenceRows,
  appendCurrentReactTrailingContextEvidence,
  moveCurrentReactSecondContextAfterChangedLine,
  currentReactBlankContextEvidenceFixture,
  insertCurrentReactBlankContextAfterSecondLine,
} = require("./content-test-support.cjs");

test("settles the clicked React gap while another direction remains", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const clicked = controller.hunkRow.querySelector(
      '[aria-label="Expand file from line 2 to line 9"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: clicked,
    });
    const intent = contextExpansionIntentFor(app, "src/react-one.js");
    assert.ok(intent);
    intent.phase = "observed";

    const replacement = clicked.cloneNode(true);
    clicked.replaceWith(replacement);
    assert.equal(app.hostContextExpansionSettlementReady(intent), false);

    const remaining = dom.window.document.createElement("button");
    remaining.className =
      "Button ExpandableHunkHeaderDiffLine-module__expand-button-line__one";
    remaining.setAttribute(
      "aria-label",
      "Expand file down from line 10",
    );
    replacement.replaceWith(remaining);
    assert.equal(remaining.isConnected, true);
    assert.equal(app.hostContextExpansionSettlementReady(intent), true);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("waits for active React diff loading after the clicked gap completes", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const clicked = controller.hunkRow.querySelector(
      '[aria-label="Expand file from line 2 to line 9"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: clicked,
    });
    const intent = contextExpansionIntentFor(app, "src/react-one.js");
    assert.ok(intent);
    intent.phase = "observed";
    clicked.remove();

    const loading = dom.window.document.createElement("include-fragment");
    loading.setAttribute("src", "/octo/repo/diff/react-one");
    controller.fileElement.append(loading);
    assert.equal(app.hostContextExpansionSettlementReady(intent), false);
    loading.remove();
    assert.equal(app.hostContextExpansionSettlementReady(intent), true);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a React expansion intent when file-header loading begins", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const clicked = controller.hunkRow.querySelector(
      '[aria-label="Expand file from line 2 to line 9"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: clicked,
    });
    const intent = contextExpansionIntentFor(app, "src/react-one.js");
    assert.ok(intent);
    intent.phase = "observed";
    clicked.remove();
    await waitFor(() => {
      assert.notEqual(intent.timers.settlement, null);
    });

    const loading = dom.window.document.createElement("span");
    loading.setAttribute("data-component", "Spinner");
    const header = controller.fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    );
    header.append(loading);

    await new Promise((resolve) =>
      dom.window.setTimeout(
        resolve,
        app.constants.HOST_CONTEXT_EXPANSION_SETTLE_MS + 50,
      ),
    );
    assert.equal(
      contextExpansionIntentFor(app, "src/react-one.js"),
      intent,
    );
    assert.equal(intent.timers.settlement, null);

    loading.remove();
    await waitFor(() => {
      assert.equal(
        contextExpansionIntentFor(app, "src/react-one.js"),
        null,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("attributes current React diff-row mutations to one file", async () => {
  const { app, dom } = await startExtension(
    currentReactContextExpansionFixture(),
  );
  try {
    const controllers = controllersFor(app);
    assert.equal(controllers.length, 2);
    assert.equal(
      controllers.every(
        (controller) =>
          controller.fileElement.getAttribute("role") === "region" &&
          !controller.fileElement.matches(
            app.constants.FILE_CONTAINER_SELECTOR,
          ),
      ),
      true,
    );
    const second = controllers.find(
      (controller) => controller.filePath === "src/react-two.js",
    );
    const header = second.fileElement.querySelector(
      '[class*="DiffFileHeader-module__diff-file-header__"]',
    );
    const tbody = second.hunkRow.closest("tbody");
    const paths = app.hostContextExpansionMutationFilePaths([
      {
        addedNodes: [],
        removedNodes: [],
        target: tbody,
      },
      {
        addedNodes: [],
        removedNodes: [],
        target: header,
      },
    ]);
    assert.deepEqual([...paths], ["src/react-two.js"]);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("observes current React in-place directional expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const expansionControl = third.hunkRow.querySelector(
      '[aria-label="Expand file down from line 12"]',
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: expansionControl,
    });
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );

    const contextRow = dom.window.document.createElement("tr");
    contextRow.className = "diff-line-row";
    contextRow.dataset.lineType = "context";
    contextRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">expanded context</td>';
    third.hunkRow.before(contextRow);
    expansionControl.setAttribute(
      "aria-label",
      "Expand file down from line 13",
    );

    await waitFor(() => {
      const rebuiltSecond = controllersFor(app).find(
        (controller) => controller.lines[0]?.text === "+second",
      );
      assert.ok(rebuiltSecond.groupRows.includes(contextRow));
      assert.equal(rebuiltSecond.lines[0].marked, true);
      assert.equal(intent.phase, "observed");
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves current React reviews when expansion only inserts context", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });
    const previousContextFingerprint = second.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactContextEvidenceRows(dom.window.document);

    await waitFor(() => {
      const [merged] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.notEqual(
        merged.lines[1].contextFingerprint,
        previousContextFingerprint,
      );
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.marked),
        [false, true, false],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("revokes an observed React expansion when a later render replaces context evidence", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactContextEvidenceRows(dom.window.document);

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(expanded.lines, (line) => line.marked),
        [false, true, false],
      );
    });
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(intent.phase, "observed");
    app.cancelHostContextExpansionSettlement(intent);

    const beforeSecond = expanded.groupRows.find(
      (row) => row.textContent.trim() === "before second",
    );
    beforeSecond.querySelector("code").textContent =
      "late replacement before second";

    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.notEqual(replacement, expanded);
      assert.deepEqual(
        Array.from(replacement.lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps an observed React expansion through later monotonic context insertion", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactContextEvidenceRows(dom.window.document);

    let expanded;
    await waitFor(() => {
      [expanded] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(expanded.lines, (line) => line.marked),
        [false, true, false],
      );
    });
    const intent = contextExpansionIntentFor(
      app,
      "src/react-overlap.js",
    );
    assert.ok(intent);
    assert.equal(intent.phase, "observed");
    app.cancelHostContextExpansionSettlement(intent);

    const insertedContext = appendCurrentReactTrailingContextEvidence(
      dom.window.document,
      "later monotonic context",
    );

    await waitFor(() => {
      const [rerendered] = controllersFor(app);
      assert.equal(rerendered.groupRows.includes(insertedContext), true);
      assert.deepEqual(
        Array.from(rerendered.lines, (line) => line.marked),
        [false, true, false],
      );
    });
    assert.equal(
      contextExpansionIntentFor(app, "src/react-overlap.js"),
      intent,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

function testRejectsClickedReactContextTransition({
  assertReplacement = () => {},
  fixture,
  mutate,
  name,
}) {
  test(name, async () => {
    const { app, chrome, dom } = await startExtension(fixture());
    try {
      const [, second, third] = controllersFor(app);
      changeCheckbox(dom, second.input);
      await waitFor(() => {
        assert.ok(chrome.snapshot()[second.lines[0].key]);
      });
      const lineKey = second.lines[0].key;
      const storedContextFingerprint =
        chrome.snapshot()[lineKey].contextFingerprint;

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
      mutate(dom.window.document);

      await waitFor(() => {
        const [replacement] = controllersFor(app);
        assert.equal(app.controllersByRow.size, 1);
        assertReplacement(replacement, storedContextFingerprint);
        assert.deepEqual(
          Array.from(replacement.lines, (line) => line.marked),
          [false, false, false],
        );
      });
      assert.notEqual(intent.phase, "observed");
      assert.equal(
        chrome.snapshot()[lineKey].contextFingerprint,
        storedContextFingerprint,
      );
      assert.equal(
        chrome.snapshot()[lineKey].baselineContextFingerprint,
        undefined,
      );
    } finally {
      stopExtensions({ app, dom });
    }
  });
}

testRejectsClickedReactContextTransition({
  fixture: currentReactContextEvidenceFixture,
  mutate(document) {
    replaceCurrentReactContextEvidenceRows(document, {
      replaceSecondContext: true,
    });
  },
  name: "rejects a clicked React transition that replaces rendered context",
});
test("rejects a React expansion click when controllers lag the displayed context", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    const staleContext = dom.window.document.createElement("tr");
    staleContext.className = "diff-line-row";
    staleContext.setAttribute("data-line-type", "context");
    staleContext.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
      '<code class="diff-text" data-diff-side="right">' +
      "displayed before the click" +
      "</code></td>";
    second.lines[0].row.before(staleContext);

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    replaceCurrentReactContextEvidenceRows(dom.window.document);

    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(replacement.lines, (line) => line.marked),
        [false, false, false],
      );
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("rejects same-row React evidence changed before an expansion click", async (t) => {
  for (const scenario of [
    {
      mutate(second) {
        const contextRow = second.groupRows.find(
          (row) => row.textContent.trim() === "before second",
        );
        contextRow.querySelector("code").textContent =
          "replaced context before the click";
      },
      name: "context text",
    },
    {
      mutate(second) {
        second.lines[0].element.querySelector("code").textContent =
          "+changed before the click";
      },
      name: "changed line text",
    },
    {
      mutate(_second, document) {
        insertCurrentReactBlankContextAfterSecondLine(document);
      },
      name: "blank context structure",
    },
    {
      mutate(second) {
        second.hunkCell.textContent =
          "@@ -10 +10 @@ replacedSecondScope()";
      },
      name: "hunk semantic header",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(
        currentReactContextEvidenceFixture(),
      );
      try {
        const [, second, third] = controllersFor(app);
        scenario.mutate(second, dom.window.document);

        assert.equal(
          app.hostContextExpansionControllersMatchDisplayedFile(
            second.filePath,
          ),
          false,
        );
        app.handleHostContextExpansionClick({
          isTrusted: true,
          target: third.hunkRow.querySelector(
            '[aria-label="Expand file down from line 12"]',
          ),
        });
        assert.equal(app.hostContextExpansionIntents.size, 0);
      } finally {
        stopExtensions({ app, dom });
      }
    });
  }
});

test("accepts line-number-only hunk movement before an expansion click", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    second.hunkCell.textContent = "@@ -110 +210 @@ second()";

    assert.equal(
      app.hostContextExpansionControllersMatchDisplayedFile(
        second.filePath,
      ),
      true,
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    assert.equal(app.hostContextExpansionIntents.size, 1);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("rejects unanchored line-number movement before an expansion click", async () => {
  const { app, dom } = await startExtension(
    currentReactOverlappingContextExpansionFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    second.hunkCell.textContent = "@@ -110 +210 @@ second()";

    assert.equal(
      app.hostContextExpansionControllersMatchDisplayedFile(
        second.filePath,
      ),
      false,
    );
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps stale hunk-header review state fail-closed through expansion", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

    second.hunkCell.textContent =
      "@@ -10 +10 @@ replacedSecondScope()";
    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: third.hunkRow.querySelector(
        '[aria-label="Expand file down from line 12"]',
      ),
    });
    assert.equal(app.hostContextExpansionIntents.size, 0);

    replaceCurrentReactContextEvidenceRows(dom.window.document);
    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(replacement.lines, (line) => line.marked),
        [false, false, false],
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

testRejectsClickedReactContextTransition({
  assertReplacement(replacement, storedContextFingerprint) {
    assert.notEqual(
      replacement.lines[1].contextFingerprint,
      storedContextFingerprint,
    );
  },
  fixture: currentReactContextEvidenceFixture,
  mutate(document) {
    replaceCurrentReactContextEvidenceRows(document);
    moveCurrentReactSecondContextAfterChangedLine(document);
  },
  name: "rejects a clicked React transition that moves context across a changed line",
});
testRejectsClickedReactContextTransition({
  fixture: currentReactBlankContextEvidenceFixture,
  mutate(document) {
    replaceCurrentReactContextEvidenceRows(document);
    insertCurrentReactBlankContextAfterSecondLine(document);
  },
  name: "rejects a clicked React transition that moves blank context across a changed line",
});
test("preserves a clicked React transition that keeps blank context ordered", async () => {
  const { app, chrome, dom } = await startExtension(
    currentReactBlankContextEvidenceFixture(),
  );
  try {
    const [, second, third] = controllersFor(app);
    changeCheckbox(dom, second.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[second.lines[0].key]);
    });

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
    replaceCurrentReactContextEvidenceRows(dom.window.document);
    const blankContext =
      insertCurrentReactBlankContextAfterSecondLine(dom.window.document);
    dom.window.document
      .querySelector('[data-line-anchor="diff-overlap-R10"]')
      .closest("tr")
      .before(blankContext);

    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.equal(app.controllersByRow.size, 1);
      assert.deepEqual(
        Array.from(replacement.lines, (line) => line.marked),
        [false, true, false],
      );
    });
    assert.equal(intent.phase, "observed");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("refreshes cached React context evidence when a reused hunk gains rows", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [, second] = controllersFor(app);
    const initialSnapshot = fileReviewSnapshotFor(app, second.filePath);
    const initialAnchors = initialSnapshot.hunks[1].contextAnchors;
    const initialAnchorCount = initialAnchors.length;
    const trailingContextRow = second.groupRows.find(
      (row) => row.textContent.trim() === "after second",
    );
    const insertedContextRow = dom.window.document.createElement("tr");
    insertedContextRow.className = "diff-line-row";
    insertedContextRow.setAttribute("data-line-type", "context");
    insertedContextRow.innerHTML =
      '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
      '<code class="diff-text" data-diff-side="right">new trailing context</code>' +
      "</td>";
    trailingContextRow.after(insertedContextRow);

    await waitFor(() => {
      const [, currentSecond] = controllersFor(app);
      assert.equal(currentSecond, second);
      assert.equal(currentSecond.groupRows.includes(insertedContextRow), true);
      const currentSnapshot = fileReviewSnapshotFor(app, second.filePath);
      assert.notEqual(
        currentSnapshot.hunks[1].contextAnchors,
        initialAnchors,
      );
      assert.equal(
        currentSnapshot.hunks[1].contextAnchors.length,
        initialAnchorCount + 1,
      );
    });

    const afterInsertion = fileReviewSnapshotFor(app, second.filePath);
    insertedContextRow.querySelector("code").textContent =
      "mutated trailing context";
    await waitFor(() => {
      const currentSnapshot = fileReviewSnapshotFor(app, second.filePath);
      assert.notEqual(
        currentSnapshot.hunks[1].contextAnchors,
        afterInsertion.hunks[1].contextAnchors,
      );
      assert.equal(
        currentSnapshot.hunks[1].contextAnchors.length,
        initialAnchorCount + 1,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("preserves reviewed lines for a standalone React trailing expansion", async () => {
  const html = currentReactContextExpansionFixture().replace(
    "</tbody></table>",
    `<tr class="diff-line-row">
       <td role="gridcell" class="diff-hunk-cell">
         <button class="Button ExpandableHunkHeaderDiffLine-module__expand-button-line__one" aria-label="Expand file down from line 10" data-direction="down" aria-hidden="true" tabindex="-1"><svg aria-hidden="true"></svg></button>
       </td>
     </tr></tbody></table>`,
  );
  const { app, chrome, dom } = await startExtension(html);
  try {
    const controller = controllersFor(app).find(
      (candidate) => candidate.filePath === "src/react-one.js",
    );
    const control = controller.fileElement.querySelector(
      '[aria-label="Expand file down from line 10"]',
    );
    const controlRow = control.closest("tr");
    assert.ok(controller);
    assert.ok(control);
    assert.equal(controlRow.textContent.trim(), "");
    assert.notEqual(controlRow, controller.hunkRow);
    assert.deepEqual(
      Array.from(
        app.hostContextExpansionControllersForControl(
          app.describeHostContextExpansionControl(control),
        ),
      ),
      [controller],
    );

    changeCheckbox(dom, controller.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[controller.lines[0].key]);
    });
    const previousFingerprint = controller.lines[0].contextFingerprint;

    app.handleHostContextExpansionClick({
      isTrusted: true,
      target: control,
    });
    const intent = contextExpansionIntentFor(app, "src/react-one.js");
    assert.ok(intent);
    assert.equal(intent.source.expandsWholeFile, false);
    assert.equal(intent.source.row, controller.hunkRow);

    const expandedContext = (text) => {
      const row = dom.window.document.createElement("tr");
      row.className = "diff-line-row";
      row.dataset.lineType = "context";
      row.innerHTML =
        '<td role="gridcell" class="diff-text-cell right-side-diff-cell">' +
        `<code class="diff-text"><div class="diff-text-inner">${text}</div></code>` +
        "</td>";
      return row;
    };
    controlRow.before(
      expandedContext("first trailing context line"),
      expandedContext("second trailing context line"),
    );
    controlRow.remove();

    await waitFor(() => {
      const current = controllersFor(app).find(
        (candidate) => candidate.filePath === "src/react-one.js",
      );
      assert.notEqual(current.lines[0].contextFingerprint, previousFingerprint);
      assert.equal(current.lines[0].marked, true);
      assert.equal(
        chrome.snapshot()[current.lines[0].key].contextFingerprint,
        current.lines[0].contextFingerprint,
      );
    });
  } finally {
    stopExtensions({ app, dom });
  }
});
