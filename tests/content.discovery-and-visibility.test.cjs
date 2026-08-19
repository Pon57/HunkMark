const {
  test,
  assert,
  path,
  JSDOM,
  Core,
  root,
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
  contextualLineFixture,
} = require("./content-test-support.cjs");

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
        <h3><a href="#diff-marked"><code>\u200edir/\u200eodd.js\u200e\u200e</code></a></h3>
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
    "<!doctype html><html><body><section id=outer><div id=nested></div></section></body></html>",
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

    nested.innerHTML = '<h3><a href="#diff-b"><code>src/b.js</code></a></h3>';
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
      2,
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
    assert.equal(scheduled[0]?.immediate, true);
    assert.equal(app.fileDiffVisibilityPending.size, 0);
  } finally {
    reviewRead.release();
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
        assert.equal(app.controllersByRow.size, 1);
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
      app.finishReadyFileRevealPrepaintRestores();
      assertFileRevealState(
        dom,
        replacementFileElement,
        replacementFileElement.querySelector(".diff-body"),
        false,
      );
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
      assert.equal(app.controllersByRow.size, 1);
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
