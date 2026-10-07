const {
  test,
  assert,
  path,
  JSDOM,
  Core,
  root,
  createDeferred,
  installContentStyles,
  delayReviewStorageRead,
  recordCachedDiscoveryRoots,
  controllersFor,
  controllerAt,
  fileReviewSnapshotFor,
  stopExtensions,
  officialViewedContext,
  changeCheckbox,
  lineControls,
  setOfficialViewed,
  waitFor,
  assertFileRevealState,
  startExtension,
  duplicateHunkFixture,
  largeChangedBlockFixture,
  commitSelectionFixture,
  initiallyViewedCommitSelectionFixture,
  loadDiffPlaceholderHtml,
  loadDiffFixture,
  hiddenLargeDiffFixture,
  nonHunkDiffFixture,
  splitFixture,
  currentReactContextEvidenceFixture,
  currentReactContextExpansionFixture,
  currentReactSplitContextExpansionFixture,
  contextualLineFixture,
} = require("./content-test-support.cjs");

function discoveryIdentity(hunks) {
  return Array.from(hunks ?? [], (hunk) => ({
    filePath: hunk.filePath,
    headerText: hunk.headerText,
    key: hunk.key,
    lines: Array.from(hunk.lines, (line) => ({
      contextFingerprint: line.contextFingerprint,
      key: line.key,
      kind: line.kind,
      layout: line.layout,
      legacyKey: line.legacyKey,
      side: line.side,
      text: line.text,
    })),
    officialSuppressionKey: hunk.officialSuppressionKey,
    sharedCompletionKey: hunk.sharedCompletionKey,
  }));
}

function persistedDiscoveryIdentity(hunks) {
  const storageSuffix = (key) =>
    key ? key.split(":").slice(-2).join(":") : null;
  return Array.from(hunks ?? [], (hunk) => ({
    filePath: hunk.filePath,
    key: storageSuffix(hunk.key),
    lines: Array.from(hunk.lines, (line) => ({
      contextFingerprint: line.contextFingerprint,
      key: storageSuffix(line.key),
      legacyKey: storageSuffix(line.legacyKey),
    })),
    officialSuppressionKey:
      hunk.officialSuppressionKey?.split(":").at(-1) ?? null,
    sharedCompletionKey: storageSuffix(hunk.sharedCompletionKey),
  }));
}

test("cached and cooperative discovery produce identical review identity", async () => {
  for (const fixture of [
    duplicateHunkFixture(),
    splitFixture(),
    currentReactContextEvidenceFixture(),
  ]) {
    const { app, dom } = await startExtension(fixture);
    try {
      app.constants = {
        ...app.constants,
        HUNK_DISCOVERY_ROW_CHUNK_SIZE: 1,
      };
      let cooperativeYields = 0;
      const yieldForDiscovery =
        app.yieldForHunkDiscoveryInteraction.bind(app);
      app.yieldForHunkDiscoveryInteraction = async (...args) => {
        cooperativeYields += 1;
        await yieldForDiscovery(...args);
      };
      app.Core.clearIdentifierCache();
      assert.equal(app.discoverCachedHunks(), null);
      const discovered = await app.discoverHunks();
      const cached = app.discoverCachedHunks();
      assert.ok(discovered);
      assert.ok(cached);
      assert.equal(Array.isArray(cached), true);
      assert.deepEqual(
        discoveryIdentity(cached),
        discoveryIdentity(discovered),
      );
      assert.equal(cooperativeYields > 0, true);
    } finally {
      app.stop();
      dom.window.close();
    }
  }
});

test("preserves persisted review identities from diff DOM", async () => {
  const cases = [
    [
      duplicateHunkFixture(),
      [
        {
          filePath: "src/example.js",
          key: "sD0lEl0sQtIAHROAVjmOh-0MUqwQFEBdfQ-POL_xTm0:0",
          lines: [{
            contextFingerprint: "Ead3Q6bXXygUfIOf0a_gi5YJ-ezTOkFbvseFyQ26n3c",
            key: "7DTNXpc-v83sPIqDQW-36YR2LhB_D1seFPSPu_Rjgb0:0",
            legacyKey: "ppl0P65PCVBvA87r9kcm9ZPbi8ngxTBrvbJRWDqNNfo:0",
          }],
          officialSuppressionKey: "gl_8IQ3nyiLF1nF9Irsh_Bs5mV4Qc1mPt_EdkFwMX8k",
          sharedCompletionKey: "5W8SwwhHSIsB7DClRRwY0wwwNxWrflF37ZkTAjcGSqE:0",
        },
        {
          filePath: "src/example.js",
          key: "sD0lEl0sQtIAHROAVjmOh-0MUqwQFEBdfQ-POL_xTm0:1",
          lines: [{
            contextFingerprint: "TepayJlLMftEQJxz3j-Fsi2pMsYxw995NYbwVgS8ICA",
            key: "7DTNXpc-v83sPIqDQW-36YR2LhB_D1seFPSPu_Rjgb0:1",
            legacyKey: "ppl0P65PCVBvA87r9kcm9ZPbi8ngxTBrvbJRWDqNNfo:1",
          }],
          officialSuppressionKey: "gl_8IQ3nyiLF1nF9Irsh_Bs5mV4Qc1mPt_EdkFwMX8k",
          sharedCompletionKey: "OxQ5PjKfEnwQaJDt7bHKSTm6AB3fzhrh0Oll0m2S930:1",
        },
      ],
    ],
    [
      contextualLineFixture(),
      [{
        filePath: "src/context.js",
        key: "XfgMAEcb0L2kPmL3KRwcPJj7j4PqJL_Pqtt9LeSkSII:0",
        lines: [{
          contextFingerprint: "Dcpd8bnZozJkxRJlI74EftGOSDwVyNgPLnLViMJ4dqY",
          key: "_rXYF_1_yHW5nBZNQ8_BaXIc9jcQvH-qBYHqKuZ3J7k:0",
          legacyKey: "D3xTtQPePsv-0xQFKGhKhVp2LtO3NdEM-ItfieX0_Lg:0",
        }],
        officialSuppressionKey: "fGImcgDLrbkrXnZHm_t6DCRo1kyQQ-7fBGUr6f2oZ8g",
        sharedCompletionKey: "gLAB9Hx3l2RSiUK8juoCF4sUTBHBa-yg2XskK5RGek4:0",
      }],
    ],
    [
      splitFixture(),
      [{
        filePath: "src/split.js",
        key: "0JRB8ZmU9y2z282yRmAIeM35eep1yRFNqrQyxOfYmH8:0",
        lines: [
          {
            contextFingerprint: "3_iEWTMkhcMtRKJNxluikt5wjduFlt62WZH0Ji5gaKk",
            key: "14NgT4Ab1xWH89Ynkyypd5fdcjQB-5armvU82DruCAQ:0",
            legacyKey: "PkAF2SVQNYt9UtzclnZmkTi76DNVuWEcMNlllsyLBAA:0",
          },
          {
            contextFingerprint: "pipmwaMq-8EyGfSxIoQmpNUC23uQ8X68LQS4H-1EWH4",
            key: "fr_DI6bOrI1TdNr2eKezo3G0VE46kDa3UsDvyGTlyo0:0",
            legacyKey: "fQ8_NCspofSOsDo2KtsvOG_6BAgCVCI11yCUGELrycY:0",
          },
        ],
        officialSuppressionKey: "GwCk8tDKS6thAxW3xSmac9bGoWlb1VmUsxs951pF5T8",
        sharedCompletionKey: "KK3Qv0rn8KRA7aQgXW0jmn06QCUWT0A-Z1LtpQByInQ:0",
      }],
    ],
  ];

  for (const [fixture, expected] of cases) {
    const { app, dom } = await startExtension(fixture);
    try {
      app.constants = {
        ...app.constants,
        HUNK_DISCOVERY_ROW_CHUNK_SIZE: 1,
      };
      assert.deepEqual(
        persistedDiscoveryIdentity(await app.discoverHunks()),
        expected,
      );
    } finally {
      app.stop();
      dom.window.close();
    }
  }
});

test("places per-file progress beside the file name", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileInfo = dom.window.document.querySelector(".file-info");
    await waitFor(() => {
      assert.match(
        fileInfo.querySelector(":scope > .hunkmark-file-progress").textContent,
        /Hunks 0\/2 · Lines 0\/2/,
      );
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    const progressKey = app.fileProgressStateKey(controller.filePath);
    const initialSnapshot = fileReviewSnapshotFor(app, controller.filePath);
    const controllers = Array.from(app.controllersByRow.values());
    assert.equal(initialSnapshot.hunks.length, controllers.length);
    assert.equal(
      initialSnapshot.hunks.every(
        (hunk, index) => hunk.key === controllers[index].key,
      ),
      true,
    );
    assert.deepEqual(
      Array.from(initialSnapshot.hunks, (hunk) =>
        Array.from(hunk.lines, (line) => line.contextFingerprint),
      ),
      controllers.map((candidate) =>
        Array.from(candidate.lines, (line) => line.contextFingerprint),
      ),
    );

    controller.lines[0].marked = true;
    app.updateAggregateFromLines(controller);
    app.updateProgress();

    const updatedProgress = app.fileProgressStateByKey.get(progressKey);
    assert.deepEqual(
      fileReviewSnapshotFor(app, controller.filePath),
      initialSnapshot,
    );
    assert.equal(updatedProgress.viewedLines, 1);
    assert.equal(
      dom.window.document.querySelector(
        ".file-header > .hunkmark-file-progress",
      ),
      null,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("resolves current GitHub file paths without presentation marks", async () => {
  const html = `<!doctype html>
    <html><body>
      <div role="region" id="diff-source" class="Diff-module__diff__source">
        <div class="Diff-module__diffHeaderWrapper__source">
          <div class="DiffFileHeader-module__diff-file-header__source">
            <h3><a href="#diff-source"><code>\u200esrc/source.js\u200e</code></a></h3>
          </div>
        </div>
        <table role="grid" aria-label="Diff for: src/source.js"><tbody>
          <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1 +1 @@</td></tr>
          <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="addition" data-diff-side="right">+source</code></td></tr>
        </tbody></table>
      </div>
      <div role="region" id="diff-root" class="Diff-module__diff__root">
        <div class="Diff-module__diffHeaderWrapper__root">
          <div class="DiffFileHeader-module__diff-file-header__root">
            <h3><a href="#diff-root"><code>\u200econtent.css\u200e</code></a></h3>
          </div>
        </div>
        <button>Load Diff</button>
      </div>
      <div role="region" id="diff-marked" class="Diff-module__diff__marked">
        <div class="Diff-module__diffHeaderWrapper__marked">
          <div class="DiffFileHeader-module__diff-file-header__marked">
            <h3><a href="#diff-marked"><code>\u200edir/\u200eodd.js\u200e\u200e</code></a></h3>
          </div>
        </div>
      </div>
    </body></html>`;
  const { app, dom } = await startExtension(html);
  try {
    const sourceFile = dom.window.document.getElementById("diff-source");
    const rootFile = dom.window.document.getElementById("diff-root");
    const markedFile = dom.window.document.getElementById("diff-marked");
    assert.equal(app.resolveFilePath(sourceFile, 0), "src/source.js");
    assert.equal(controllersFor(app)[0].filePath, "src/source.js");
    assert.equal(app.resolveFilePath(rootFile, 1), "content.css");
    assert.equal(
      app.resolveFilePath(markedFile, 2),
      "dir/\u200eodd.js\u200e",
    );

    app.rememberFileIdentity(rootFile, "unknown-file:diff-root");
    rootFile.insertAdjacentHTML(
      "beforeend",
      '<table role="grid" aria-label="Diff for: content.css"></table>',
    );
    assert.equal(app.resolveFilePath(rootFile, 1), "content.css");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("skips blank file-visibility labels before using fallbacks", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const label = dom.window.document.createElement("span");
    label.id = "file-visibility-label";
    label.textContent = "  Load Diff  ";
    const control = dom.window.document.createElement("button");
    control.setAttribute("aria-label", "   ");
    control.setAttribute("title", "\n\t");
    control.setAttribute("aria-labelledby", label.id);
    control.textContent = "  Show Diff  ";
    dom.window.document.body.append(label, control);

    assert.equal(app.fileVisibilityControlLabel(control), "Load Diff");

    control.removeAttribute("aria-labelledby");
    assert.equal(app.fileVisibilityControlLabel(control), "Show Diff");
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("resolves current GitHub extensionless root-file paths", async () => {
  const html = `<!doctype html>
    <html><body>
      <div role="region" id="diff-workspace" class="Diff-module__diff__workspace">
        <div class="Diff-module__diffHeaderWrapper__workspace">
          <div class="DiffFileHeader-module__diff-file-header__workspace">
            <h3><a href="#diff-workspace"><code>\u200eWORKSPACE\u200e</code></a></h3>
            <button class="js-expand-all-difflines-button" data-file-path="WORKSPACE" aria-label="Expand all lines: WORKSPACE">Expand lines</button>
          </div>
        </div>
        <table role="grid" aria-label="Diff for: WORKSPACE"><tbody>
          <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1 +1 @@</td></tr>
          <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="addition" data-diff-side="right">+workspace</code></td></tr>
        </tbody></table>
      </div>
    </body></html>`;
  const { app, dom } = await startExtension(html);
  try {
    const fileElement = dom.window.document.getElementById("diff-workspace");
    const control = fileElement.querySelector(
      '[aria-label="Expand all lines: WORKSPACE"]',
    );

    assert.equal(app.resolveFilePath(fileElement, 0), "WORKSPACE");
    assert.equal(controllersFor(app)[0].filePath, "WORKSPACE");
    assert.equal(app.knownFilePath(fileElement), "WORKSPACE");
    assert.equal(
      app.describeHostContextExpansionControl(control).filePath,
      "WORKSPACE",
    );
    control.removeAttribute("data-file-path");
    assert.equal(
      app.describeHostContextExpansionControl(control).filePath,
      "WORKSPACE",
    );

    const whitespaceFile = dom.window.document.createElement("section");
    whitespaceFile.setAttribute("data-file-path", " BUILD ");
    assert.equal(app.resolveFilePath(whitespaceFile, 1), " BUILD ");
    const whitespaceControl = dom.window.document.createElement("button");
    whitespaceControl.setAttribute("data-file-path", " BUILD ");
    assert.equal(
      app.describeHostContextExpansionControl(whitespaceControl).filePath,
      " BUILD ",
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("prefers the rendered grid path over a stale expansion control", async () => {
  const { app, dom } = await startExtension(
    currentReactContextEvidenceFixture(),
  );
  try {
    const [controller] = controllersFor(app);
    const fileElement = controller.fileElement;
    fileElement.querySelector("h3 code").textContent = "src/replaced.js";
    fileElement
      .querySelector('table[role="grid"]')
      .setAttribute("aria-label", "Diff for: src/replaced.js");

    assert.equal(
      fileElement.querySelector("[data-file-path]").dataset.filePath,
      "src/react-overlap.js",
    );
    assert.equal(app.resolveFilePath(fileElement, 0), "src/replaced.js");
    assert.equal(
      app.knownFilePath(fileElement),
      "src/replaced.js",
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("keeps a renamed file identity while its diff is hidden and revealed", async () => {
  const oldPath = "src/original.js";
  const newPath = "src/renamed.js";
  const renamedDescription = `${oldPath} renamed to ${newPath}`;
  const fixture = currentReactContextEvidenceFixture()
    .replaceAll("src/react-overlap.js", newPath)
    .replace(
      `${newPath}</code>`,
      `<span class="sr-only">${renamedDescription}</span></code>`,
    )
    .replace(`Diff for: ${newPath}`, `Diff for: ${renamedDescription}`);
  const { app, dom } = await startExtension(fixture);
  try {
    const [controller] = controllersFor(app);
    const fileElement = controller.fileElement;
    const grid = fileElement.querySelector('table[role="grid"]');
    const expandAll = fileElement.querySelector(
      ".js-expand-all-difflines-button",
    );
    const initialIdentity = discoveryIdentity(
      app.discoverCachedHunks(fileElement),
    );
    const progressKey = app.fileProgressStateKey(renamedDescription);
    const progress = app.fileProgressStateByKey.get(progressKey);
    const snapshot = app.fileReviewSnapshotsByKey.get(progressKey);

    assert.equal(controller.filePath, renamedDescription);
    assert.equal(expandAll.dataset.filePath, newPath);
    assert.equal(
      fileElement.querySelector("h3 code").textContent,
      renamedDescription,
    );
    assert.ok(initialIdentity.length > 0);
    assert.ok(progress);
    assert.ok(snapshot);

    grid.remove();
    const hiddenPath = app.resolveFilePath(fileElement, 0);
    assert.equal(hiddenPath, renamedDescription);
    assert.equal(app.knownFilePath(fileElement), renamedDescription);
    assert.equal(
      app.fileProgressStateByKey.get(app.fileProgressStateKey(hiddenPath)),
      progress,
    );
    assert.equal(
      app.fileReviewSnapshotsByKey.get(app.fileProgressStateKey(hiddenPath)),
      snapshot,
    );

    fileElement.append(grid);
    assert.equal(app.resolveFilePath(fileElement, 0), renamedDescription);
    assert.deepEqual(
      discoveryIdentity(app.discoverCachedHunks(fileElement)),
      initialIdentity,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

for (const scenario of [
  {
    name: "a literal path containing rename wording",
    gridPath: "src/a renamed to src/b.js",
    machinePath: "src/a renamed to src/b.js",
    replacementPath: "src/b.js",
  },
  {
    name: "a renamed destination containing rename wording",
    gridPath: "src/original.js renamed to src/b renamed to src/c.js",
    machinePath: "src/b renamed to src/c.js",
    replacementPath: "src/c.js",
  },
]) {
  test(`rejects changed hidden metadata for ${scenario.name}`, async () => {
    const fixture = currentReactContextEvidenceFixture()
      .replaceAll("src/react-overlap.js", scenario.machinePath)
      .replace(
        `${scenario.machinePath}</code>`,
        `<span class="sr-only">${scenario.gridPath}</span></code>`,
      )
      .replace(
        `Diff for: ${scenario.machinePath}`,
        `Diff for: ${scenario.gridPath}`,
      );
    const { app, dom } = await startExtension(fixture);
    try {
      const [controller] = controllersFor(app);
      const fileElement = controller.fileElement;
      const grid = fileElement.querySelector('table[role="grid"]');
      const expandAll = fileElement.querySelector(
        ".js-expand-all-difflines-button",
      );

      assert.equal(controller.filePath, scenario.gridPath);
      grid.remove();
      assert.equal(app.resolveFilePath(fileElement, 0), scenario.gridPath);

      expandAll.dataset.filePath = scenario.replacementPath;
      expandAll.setAttribute(
        "aria-label",
        `Expand all lines: ${scenario.replacementPath}`,
      );
      assert.equal(
        fileElement.querySelector("h3 code").textContent,
        scenario.gridPath,
      );
      assert.equal(
        app.resolveFilePath(fileElement, 0),
        scenario.replacementPath,
      );
      assert.equal(app.knownFilePath(fileElement), scenario.replacementPath);
    } finally {
      stopExtensions({ app, dom });
    }
  });
}

test("distinguishes stable presentation text from a reused React file", async () => {
  const fixture = currentReactContextEvidenceFixture().replace(
    "src/react-overlap.js</code>",
    "src/{old =&gt; new}/react-overlap.js</code>",
  );
  const { app, dom } = await startExtension(fixture);
  try {
    const [controller] = controllersFor(app);
    const fileElement = controller.fileElement;
    const grid = fileElement.querySelector('table[role="grid"]');
    grid.remove();

    assert.equal(
      app.resolveFilePath(fileElement, 0),
      "src/react-overlap.js",
    );
    fileElement.querySelector("h3 code").textContent = "NEWROOT";
    assert.equal(app.resolveFilePath(fileElement, 0), "NEWROOT");
  } finally {
    stopExtensions({ app, dom });
  }
});

test("tracks presentation identity after a pending Load Diff path", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><section id=outer><div id=nested role=region class=Diff-module__diff__nested></div></section></body></html>",
  );
  try {
    const outer = dom.window.document.getElementById("outer");
    const nested = dom.window.document.getElementById("nested");
    app.fileRevealPrepaintRestores.set(outer, {
      filePath: "src/pending-old.js",
    });
    assert.equal(
      app.resolveFilePath(nested, 0),
      "src/pending-old.js",
    );

    nested.innerHTML = `
      <div class="Diff-module__diffHeaderWrapper__nested">
        <div class="DiffFileHeader-module__diff-file-header__nested">
          <h3><a href="#diff-b"><code>src/b.js</code></a></h3>
        </div>
      </div>`;
    assert.equal(
      app.resolveFilePath(nested, 0),
      "src/pending-old.js",
    );
    nested.querySelector("code").textContent = "src/c.js";
    assert.equal(app.resolveFilePath(nested, 0), "src/c.js");
  } finally {
    app.fileRevealPrepaintRestores.clear();
    stopExtensions({ app, dom });
  }
});

test("keeps a current GitHub root-file identity after expansion controls disappear", async () => {
  const fileHtml = ({ includePathControl }) => `
    <div role="region" id="diff-root-file" class="Diff-module__diff__root-file">
      <div class="Diff-module__diffHeaderWrapper__root-file">
        <div class="DiffFileHeader-module__diff-file-header__root-file">
          <h3><a href="#diff-root-file"><code>\u200econtent.css\u200e</code></a></h3>
          ${
            includePathControl
              ? '<button data-file-path="content.css" aria-label="Expand all lines: content.css">Expand lines</button>'
              : ""
          }
        </div>
      </div>
      <table role="grid" aria-label="Diff for: content.css"><tbody>
        <tr class="diff-line-row"><td role="gridcell" class="diff-hunk-cell">@@ -1 +1 @@</td></tr>
        <tr class="diff-line-row" data-line-type="addition"><td role="gridcell" class="diff-text-cell right-side-diff-cell"><code class="addition" data-diff-side="right">+root</code></td></tr>
      </tbody></table>
    </div>`;
  const { app, chrome, dom } = await startExtension(
    `<!doctype html><html><body>${fileHtml({ includePathControl: true })}</body></html>`,
  );
  try {
    const [initial] = controllersFor(app);
    assert.equal(initial.filePath, "content.css");
    changeCheckbox(dom, initial.input);
    await waitFor(() => {
      assert.ok(chrome.snapshot()[initial.lines[0].key]);
    });

    const template = dom.window.document.createElement("template");
    template.innerHTML = fileHtml({ includePathControl: false });
    initial.fileElement.replaceWith(template.content.firstElementChild);

    await waitFor(() => {
      const [replacement] = controllersFor(app);
      assert.notEqual(replacement, initial);
      assert.equal(replacement.filePath, "content.css");
      assert.equal(replacement.lines[0].key, initial.lines[0].key);
      assert.equal(replacement.lines[0].marked, true);
    });
  } finally {
    stopExtensions({ app, dom });
  }
});

test("refreshes cached file contexts when review keys stay the same", async () => {
  const { app, dom } = await startExtension(contextualLineFixture());
  try {
    const [initialController] = controllersFor(app);
    const initialSnapshot = fileReviewSnapshotFor(
      app,
      initialController.filePath,
    );
    const initialContext = initialController.lines[0].contextFingerprint;

    dom.window.document.querySelector(".blob-code-context").textContent =
      "movedBefore();";

    let refreshedController;
    await waitFor(() => {
      [refreshedController] = controllersFor(app);
      assert.notEqual(refreshedController, initialController);
      assert.notEqual(
        refreshedController.lines[0].contextFingerprint,
        initialContext,
      );
    });

    const refreshedSnapshot = fileReviewSnapshotFor(
      app,
      refreshedController.filePath,
    );
    assert.equal(refreshedSnapshot.hunks[0].key, initialSnapshot.hunks[0].key);
    assert.notEqual(
      refreshedSnapshot.hunks[0].lines[0].contextFingerprint,
      initialSnapshot.hunks[0].lines[0].contextFingerprint,
    );
    assert.equal(
      refreshedSnapshot.hunks[0].lines[0].contextFingerprint,
      refreshedController.lines[0].contextFingerprint,
    );
  } finally {
    stopExtensions({ app, dom });
  }
});

test("boots on a pull request and isolates duplicate lines in separate hunks", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      const controls = lineControls(dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });

    const controls = lineControls(dom);
    const firstController = Array.from(app.controllersByRow.values())[0];
    controls[0].click();

    await waitFor(() => {
      assert.equal(controls[0].getAttribute("aria-pressed"), "true");
      assert.equal(controls[1].getAttribute("aria-pressed"), "false");
      assert.equal(firstController.marked, true);
      assert.equal(firstController.collapsed, true);
      assert.equal(
        Object.keys(chrome.snapshot()).filter((key) =>
          key.includes(":line:"),
        ).length,
        1,
      );
    });
    assert.equal(
      firstController.lines[0].element.classList.contains(
        "hunkmark-line-viewed",
      ),
      true,
    );
    assert.equal(
      firstController.lines[0].element.previousElementSibling.classList.contains(
        "hunkmark-line-viewed",
      ),
      false,
    );
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 1 \/ 2/,
    );

    const storedLineKeys = Object.keys(chrome.snapshot()).filter((key) =>
      key.includes(":line:"),
    );
    assert.equal(storedLineKeys.length, 1);
    assert.equal(
      chrome.snapshot()[firstController.collapsedKey].autoCollapsed,
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("batches new hunk host reads before controller DOM writes", async () => {
  const layoutEvents = [];
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    setupWindow(window) {
      const getComputedStyle = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element, pseudoElement) => {
        if (element.matches?.(".blob-code-hunk")) {
          layoutEvents.push("read");
        }
        return getComputedStyle(element, pseudoElement);
      };

      const append = window.Element.prototype.append;
      window.Element.prototype.append = function appendTracked(...nodes) {
        if (
          nodes.some((node) =>
            node.classList?.contains("hunkmark-hunk-actions"),
          )
        ) {
          layoutEvents.push("write");
        }
        return append.apply(this, nodes);
      };
    },
  });
  try {
    assert.deepEqual(layoutEvents, ["read", "read", "write", "write"]);
    assert.equal(app.controllersByRow.size, 2);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("yields queued page tasks within discovery of one huge file", async () => {
  // Cross multiple row chunks and the large-text/lazy-control thresholds.
  const lineCount = 768;
  let pageTaskRan = false;
  let schedulerYields = 0;
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(lineCount, 48),
    {},
    {
      setupWindow(window) {
        window.setTimeout(() => {
          pageTaskRan = true;
        }, 0);
        Object.defineProperty(window, "scheduler", {
          configurable: true,
          value: {
            async yield() {
              schedulerYields += 1;
            },
          },
        });
      },
      waitForScope: false,
    },
  );
  try {
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.controllersByRow.size, 1);
    }, 30_000);
    const controller = controllerAt(app, 0);
    assert.equal(controller.lines.length, lineCount);
    assert.equal(pageTaskRan, true);
    assert.equal(schedulerYields > 0, true);

    let discoveryYields = 0;
    let queuedDuringDiscovery = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      discoveryYields += 1;
      await yieldForDiscovery(...args);
    };
    dom.window.setTimeout(() => {
      queuedDuringDiscovery = true;
    }, 0);
    const discovered = await app.discoverHunks();
    assert.equal(discovered?.[0].lines.length, lineCount);
    assert.equal(discoveryYields > 0, true);
    assert.equal(queuedDuringDiscovery, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("cleans up the extension when test startup times out", async () => {
  let window;
  let closeCalls = 0;
  await assert.rejects(
    startExtension("<!doctype html><html><body></body></html>", {}, {
      scopeWaitTimeoutMs: 40,
      setupWindow(candidate) {
        window = candidate;
        const close = candidate.close.bind(candidate);
        candidate.close = () => {
          closeCalls += 1;
          close();
        };
      },
      url: "https://github.com/octo/repo",
    }),
    { name: "AssertionError" },
  );
  assert.equal(window.HunkMarkContent.activeApp.stopped, true);
  assert.equal(window.HunkMarkContent.activeApp.navigationPollTimer, null);
  assert.equal(closeCalls, 1);
});

test("aborts one-file discovery when a row changes after an internal yield", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(300, 48),
    {},
    { scopeWaitTimeoutMs: 10_000 },
  );
  try {
    let mutated = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      if (!mutated) {
        mutated = true;
        dom.window.document.querySelector(".blob-code-addition").textContent =
          "+changed-during-one-file-discovery";
      }
      await yieldForDiscovery(...args);
    };

    const discovered = await app.discoverHunks();

    assert.equal(mutated, true);
    assert.equal(discovered, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("aborts cooperative discovery when its caller becomes stale", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(300, 48),
    {},
    { scopeWaitTimeoutMs: 10_000 },
  );
  try {
    let current = true;
    let yielded = false;
    const yieldForDiscovery =
      app.yieldForHunkDiscoveryInteraction.bind(app);
    app.yieldForHunkDiscoveryInteraction = async (...args) => {
      await yieldForDiscovery(...args);
      yielded = true;
      current = false;
    };

    const discovered = await app.discoverHunks(app.document, {
      isCurrent: () => current,
    });

    assert.equal(yielded, true);
    assert.equal(discovered, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bounds hashing and defers line controls for a collapsed large block", async () => {
  const digestInputSizes = [];
  const first = await startExtension(
    largeChangedBlockFixture(),
    {},
    { digestInputSizes },
  );
  let stored;
  try {
    const controller = Array.from(first.app.controllersByRow.values())[0];
    assert.equal(controller.lines.length, 200);
    assert.equal(
      controller.lines.every(
        (line) =>
          line.control.tagName === "BUTTON" &&
          line.control.childElementCount === 0,
      ),
      true,
    );
    assert.equal(
      digestInputSizes.filter((size) => size > 10_000).length,
      3,
    );
    assert.equal(
      digestInputSizes.reduce((total, size) => total + size, 0) < 500_000,
      true,
    );
    changeCheckbox(first.dom, controller.input);
    await waitFor(() => {
      assert.equal(controller.collapsed, true);
      assert.equal(controller.input.disabled, false);
      assert.equal(
        Object.keys(first.chrome.snapshot()).filter((key) =>
          key.includes(":line:"),
        ).length,
        200,
      );
    });
    stored = first.chrome.snapshot();
  } finally {
    first.app.stop();
    first.dom.window.close();
  }

  const lineLayoutReads = [];
  const second = await startExtension(
    largeChangedBlockFixture(),
    stored,
    { lineLayoutReads },
  );
  try {
    const controller = Array.from(second.app.controllersByRow.values())[0];
    assert.equal(controller.collapsed, true);
    assert.equal(
      controller.lines.every((line) => line.control === null),
      true,
    );
    assert.equal(lineControls(second.dom).length, 0);
    assert.equal(lineLayoutReads.length, 0);

    let unchangedAppearanceUpdates = 0;
    const applyControllerAppearance =
      second.app.applyControllerAppearance.bind(second.app);
    second.app.applyControllerAppearance = (candidate) => {
      unchangedAppearanceUpdates += 1;
      return applyControllerAppearance(candidate);
    };
    await second.app.refresh();
    assert.equal(unchangedAppearanceUpdates, 0);
    assert.equal(lineLayoutReads.length, 0);

    controller.groupRows[1].classList.remove("hunkmark-collapsed");
    await second.app.refresh();
    assert.equal(unchangedAppearanceUpdates, 1);
    assert.equal(
      controller.groupRows[1].classList.contains("hunkmark-collapsed"),
      true,
    );
    assert.equal(lineLayoutReads.length, 0);

    controller.collapseButton.click();
    await waitFor(() => {
      assert.equal(controller.collapsed, false);
      assert.equal(lineControls(second.dom).length, 200);
      assert.equal(
        controller.lines.every(
          (line) => line.control?.disabled === false,
        ),
        true,
      );
    });
    assert.equal(lineLayoutReads.length, 200);

    const pendingControl = controller.lines[0].control;
    pendingControl.disabled = true;
    pendingControl.remove();
    await second.app.refresh();
    assert.notEqual(controller.lines[0].control, pendingControl);
    assert.equal(controller.lines[0].control.disabled, true);
    assert.equal(lineLayoutReads.length, 201);

    second.app.destroyController(controller);
    second.app.applyControllerAppearance(controller);
    assert.equal(lineControls(second.dom).length, 0);
  } finally {
    second.app.stop();
    second.dom.window.close();
  }
});

test("materializes line controls near the viewport when a large file is revealed", async () => {
  let observer;
  class TestIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      observer = this;
    }

    observe(element) {
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
    }

    intersect(elements) {
      this.callback(
        elements.map((target) => ({ isIntersecting: true, target })),
        this,
      );
    }
  }

  const fixture = largeChangedBlockFixture(600, 96, {
    hunkSize: 100,
  }).replace(
    '<span class="file-info">src/large.js</span>',
    '<span class="file-info">src/large.js</span><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>',
  );
  const cleanFixture = new JSDOM(fixture);
  const cleanTable =
    cleanFixture.window.document.querySelector("table").outerHTML;
  cleanFixture.window.close();
  const lineLayoutReads = [];
  const { app, dom } = await startExtension(fixture, {}, {
    intersectionObserverClass: TestIntersectionObserver,
    lineLayoutReads,
  });
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = fileElement.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    const controllers = Array.from(app.controllersByRow.values());

    assert.equal(controllers.length, 6);
    assert.equal(
      controllers.every((controller) => controller.lazyLineControls),
      true,
    );
    assert.equal(lineControls(dom).length, 0);
    assert.equal(lineLayoutReads.length, 0);
    const expectedObservedLines = controllers.reduce(
      (total, controller) =>
        total +
        Math.ceil(
          controller.lines.length /
            app.constants.LAZY_LINE_CONTROL_CHUNK_SIZE,
        ),
      0,
    );
    assert.equal(expectedObservedLines, 42);
    assert.equal(observer.observed.size, expectedObservedLines);

    const mutationAffectsDiff = app.mutationAffectsDiff.bind(app);
    let mutationClassifications = 0;
    app.mutationAffectsDiff = (...args) => {
      mutationClassifications += 1;
      return mutationAffectsDiff(...args);
    };

    officialControl.addEventListener("click", () => {
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

    officialControl.click();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(fileElement.querySelector("table"), null);
    });
    assert.equal(observer.observed.size, 0);
    assert.equal(mutationClassifications, 0);
    app.mutationAffectsDiff = mutationAffectsDiff;

    const findHunkMarkers = app.findHunkMarkers.bind(app);
    const discoverCachedHunks = app.discoverCachedHunks.bind(app);
    let cachedDiscoveryCalls = 0;
    app.discoverCachedHunks = (...args) => {
      cachedDiscoveryCalls += 1;
      return discoverCachedHunks(...args);
    };
    let synchronousHunkScans = 0;
    app.findHunkMarkers = (...args) => {
      synchronousHunkScans += 1;
      return findHunkMarkers(...args);
    };
    officialControl.click();
    assert.equal(synchronousHunkScans, 0);
    app.findHunkMarkers = findHunkMarkers;
    await Promise.resolve();
    assert.equal(cachedDiscoveryCalls, 0);
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    assert.equal(app.controllersByRow.size, 0);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 6);
      assert.equal(app.fileRevealPrepaintRestores.size, 0);
    });

    const restoredControllers = Array.from(app.controllersByRow.values());
    assert.equal(
      restoredControllers.every((controller) => controller.lazyLineControls),
      true,
    );
    assert.equal(lineControls(dom).length, 0);
    assert.equal(lineLayoutReads.length, 0);
    assert.equal(observer.observed.size, expectedObservedLines);

    const observedTarget = Array.from(observer.observed).at(-1);
    const observedLine = app.lineControllersByElement.get(observedTarget);
    const materializedLineCount = observedLine.lazyControlChunk.length;
    observer.intersect([observedTarget]);
    assert.equal(lineControls(dom).length, materializedLineCount);
    assert.equal(lineLayoutReads.length, materializedLineCount);
    assert.equal(observer.observed.size, expectedObservedLines - 1);

    const previousControl = observedLine.control;
    previousControl.remove();
    assert.equal(previousControl.isConnected, false);
    app.updateControllerRows(
      observedLine.controller,
      [...observedLine.controller.groupRows],
    );
    assert.equal(observer.observed.has(observedTarget), true);

    observer.intersect([observedTarget]);
    assert.notEqual(observedLine.control, previousControl);
    assert.equal(observedLine.control.isConnected, true);
    assert.equal(lineControls(dom).length, materializedLineCount);
    assert.equal(lineLayoutReads.length, materializedLineCount + 1);

    const progressKey = app.fileProgressStateKey(
      observedLine.controller.filePath,
    );
    const cachedProgress = app.fileProgressStateByKey.get(progressKey);
    const cachedReviewSnapshot = fileReviewSnapshotFor(
      app,
      observedLine.controller.filePath,
    );
    const storedReviewKey = cachedReviewSnapshot.hunks.at(-1).lines.at(-1).key;
    app.reviewStorageKeys.add(storedReviewKey);
    app.fileRevealPrepaintRestores.set(fileElement, {
      cachedProgress,
      cachedReviewSnapshot,
    });
    try {
      assert.equal(app.finishCleanCachedFileReveal(fileElement), false);
      assert.equal(app.fileRevealPrepaintRestores.has(fileElement), true);
    } finally {
      app.fileRevealPrepaintRestores.delete(fileElement);
      app.reviewStorageKeys.delete(storedReviewKey);
    }
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps newly materialized line controls disabled with their hunk", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const clearLineControls = () => {
      controller.lines.forEach((line) => {
        line.control?.remove();
        line.control = null;
      });
    };
    const assertLineControlsDisabled = () => {
      assert.equal(
        controller.lines.every((line) => line.control?.disabled === true),
        true,
      );
    };

    controller.input.disabled = true;
    clearLineControls();
    app.applyControllerAppearance(controller);
    assertLineControlsDisabled();

    clearLineControls();
    controller.lazyLineControls = true;
    controller.materializedLazyLines = new Set();
    app.observeLazyControllerLineControls(controller);
    assert.equal(controller.lazyLineControls, false);
    assertLineControlsDisabled();
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("links split diff sides and syncs GitHub's official Viewed control", async () => {
  const { app, dom } = await startExtension(splitFixture());
  try {
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-pressed", "true");
    });

    await waitFor(() => {
      const controls = lineControls(dom);
      assert.equal(controls.length, 2);
      assert.equal(controls[0].disabled, false);
    });
    const controls = lineControls(dom);
    controls[0].click();

    await waitFor(() => {
      assert.equal(controls[0].getAttribute("aria-pressed"), "true");
      assert.equal(controls[1].getAttribute("aria-pressed"), "true");
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps GitHub official Viewed sync off until explicitly enabled", async () => {
  const preferenceKey =
    `${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`;
  const { app, chrome, dom } = await startExtension(
    splitFixture(),
    { [preferenceKey]: false },
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
    const syncInput = dom.window.document.querySelector(
      'input[aria-label="Sync GitHub file Viewed"]',
    );

    assert.equal(app.syncOfficialViewedEnabled, false);
    assert.equal(syncInput.checked, false);

    const controls = Array.from(lineControls(dom));
    controls[0].click();
    await waitFor(() => {
      assert.equal(
        controls.every(
          (control) => control.getAttribute("aria-pressed") === "true",
        ),
        true,
      );
    });
    assert.equal(officialClicks, 0);
    assert.equal(officialControl.getAttribute("aria-pressed"), "false");

    changeCheckbox(dom, syncInput, true);
    await waitFor(() => {
      assert.equal(app.syncOfficialViewedEnabled, true);
      assert.equal(syncInput.disabled, false);
      assert.equal(chrome.snapshot()[preferenceKey], true);
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });

    changeCheckbox(dom, syncInput, false);
    await waitFor(() => {
      assert.equal(app.syncOfficialViewedEnabled, false);
      assert.equal(syncInput.disabled, false);
      assert.equal(chrome.snapshot()[preferenceKey], false);
    });
    assert.equal(officialClicks, 1);
    assert.equal(officialControl.getAttribute("aria-pressed"), "true");
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not redraw review controls for storage changes that preserve visible state", async () => {
  const { app, chrome, dom } = await startExtension(
    commitSelectionFixture(),
  );
  try {
    const { controller, key } = officialViewedContext(app);
    let appearanceUpdates = 0;
    let progressUpdates = 0;
    app.applyControllerAppearance = () => {
      appearanceUpdates += 1;
    };
    app.updateProgress = () => {
      progressUpdates += 1;
    };

    const updatedAt = Date.now();
    await chrome.api.storage.local.set({
      [key]: { suppressed: true, updatedAt },
    });
    const line = controller.lines[0];
    line.marked = true;
    app.updateAggregateFromLines(controller);
    await chrome.api.storage.local.set({
      [line.key]: app.lineReviewStorageValue(line, updatedAt),
    });

    assert.equal(app.officialViewedSyncSuppressed.has(key), true);
    assert.equal(line.marked, true);
    assert.equal(appearanceUpdates, 0);
    assert.equal(progressUpdates, 0);
  } finally {
    stopExtensions({ app, dom });
  }
});

test("defers discovery when a manual Viewed click hides the diff", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
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
    const filePath = app.resolveFilePath(fileElement, 0);
    const suppressionKey =
      await app.officialViewedSuppressionKey(filePath);
    const discoverCachedHunks = app.discoverCachedHunks.bind(app);
    let cachedDiscoveryCalls = 0;
    app.discoverCachedHunks = (...args) => {
      cachedDiscoveryCalls += 1;
      return discoverCachedHunks(...args);
    };
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
      fileElement.querySelector("table")?.remove();
    });

    officialControl.click();

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(
        dom.window.document.getElementById(app.constants.PANEL_ID),
        null,
      );
      assert.equal(
        app.officialViewedSyncSuppressed.has(suppressionKey),
        false,
      );
      assert.equal(suppressionKey in chrome.snapshot(), false);
    });
    assert.equal(scheduled[0]?.immediate, false);
    assert.equal(cachedDiscoveryCalls, 0);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not treat a disconnected reveal expectation as rendered", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    app.expectFileDiffVisibility(fileElement, true);
    fileElement.remove();

    const settled = app.consumeExpectedFileDiffVisibility();

    assert.equal(settled.changed, true);
    assert.equal(settled.revealed, false);
    assert.deepEqual(Array.from(settled.fileElements), [fileElement]);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("hides a cold-cache Viewed removal until review state is restored", async () => {
  const { app, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  const reviewRead = delayReviewStorageRead(app);
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const filePath = app.resolveFilePath(fileElement, 0);
    assert.equal(app.controllersByRow.size, 0);
    assert.equal(
      app.Core.cachedOfficialSyncSuppressionKey(
        app.officialViewedSuppressionScope(),
        filePath,
      ),
      null,
    );
    const scheduled = [];
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    app.scheduleRefresh = (options) => {
      scheduled.push(options ?? {});
      return scheduleRefresh(options);
    };
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const tableHtml =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    installContentStyles(dom);
    const officialControl = fileElement.querySelector(
      'button[aria-label="Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Not Viewed");
      officialControl.setAttribute("aria-pressed", "false");
      fileElement.insertAdjacentHTML("beforeend", tableHtml);
      fileElement.insertAdjacentHTML(
        "beforeend",
        "<button>Load more lines</button>",
      );
    });

    officialControl.click();
    await Promise.resolve();

    const table = fileElement.querySelector("table");
    assertFileRevealState(dom, fileElement, table, true);
    await reviewRead.started;
    assert.equal(app.controllersByRow.size, 2);
    assert.equal(dom.window.getComputedStyle(table).display, "none");

    reviewRead.release();

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.ok(
        dom.window.document.getElementById(app.constants.PANEL_ID),
      );
      assertFileRevealState(dom, fileElement, table, false);
    });
    await waitFor(() => assert.ok(scheduled.some((options) => options.immediate)));
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    reviewRead.release();
    app.stop();
    dom.window.close();
  }
});

test("shows a cold Viewed reveal before whole-page discovery completes", async () => {
  const { app, dom } = await startExtension(initiallyViewedCommitSelectionFixture());
  const wholePageStarted = createDeferred();
  const wholePageGate = createDeferred();
  const reviewRead = delayReviewStorageRead(app);
  try {
    installContentStyles(dom);
    const file = dom.window.document.querySelector(".js-file");
    const control = file.querySelector("button");
    const clean = new JSDOM(commitSelectionFixture());
    const tableHtml = clean.window.document.querySelector("table").outerHTML;
    clean.window.close();
    const discoveryRoots = [];
    const discover = app.discoverHunks.bind(app);
    app.discoverHunks = async (root, options) => {
      discoveryRoots.push(root);
      if (root === dom.window.document) {
        wholePageStarted.resolve();
        await wholePageGate.promise;
      }
      return discover(root, options);
    };
    control.addEventListener("click", () => {
      setOfficialViewed(control, false);
      file.insertAdjacentHTML("beforeend", tableHtml);
    });
    control.click();
    await waitFor(() => assert.equal(discoveryRoots.length, 1));
    assert.equal(discoveryRoots[0], file, "restore the opened file before scanning the page");
    await reviewRead.started;
    assertFileRevealState(dom, file, file.querySelector("table"), true);
    reviewRead.release();
    await wholePageStarted.promise;
    assertFileRevealState(dom, file, file.querySelector("table"), false);
    assert.equal(app.controllersByRow.size, 2);
    assert.ok(controllersFor(app).every((controller) => !controller.input.disabled));
    assert.equal(control.getAttribute("aria-pressed"), "false");
  } finally {
    reviewRead.release();
    wholePageGate.resolve();
    await waitFor(() => assert.equal(app.refreshRunning, false));
    stopExtensions({ app, dom });
  }
});

test("finishes complete cached Viewed reveals without scanning unaffected files", async (t) => {
  const cleanDom = new JSDOM(currentReactSplitContextExpansionFixture());
  const entry = cleanDom.window.document.querySelector('[data-testid]').innerHTML
    .replace('</h3>', '</h3><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>');
  const tableHtml = cleanDom.window.document.querySelector('table').outerHTML;
  cleanDom.window.close();
  const fixture = '<!doctype html><html><body><div data-testid="progressive-diffs-list">' +
    Array.from({ length: 32 }, (_, index) => entry.replaceAll('split', `split${index}`)).join('') +
    '</div></body></html>';
  for (const reviewed of [false, true]) {
    await t.test(reviewed ? 'reviewed and collapsed' : 'unreviewed', async () => {
      const { app, chrome, dom } = await startExtension(fixture, {
        [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
      }, { scopeWaitTimeoutMs: 10_000 });
      try {
        const originalControllers = controllersFor(app);
        const target = originalControllers[16];
        const file = target.fileElement;
        const control = file.querySelector('button[aria-pressed]');
        if (reviewed) await app.setHunkViewed(target, true);
        control.addEventListener('click', () => {
          const viewed = control.getAttribute('aria-pressed') !== 'true';
          setOfficialViewed(control, viewed);
          if (viewed) file.querySelector('table')?.remove();
          else file.insertAdjacentHTML('beforeend', tableHtml.replaceAll('split', 'split16'));
        });
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 31);
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
        });
        let fullRefreshes = 0;
        let globalProgressUpdates = 0;
        const discoveryRoots = [];
        const documentScans = [];
        const refresh = app.refresh.bind(app);
        const updateProgress = app.updateProgress.bind(app);
        const discoverHunks = app.discoverHunks.bind(app);
        const querySelectorAll = app.document.querySelectorAll.bind(app.document);
        app.refresh = (...args) => { fullRefreshes += 1; return refresh(...args); };
        app.updateProgress = (...args) => { globalProgressUpdates += 1; return updateProgress(...args); };
        app.discoverHunks = (root, ...args) => { discoveryRoots.push(root); return discoverHunks(root, ...args); };
        app.document.querySelectorAll = (selector) => {
          if ([app.constants.FILE_CONTAINER_SELECTOR, app.constants.ACTIVE_DIFF_LOADING_SELECTOR,
            '.hunkmark-file-progress'].includes(selector)) documentScans.push(selector);
          return querySelectorAll(selector);
        };
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 32);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
          assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
          assert.equal(app.officialViewedRestoreGuards.size, 0);
        });
        // Include the delayed authoritative-refresh and native-Viewed settlement
        // windows: neither should restart work after the complete file restore.
        await new Promise((resolve) => dom.window.setTimeout(resolve, 200));
        assert.equal(fullRefreshes, 0);
        assert.equal(globalProgressUpdates, 0);
        assert.deepEqual(discoveryRoots, []);
        assert.deepEqual(documentScans, []);
        const restored = controllersFor(app)[16];
        assert.equal(restored.fileElement, file);
        assert.equal(restored.marked, reviewed);
        assert.equal(restored.collapsed, reviewed);
        assert.deepEqual(controllersFor(app).map((controller) => controller.filePath),
          originalControllers.map((controller) => controller.filePath));
        originalControllers.forEach((controller, index) => {
          if (index !== 16) assert.equal(controllersFor(app)[index], controller);
        });
        assert.match(file.querySelector('.hunkmark-file-progress').textContent,
          reviewed ? /Hunks 1\/1.*Lines 2\/2/ : /Hunks 0\/1.*Lines 0\/2/);
        assert.match(dom.window.document.querySelector('.hunkmark-panel-summary').textContent,
          reviewed ? /Hunks 1 \/ 32.*Lines 2 \/ 64/ : /Hunks 0 \/ 32.*Lines 0 \/ 64/);
        restored.input.click();
        await waitFor(() => {
          assert.equal(restored.input.disabled, false);
          assert.equal(restored.collapsePending, false);
          restored.lines.forEach((line) => {
            assert.equal(Boolean(chrome.snapshot()[line.key]?.viewedAt), !reviewed);
          });
        });
        assert.equal(fullRefreshes, 0);
      } finally { app.stop(); dom.window.close(); }
    });
  }
});

test("reconciles cached Viewed reveals with partial or loading content", async (t) => {
  const fixture = largeChangedBlockFixture(4, 32, { hunkSize: 2 })
    .replace('</span>', '</span><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>');
  for (const partial of [true, false]) {
    await t.test(partial ? 'partial cached hunks' : 'active host loader', async () => {
      const clean = new JSDOM(fixture);
      const table = clean.window.document.querySelector('table');
      if (partial) Array.from(table.rows).slice(3).forEach((row) => row.remove());
      const tableHtml = table.outerHTML;
      clean.window.close();
      const { app, chrome, dom } = await startExtension(fixture, {
        [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
      });
      const held = createDeferred();
      try {
        const initial = controllersFor(app);
        for (const controller of initial) await app.setHunkViewed(controller, true);
        const file = initial[0].fileElement;
        const control = file.querySelector('button[aria-pressed]');
        control.addEventListener('click', () => {
          const viewed = control.getAttribute('aria-pressed') !== 'true';
          setOfficialViewed(control, viewed);
          if (viewed) file.querySelector('table')?.remove();
          else file.insertAdjacentHTML('beforeend', tableHtml + (partial ? '' :
            '<span data-component="Spinner">Loading</span>'));
        });
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 0);
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
        });
        const refresh = app.refresh.bind(app);
        let fullRefreshes = 0;
        app.refresh = async () => { fullRefreshes += 1; await held.promise; return refresh(); };
        control.click();
        await waitFor(() => {
          assert.ok(fullRefreshes > 0 || app.deferredDiffLoadRefreshes.size > 0);
        });
        assert.equal(app.officialViewedRestoreGuards.values().next().value?.cachedRestore, undefined);
        assert.equal(partial ? fullRefreshes > 0 : app.deferredDiffLoadRefreshes.size > 0, true);
        if (partial) {
          const controller = controllerAt(app);
          assert.equal(controller.input.disabled, true);
          assert.equal(app.reviewControllerIsSuspended(controller), true);
          const stored = chrome.snapshot();
          controller.input.disabled = false;
          controller.input.click();
          await Promise.resolve();
          assert.equal(controller.input.disabled, true);
          assert.deepEqual(chrome.snapshot(), stored);
        }
      } finally { held.resolve(); app.stop(); dom.window.close(); }
    });
  }
});

test("reconciles known cached identities when an unreviewed reveal changes content", async (t) => {
  const fixture = contextualLineFixture({ officialControl: true });
  const clean = new JSDOM(fixture);
  const originalTable = clean.window.document.querySelector("table").outerHTML;
  clean.window.close();
  const variants = [
    { name: "changed line key", from: "+return true;", to: "+return false;" },
    { name: "changed context fingerprint", from: "before();", to: "differentContext();" },
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const { app, chrome, dom } = await startExtension(fixture, {
        [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
      });
      const held = createDeferred();
      try {
        const initial = controllerAt(app);
        const originalIdentity = initial.lines[0];
        const file = initial.fileElement;
        const control = file.querySelector('button[aria-pressed]');
        const changedTable = originalTable.replace(variant.from, variant.to);
        control.addEventListener("click", () => {
          const viewed = control.getAttribute("aria-pressed") !== "true";
          setOfficialViewed(control, viewed);
          if (viewed) file.querySelector("table")?.remove();
          else file.insertAdjacentHTML("beforeend", changedTable);
        });
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 0);
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
        });

        // Identifiers may already be cached from an earlier discovery. Warm
        // this variant without replacing the captured file review snapshot.
        app.observer.disconnect();
        file.insertAdjacentHTML("beforeend", changedTable);
        const knownVariant = await app.discoverHunks(file);
        assert.ok(app.discoverCachedHunks(file));
        assert.equal(knownVariant.length, 1);
        assert.equal(knownVariant[0].lines.length, 1);
        if (variant.name === "changed context fingerprint") {
          assert.equal(knownVariant[0].lines[0].key, originalIdentity.key);
          assert.notEqual(knownVariant[0].lines[0].contextFingerprint,
            originalIdentity.contextFingerprint);
        } else {
          assert.notEqual(knownVariant[0].lines[0].key, originalIdentity.key);
        }
        file.querySelector("table").remove();
        app.observer.observe(app.document.documentElement, {
          childList: true,
          subtree: true,
        });
        const reconcile = app.reconcileNewReviewControllers.bind(app);
        app.reconcileNewReviewControllers = async (options) => {
          await held.promise;
          return reconcile(options);
        };
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 1);
          assert.equal(controllerAt(app).reviewStateRestoring, true);
        });
        controllersFor(app).forEach((controller) => {
          assert.equal(controller.input.disabled, true);
          assert.equal(app.reviewControllerIsSuspended(controller), true);
          controller.input.disabled = false;
          controller.input.click();
        });
        await Promise.resolve();
        assert.equal(Boolean(chrome.snapshot()[knownVariant[0].lines[0].key]), false);
        held.resolve();
        await waitFor(() => {
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.diffLoadHydrationRunningStates.size, 0);
          assert.equal(app.controllersByRow.size, 1);
          assert.equal(controllerAt(app).input.disabled, false);
          assert.equal(controllerAt(app).marked, false);
        });
      } finally { held.resolve(); app.stop(); dom.window.close(); }
    });
  }
});

test("reconciles a newer semantic mutation before late Viewed settlement", async () => {
  const fixture = currentReactSplitContextExpansionFixture()
    .replace('</h3>', '</h3><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>');
  const clean = new JSDOM(fixture);
  const tableHtml = clean.window.document.querySelector('table').outerHTML;
  clean.window.close();
  const { app, dom } = await startExtension(fixture, {
    [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
  });
  const held = createDeferred();
  try {
    const initial = controllerAt(app);
    await app.setHunkViewed(initial, true);
    const file = initial.fileElement;
    const control = file.querySelector('button[aria-pressed]');
    control.addEventListener('click', () => {
      const viewed = control.getAttribute('aria-pressed') !== 'true';
      setOfficialViewed(control, viewed);
      if (viewed) file.querySelector('table')?.remove();
      else {
        control.setAttribute('aria-busy', 'true');
        file.insertAdjacentHTML('beforeend', tableHtml);
      }
    });
    control.click();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
    });
    control.click();
    await waitFor(() => {
      assert.ok(app.officialViewedRestoreGuards.get(initial.officialSuppressionKey)?.cachedRestore);
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(app.refreshRunning || app.refreshQueued, false);
    });
    const restored = controllerAt(app);
    const refresh = app.refresh.bind(app);
    const scheduleRefresh = app.scheduleRefresh.bind(app);
    let refreshSchedules = 0;
    app.refresh = async () => { await held.promise; return refresh(); };
    app.scheduleRefresh = (...args) => { refreshSchedules += 1; return scheduleRefresh(...args); };
    file.querySelector('.right-side-diff-cell .diff-text-inner').textContent = 'new identity';
    await Promise.resolve();
    assert.equal(restored.input.disabled, true);
    assert.equal(app.reviewControllerIsSuspended(restored), true);
    const beforeSettlement = refreshSchedules;
    control.setAttribute('aria-busy', 'false');
    await waitFor(() => {
      assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
      assert.ok(refreshSchedules > beforeSettlement);
    });
    held.resolve();
    await waitFor(() => {
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.notEqual(controllerAt(app), restored);
      assert.equal(controllerAt(app).marked, false);
      assert.equal(controllerAt(app).input.disabled, false);
    });
  } finally { held.resolve(); app.stop(); dom.window.close(); }
});

test("restores cached Viewed reveals before the full refresh completes", async (t) => {
  const fixtures = [
    {
      name: "legacy",
      html: largeChangedBlockFixture(4, 32, { hunkSize: 2 }).replace(
        '<span class="file-info">src/large.js</span>',
        '<span class="file-info">src/large.js</span><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>',
      ),
      changedText: "line-0000",
    },
    {
      name: "React split",
      html: currentReactSplitContextExpansionFixture().replace(
        "</h3>",
        '</h3><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>',
      ),
      changedText: "newValue",
    },
  ];
  const states = [
    { name: "unreviewed" },
    { name: "partly reviewed", partial: true },
    { name: "reviewed and collapsed", viewed: true },
    { name: "changed identity", viewed: true, changed: true },
  ];

  for (const fixture of fixtures) {
    for (const state of states) {
      await t.test(`${fixture.name}: ${state.name}`, async () => {
        const cleanDom = new JSDOM(fixture.html);
        const tableHtml =
          cleanDom.window.document.querySelector("table").outerHTML;
        cleanDom.window.close();
        const { app, chrome, dom } = await startExtension(fixture.html, {
          [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
        });
        const refreshHeld = createDeferred();
        try {
          installContentStyles(dom);
          const initial = controllersFor(app);
          const fileElement = initial[0].fileElement;
          const control = fileElement.querySelector('button[aria-pressed]');
          if (state.viewed) {
            await app.setHunkViewed(initial[0], true);
          } else if (state.partial) {
            await app.setLineViewed(initial[0].lines[0], true);
          }
          const expected = initial.map((controller) => ({
            marked: controller.marked,
            collapsed: controller.collapsed,
            lines: controller.lines.map((line) => line.marked),
          }));
          control.addEventListener("click", () => {
            const viewed = control.getAttribute("aria-pressed") !== "true";
            setOfficialViewed(control, viewed);
            if (viewed) {
              fileElement.querySelector("table")?.remove();
            } else {
              fileElement.insertAdjacentHTML(
                "beforeend",
                state.changed
                  ? tableHtml.replace(fixture.changedText, "changedIdentity")
                  : tableHtml,
              );
            }
          });
          control.click();
          await waitFor(() => {
            assert.equal(app.controllersByRow.size, 0);
            assert.equal(app.refreshRunning, false);
            assert.equal(app.refreshQueued, false);
            assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
          });

          const refresh = app.refresh.bind(app);
          app.refresh = async () => {
            await refreshHeld.promise;
            return refresh();
          };
          control.click();
          await Promise.resolve();

          const table = fileElement.querySelector("table");
          assertFileRevealState(dom, fileElement, table, Boolean(state.changed));
          if (state.changed) {
            assert.equal(app.controllersByRow.size, 0);
          } else {
            assert.equal(app.fileRevealRestorePending.size, 0);
            assert.equal(app.diffMutationSuspendedControllers.size, 0);
            assert.equal(
              controllersFor(app).every((controller) =>
                !controller.input.disabled &&
                !controller.collapseButton.disabled &&
                controller.lines.every((line) => !line.control?.disabled),
              ),
              true,
            );
            assert.deepEqual(
              controllersFor(app).map((controller) => ({
                marked: controller.marked,
                collapsed: controller.collapsed,
                lines: controller.lines.map((line) => line.marked),
              })),
              expected,
            );
            if (state.name === "unreviewed") {
              // The global refresh is still held: the restored control must
              // accept and persist a real hunk interaction on its own.
              const controller = controllerAt(app);
              controller.input.click();
              assert.equal(controller.marked, true);
              await waitFor(() => {
                assert.equal(controller.input.disabled, false);
                assert.equal(controller.collapsePending, false);
                const stored = chrome.snapshot();
                controller.lines.forEach((line) => {
                  assert.ok(stored[line.key]?.viewedAt);
                });
              });
              expected[0] = {
                marked: true,
                collapsed: true,
                lines: controller.lines.map(() => true),
              };
            }
          }

          refreshHeld.resolve();
          await waitFor(() => {
            assert.equal(app.refreshRunning, false);
            assert.equal(app.refreshQueued, false);
            assert.equal(app.controllersByRow.size, initial.length);
            assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
            assertFileRevealState(dom, fileElement, table, false);
          });
          assert.equal(app.fileRevealRestorePending.size, 0);
          assert.equal(app.diffMutationSuspendedControllers.size, 0);
          assert.equal(
            controllersFor(app).every((controller) => !controller.input.disabled),
            true,
          );
          if (state.changed) {
            assert.equal(controllerAt(app).marked, false);
            assert.equal(controllerAt(app).collapsed, false);
          } else {
            assert.deepEqual(
              controllersFor(app).map((controller) => ({
                marked: controller.marked,
                collapsed: controller.collapsed,
                lines: controller.lines.map((line) => line.marked),
              })),
              expected,
            );
          }
        } finally {
          refreshHeld.resolve();
          app.stop();
          dom.window.close();
        }
      });
    }
  }
});

test("keeps a cached reveal usable while another file needs reconciliation", async () => {
  const html = currentReactContextExpansionFixture().replace(
    "</h3>",
    '</h3><button aria-label="Not Viewed" aria-pressed="false">Viewed</button>',
  );
  const cleanDom = new JSDOM(html);
  const tableHtml = cleanDom.window.document.querySelector("table").outerHTML;
  cleanDom.window.close();
  const { app, chrome, dom } = await startExtension(html, {
    [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
  });
  const refreshHeld = createDeferred();
  try {
    const initial = controllersFor(app);
    const firstFile = initial[0].fileElement;
    const second = initial[1];
    const staleLineKey = second.lines[0].key;
    const control = firstFile.querySelector('button[aria-pressed]');
    control.addEventListener("click", () => {
      const viewed = control.getAttribute("aria-pressed") !== "true";
      setOfficialViewed(control, viewed);
      if (viewed) {
        firstFile.querySelector("table")?.remove();
      } else {
        firstFile.insertAdjacentHTML("beforeend", tableHtml);
        second.lines[0].element.querySelector("code").textContent =
          "+changed alongside the reveal";
      }
    });
    control.click();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.officialViewedStorageIntentGenerationByKey.size, 0);
    });

    const refresh = app.refresh.bind(app);
    app.refresh = async () => {
      await refreshHeld.promise;
      return refresh();
    };
    control.click();
    await Promise.resolve();
    const restored = controllersFor(app).find((controller) =>
      controller.fileElement === firstFile,
    );
    assert.ok(restored);
    assert.equal(app.reviewControllerIsSuspended(restored), false);
    assert.equal(restored.input.disabled, false);
    assert.equal(app.reviewControllerIsSuspended(second), true);
    assert.equal(second.input.disabled, true);
    second.input.click();
    assert.equal(staleLineKey in chrome.snapshot(), false);

    restored.input.click();
    assert.equal(restored.marked, true);
    await waitFor(() => {
      assert.equal(restored.input.disabled, false);
      assert.ok(chrome.snapshot()[restored.lines[0].key]?.viewedAt);
    });
    refreshHeld.resolve();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(app.diffMutationSuspendedControllers.size, 0);
      assert.equal(app.controllersByRow.size, 2);
    });
    assert.equal(restored.marked, true);
    assert.equal(staleLineKey in chrome.snapshot(), false);
  } finally {
    refreshHeld.resolve();
    app.stop();
    dom.window.close();
  }
});

test("keeps changed identities locked after a clean paint-only reveal", async () => {
  const html = currentReactSplitContextExpansionFixture().replace(
    "</h3>",
    '</h3><button aria-label="Expand file">Expand</button>',
  );
  const { app, chrome, dom } = await startExtension(html);
  try {
    const controller = controllerAt(app);
    const table = controller.fileElement.querySelector("table");
    const control = controller.fileElement.querySelector('[aria-label="Expand file"]');
    const staleLine = controller.lines[0];
    table.hidden = true;
    app.constants = {
      ...app.constants,
      LAZY_LINE_CONTROL_FILE_LINE_THRESHOLD: 1,
    };
    app.scheduleRefresh = () => {};
    let paintedCleanReveal = false;
    const finishCleanReveal = app.finishCleanCachedFileReveal.bind(app);
    app.finishCleanCachedFileReveal = (...args) => {
      const result = finishCleanReveal(...args);
      paintedCleanReveal ||= result;
      return result;
    };
    control.addEventListener("click", () => {
      control.setAttribute("aria-label", "Collapse file");
      table.hidden = false;
      staleLine.element.querySelector(".diff-text-inner").textContent = "changed identity";
    });
    control.click();
    await Promise.resolve();

    assert.equal(paintedCleanReveal, true);
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    assert.equal(app.reviewControllerIsSuspended(controller), true);
    assert.equal(controller.input.disabled, true);
    controller.input.disabled = false;
    controller.input.click();
    await Promise.resolve();
    assert.equal(controller.marked, false);
    assert.equal(staleLine.key in chrome.snapshot(), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not hide an already-rendered diff when Viewed is removed", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = fileElement.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.setAttribute("aria-label", "Viewed");
    officialControl.setAttribute("aria-pressed", "true");
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Not Viewed");
      officialControl.setAttribute("aria-pressed", "false");
    });

    officialControl.click();

    assert.equal(app.controllersByRow.size, 2);
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    assert.equal(
      fileElement.classList.contains("hunkmark-file-reveal-restoring"),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("releases a ready loaded diff inside GitHub's persistent load container", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  const reviewRead = delayReviewStorageRead(app);
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    installContentStyles(dom);
    const loadedFixture = new JSDOM(
      loadDiffFixture({ loaded: true }),
    );
    const loadedFileHtml =
      loadedFixture.window.document.querySelector(".js-file").outerHTML;
    loadedFixture.window.close();
    const cachedDiscoveryRoots = recordCachedDiscoveryRoots(app);
    const loadButton = fileElement.querySelector("button");
    loadButton.addEventListener("click", () => {
      loadButton.insertAdjacentHTML(
        "beforebegin",
        '<span data-component="loadingSpinner"><span data-component="Spinner">Loading</span></span>',
      );
      loadButton.remove();
      dom.window.setTimeout(() => {
        const replacementTemplate = dom.window.document.createElement(
          "template",
        );
        replacementTemplate.innerHTML = loadedFileHtml;
        fileElement.replaceWith(replacementTemplate.content.firstElementChild);
      }, 0);
    });

    loadButton.click();

    const officialLoader = fileElement.querySelector(
      '[data-component="Spinner"]',
    );
    const loadingSkeleton = fileElement.querySelector(".loading-skeleton");
    const loadingMessage = fileElement.querySelector(".load-diff-message");
    assert.equal(
      dom.window.getComputedStyle(officialLoader).display === "none",
      false,
    );
    assert.equal(
      dom.window.getComputedStyle(loadingSkeleton).display === "none",
      false,
    );
    assert.equal(
      dom.window.getComputedStyle(loadingMessage).display === "none",
      false,
    );
    let replacementFileElement;
    await waitFor(() => {
      replacementFileElement = dom.window.document.querySelector(".js-file");
      assert.notEqual(replacementFileElement, fileElement);
      const table = replacementFileElement.querySelector("table");
      const preservedLoader = replacementFileElement.querySelector(
        '[data-component="Spinner"]',
      );
      assert.ok(preservedLoader);
      assertFileRevealState(
        dom,
        replacementFileElement,
        table.closest(".diff-body"),
        true,
      );
      assert.equal(
        dom.window.getComputedStyle(preservedLoader).display === "none",
        false,
      );
    });
    await reviewRead.started;
    assert.equal(app.controllersByRow.size, 1);
    // GitHub's replacement can introduce a different nested file container,
    // causing discovery to resolve a different fallback path for the same row.
    Array.from(app.controllersByRow.values())[0].filePath =
      "unknown-file:replacement";
    assert.equal(
      replacementFileElement.classList.contains(
        "hunkmark-file-reveal-restoring",
      ),
      true,
    );
    assert.equal(cachedDiscoveryRoots.length, 0);

    reviewRead.release();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        false,
      );
      assert.equal(
        replacementFileElement.querySelector(
          '[data-hunkmark-ui="file-reveal-loading"]',
        ),
        null,
      );
      assert.equal(app.fileRevealRestorePending.size, 0);
    });
  } finally {
    reviewRead.release();
    app.stop();
    dom.window.close();
  }
});

for (const scenario of [
  {
    name: "keeps a loaded diff guarded while cached content is still missing",
    seedProgress(app, fileElement) {
      const filePath = app.resolveFilePath(fileElement, 0);
      app.fileProgressStateByKey.set(app.fileProgressStateKey(filePath), {
        hunks: 2,
        lines: 2,
      });
    },
  },
  {
    name: "keeps an actively loading partial diff guarded without cached progress",
    seedProgress() {},
  },
]) {
  test(scenario.name, async () => {
    const { app, dom } = await startExtension(loadDiffFixture());
    try {
      const fileElement = dom.window.document.querySelector(".js-file");
      scenario.seedProgress(app, fileElement);
      installContentStyles(dom);
      const loadedFixture = new JSDOM(
        loadDiffFixture({ activeLoading: true, loaded: true }),
      );
      const loadedFileHtml =
        loadedFixture.window.document.querySelector(".js-file").outerHTML;
      loadedFixture.window.close();
      const loadButton = fileElement.querySelector("button");
      loadButton.addEventListener("click", () => {
        dom.window.setTimeout(() => {
          const replacementTemplate = dom.window.document.createElement(
            "template",
          );
          replacementTemplate.innerHTML = loadedFileHtml;
          fileElement.replaceWith(
            replacementTemplate.content.firstElementChild,
          );
        }, 0);
      });

      loadButton.click();

      let replacementFileElement;
      await waitFor(() => {
        replacementFileElement = dom.window.document.querySelector(".js-file");
        assert.notEqual(replacementFileElement, fileElement);
        assert.equal(app.controllersByRow.size, 0);
        assertFileRevealState(
          dom,
          replacementFileElement,
          replacementFileElement.querySelector(".diff-body"),
          true,
        );
      });

      replacementFileElement
        .querySelector('[data-component="loadingSpinner"]')
        .remove();
      await waitFor(() => {
        assert.equal(app.controllersByRow.size, 1);
        assertFileRevealState(
          dom,
          replacementFileElement,
          replacementFileElement.querySelector(".diff-body"),
          false,
        );
      });
    } finally {
      app.stop();
      dom.window.close();
    }
  });
}

test("keeps a current React diff-region skeleton guarded without a spinner", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    installContentStyles(dom);
    const loadedFixture = new JSDOM(
      loadDiffFixture({ loaded: true, reactRegionLoading: true }),
    );
    const loadedFileHtml =
      loadedFixture.window.document.querySelector(".js-file").outerHTML;
    loadedFixture.window.close();
    const loadButton = fileElement.querySelector("button");
    loadButton.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        const replacementTemplate = dom.window.document.createElement(
          "template",
        );
        replacementTemplate.innerHTML = loadedFileHtml;
        fileElement.replaceWith(replacementTemplate.content.firstElementChild);
      }, 0);
    });

    loadButton.click();
    const pendingRestore = app.fileRevealPrepaintRestores.get(fileElement);
    const originalLoadingStateObserver =
      pendingRestore.loadingStateAttributeObserver;
    assert.ok(originalLoadingStateObserver);

    let replacementFileElement;
    await waitFor(() => {
      replacementFileElement = dom.window.document.querySelector(".js-file");
      assert.notEqual(replacementFileElement, fileElement);
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(
        app.fileDiffHasActiveLoadingContent(replacementFileElement),
        true,
      );
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        true,
      );
    });
    assert.equal(
      app.fileRevealPrepaintRestores.get(replacementFileElement),
      pendingRestore,
    );
    assert.notEqual(
      pendingRestore.loadingStateAttributeObserver,
      originalLoadingStateObserver,
    );
    fileElement.setAttribute("aria-label", "Loading stale replacement");
    assert.equal(originalLoadingStateObserver.takeRecords().length, 0);

    replacementFileElement.removeAttribute("aria-label");
    assert.equal(
      app.fileDiffHasActiveLoadingContent(replacementFileElement),
      false,
    );
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        false,
      );
      assert.equal(app.fileRevealPrepaintRestores.size, 0);
      assert.equal(pendingRestore.loadingStateAttributeObserver, null);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("releases a loaded diff that retains a static Load more control", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    installContentStyles(dom);
    const loadedFixture = new JSDOM(
      loadDiffFixture({ loaded: true, staticLoadMore: true }),
    );
    const loadedFileHtml =
      loadedFixture.window.document.querySelector(".js-file").outerHTML;
    loadedFixture.window.close();
    const loadButton = fileElement.querySelector("button");
    loadButton.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        const replacementTemplate = dom.window.document.createElement(
          "template",
        );
        replacementTemplate.innerHTML = loadedFileHtml;
        fileElement.replaceWith(replacementTemplate.content.firstElementChild);
      }, 0);
    });

    loadButton.click();

    await waitFor(() => {
      const replacementFileElement =
        dom.window.document.querySelector(".js-file");
      assert.notEqual(replacementFileElement, fileElement);
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(
        app.fileDiffHasUnresolvedContent(replacementFileElement),
        true,
      );
      assert.equal(
        app.fileDiffHasActiveLoadingContent(replacementFileElement),
        false,
      );
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        false,
      );
      assert.equal(app.fileRevealRestorePending.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves cached review identity across a nested Load Diff replacement", async () => {
  const { app, dom } = await startExtension(
    loadDiffFixture({ loaded: true }),
  );
  try {
    installContentStyles(dom);
    const originalController = controllerAt(app);
    const originalFilePath = originalController.filePath;
    const originalKey = originalController.key;
    changeCheckbox(dom, originalController.input, true);
    await waitFor(() => {
      assert.equal(originalController.marked, true);
      assert.equal(
        originalController.lines.every((line) =>
          app.reviewStorageKeys.has(line.key),
        ),
        true,
      );
    });

    const fileElement = dom.window.document.querySelector(".js-file");
    const diffBody = fileElement.querySelector(".diff-body");
    diffBody.innerHTML = loadDiffPlaceholderHtml();
    await waitFor(() => assert.equal(app.controllersByRow.size, 0));

    const loadButton = diffBody.querySelector("button");
    loadButton.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        diffBody.innerHTML = `<div data-testid="diff-file-replacement">
          <table><tbody>
            <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
            <tr><td class="blob-num">1</td><td class="blob-code-addition">+loaded</td></tr>
          </tbody></table>
        </div>`;
      }, 0);
    });

    loadButton.click();

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const replacementController = controllerAt(app);
      assert.equal(replacementController.input.disabled, false);
      assert.equal(replacementController.filePath, originalFilePath);
      assert.equal(replacementController.key, originalKey);
      assert.equal(replacementController.marked, true);
      assert.equal(app.fileRevealPrepaintRestores.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("releases stable non-hunk content after Load Diff resolves", async () => {
  const { app, dom } = await startExtension(loadDiffFixture());
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const loadButton = fileElement.querySelector("button");
    installContentStyles(dom);
    const loadedFixture = new JSDOM(
      loadDiffFixture({ loaded: true, nonHunk: true }),
    );
    const loadedFileHtml =
      loadedFixture.window.document.querySelector(".js-file").outerHTML;
    loadedFixture.window.close();
    loadButton.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        const replacementTemplate = dom.window.document.createElement(
          "template",
        );
        replacementTemplate.innerHTML = loadedFileHtml;
        fileElement.replaceWith(replacementTemplate.content.firstElementChild);
      }, 0);
    });

    loadButton.click();

    await waitFor(() => {
      const replacementFileElement =
        dom.window.document.querySelector(".js-file");
      assert.notEqual(replacementFileElement, fileElement);
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        false,
      );
      assert.equal(app.fileRevealRestorePending.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("shows Load Diff immediately after a hidden large diff is revealed", async (t) => {
  const cases = [
    {
      name: "file expansion",
      controlHtml: '<button aria-label="Expand file">Expand</button>',
      includeHiddenPlaceholder: true,
      reveal: (fileElement, control) => {
        control.setAttribute("aria-label", "Collapse file");
        fileElement.querySelector(".diff-body").hidden = false;
      },
    },
    {
      name: "official Viewed removal",
      controlHtml:
        '<button aria-label="Viewed" aria-pressed="true">Viewed</button>',
      reveal: (fileElement, control) => {
        setOfficialViewed(control, false);
        fileElement.insertAdjacentHTML(
          "beforeend",
          `<div class="diff-body">${loadDiffPlaceholderHtml()}</div>`,
        );
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(
        hiddenLargeDiffFixture(scenario.controlHtml, {
          includeHiddenPlaceholder: scenario.includeHiddenPlaceholder,
        }),
      );
      try {
        installContentStyles(dom);
        const fileElement = dom.window.document.querySelector(".js-file");
        const control = fileElement.querySelector("button");
        let readinessFrame = null;
        if (scenario.includeHiddenPlaceholder) {
          dom.window.requestAnimationFrame = (callback) => {
            readinessFrame = callback;
            return 1;
          };
          dom.window.cancelAnimationFrame = () => {
            readinessFrame = null;
          };
        }
        control.addEventListener("click", () => {
          scenario.reveal(fileElement, control);
        });

        control.click();
        const diffBody = fileElement.querySelector(".diff-body");
        assertFileRevealState(dom, fileElement, diffBody, true);
        if (scenario.includeHiddenPlaceholder) {
          assert.ok(readinessFrame);
          const callback = readinessFrame;
          readinessFrame = null;
          callback(dom.window.performance.now());
        }

        await waitFor(() => {
          assertFileRevealState(dom, fileElement, diffBody, false);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
        });
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("shows stable non-hunk content immediately after a file reveal", async (t) => {
  const cases = [
    {
      name: "file expansion",
      html: nonHunkDiffFixture(
        '<button aria-label="Expand file">Expand</button>',
        { hidden: true },
      ),
      reveal: (fileElement, control) => {
        control.setAttribute("aria-label", "Collapse file");
        fileElement.querySelector(".diff-body").hidden = false;
      },
    },
    {
      name: "official Viewed removal",
      html: initiallyViewedCommitSelectionFixture(),
      reveal: (fileElement, control) => {
        setOfficialViewed(control, false);
        fileElement.insertAdjacentHTML(
          "beforeend",
          '<div class="diff-body"><div class="binary-diff">Binary file not shown.</div></div>',
        );
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(scenario.html);
      try {
        installContentStyles(dom);
        const fileElement = dom.window.document.querySelector(".js-file");
        const control = fileElement.querySelector("button");
        control.addEventListener("click", () => {
          scenario.reveal(fileElement, control);
        });

        control.click();

        const diffBody = fileElement.querySelector(".diff-body");
        assertFileRevealState(dom, fileElement, diffBody, true);
        await waitFor(() => {
          assertFileRevealState(dom, fileElement, diffBody, false);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
        });
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("cancels a cold-cache visibility expectation when key generation fails", async () => {
  const { app, dom } = await startExtension(
    initiallyViewedCommitSelectionFixture(),
  );
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    app.officialViewedSuppressionKey = async () => {
      throw new Error("identifier generation failed");
    };

    dom.window.document
      .querySelector('button[aria-label="Viewed"]')
      .click();

    await waitFor(() => {
      assert.equal(warnings.length, 1);
      assert.equal(app.fileDiffVisibilityPending.size, 0);
      assert.equal(app.fileRevealPrepaintRestores.size, 0);
      assert.equal(
        dom.window.document
          .querySelector(".js-file")
          .classList.contains("hunkmark-file-reveal-restoring"),
        false,
      );
    });
    assert.equal(
      app.officialViewedStorageIntentGenerationByKey.size,
      0,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});
