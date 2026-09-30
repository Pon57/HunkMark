const {
  test,
  assert,
  path,
  JSDOM,
  root,
  createExclusiveLockManager,
  installContentStyles,
  syncStickyHunkContentInset,
  changeCheckbox,
  waitFor,
  startExtension,
  duplicateHunkFixture,
  largeChangedBlockFixture,
  splitFixture,
  modernGridFixture,
  currentReactOverlappingContextExpansionFixture,
} = require("./content-test-support.cjs");

function mockStickyRows(dom, controllers, tops) {
  const viewport = { scrollY: 0 };
  Object.defineProperty(dom.window, "scrollY", {
    configurable: true, get: () => viewport.scrollY,
  });
  controllers.forEach((controller, index) => {
    controller.hunkRow.getBoundingClientRect = () => ({
      height: 24,
      top: controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared") &&
        !controller.fileElement.classList.contains("hunkmark-sticky-file-measuring")
        ? Math.max(40, tops[index] - viewport.scrollY)
        : tops[index] - viewport.scrollY,
    });
    controller.returnButton.getBoundingClientRect = controller.hunkRow.getBoundingClientRect;
  });
  return viewport;
}

test("keeps sticky positioning and scroll effects independent of active controls", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  try {
    const style = installContentStyles(dom);
    const rules = Array.from(style.sheet.cssRules);
    const ruleFor = (selector) => {
      const rule = rules.find((candidate) => candidate.selectorText === selector);
      assert.ok(rule, "Missing CSS rule: " + selector);
      return rule;
    };
    const prepared = ruleFor(".hunkmark-sticky-hunk-prepared").style;
    const active = ruleFor(".hunkmark-sticky-hunk-active").style;
    assert.equal(prepared.position, "sticky");
    assert.match(prepared.top, /--hunkmark-sticky-hunk-top/);
    assert.ok(Number(ruleFor(".hunkmark-sticky-file-header").style.zIndex) >
      Number(prepared.zIndex));
    assert.match(prepared.animationTimeline, /scroll\(root block\)/);
    for (const effect of ["compress", "tail", "push"]) {
      assert.match(prepared.animationName, new RegExp("hunkmark-sticky-hunk-" + effect));
      assert.match(prepared.animationRange, new RegExp("--hunkmark-sticky-hunk-" + effect));
    }
    assert.match(
      prepared.animationRange,
      /--hunkmark-sticky-hunk-file-start/,
    );
    for (const property of ["position", "transform", "clip-path", "animation"]) {
      assert.equal(active.getPropertyValue(property), "");
    }
    const measuring = ruleFor(
      ".hunkmark-sticky-file-measuring .hunkmark-sticky-hunk-prepared",
    ).style;
    assert.equal(measuring.position, "relative");
    assert.equal(measuring.top, "auto");
    assert.equal(measuring.animation, "none");
    assert.equal(measuring.transform, "none");

    const auxiliary = ruleFor(
      ".hunkmark-sticky-hunk-prepared .hunkmark-sticky-hunk-auxiliary",
    ).style;
    assert.match(auxiliary.animationTimeline, /scroll\(root block\)/);
    assert.match(auxiliary.animationRange, /--hunkmark-sticky-hunk-auxiliary-end/);
    assert.match(
      auxiliary.animationRange,
      /--hunkmark-sticky-hunk-file-start/,
    );
    const reducedMotion = rules.find(
      (rule) => rule.conditionText === "(prefers-reduced-motion: reduce)",
    );
    assert.ok(reducedMotion);
    assert.match(reducedMotion.cssText, /steps\(1, end\)/);
    assert.doesNotMatch(style.textContent, /aria-label\^="Expand "/);
    assert.doesNotMatch(style.textContent, /class\*="expand-button"/);
  } finally {
    dom.window.close();
  }
});

test("keeps original sticky hunk rows below sticky file headers", async (t) => {
  const cases = [
    {
      expectedAfterResize: "57px",
      headerSelector: ".file-header",
      html: splitFixture()
        .replace(
          '<div class="file-header">',
          '<div class="file-header" style="position: sticky; top: 7px; height: 41px">',
        )
        .replace(
          "</tbody>",
          '<tr><td class="blob-code-hunk">@@ -50 +50 @@</td></tr></tbody>',
        ),
      name: "legacy split diff",
    },
    {
      expectedAfterResize: "55px",
      headerSelector: '[class*="diffHeaderWrapper"]',
      html: modernGridFixture().replace(
        '<div class="Diff-module__diffHeaderWrapper__VTI5w">',
        '<div class="Diff-module__diffHeaderWrapper__VTI5w" style="position: sticky; top: 5px; height: 43px">',
      ),
      name: "React grid diff",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const observers = [];
      class TestResizeObserver {
        constructor(callback) {
          this.callback = callback;
          this.observeCalls = [];
          this.observed = new Set();
          observers.push(this);
        }

        observe(element) {
          this.observeCalls.push(element);
          this.observed.add(element);
        }

        unobserve(element) {
          this.observed.delete(element);
        }

        disconnect() {
          this.observed.clear();
        }
      }

      const { app, dom } = await startExtension(testCase.html, {}, {
        resizeObserverClass: TestResizeObserver,
      });
      try {
        const controllers = Array.from(app.controllersByRow.values());
        const controller = controllers[0];
        const fileElement = controller.fileElement;
        const header = fileElement.querySelector(testCase.headerSelector);
        const row = controller.hunkRow;
        const state = app.hunkStickyStateByFile.get(fileElement);

        assert.notEqual(row, controller.hunkCell);
        assert.equal(
          row.classList.contains("hunkmark-sticky-hunk-row"),
          true,
        );
        assert.equal(
          header.classList.contains("hunkmark-sticky-file-header"),
          true,
        );
        assert.equal(
          fileElement.style.getPropertyValue(
            "--hunkmark-sticky-hunk-top",
          ),
          "48px",
        );

        row.getBoundingClientRect = () => ({
          bottom: 64,
          height: 24,
          left: 12,
          right: 812,
          top: 40,
          width: 800,
          x: 12,
          y: 40,
        });
        app.updateStickyHunkState(state);
        assert.equal(
          row.classList.contains("hunkmark-sticky-hunk-prepared"),
          true,
        );
        assert.equal(
          dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"),
          null,
        );

        const headerObserver = observers.find((observer) =>
          observer.observed.has(header),
        );
        assert.ok(headerObserver);
        header.style.height = "50px";
        headerObserver.callback([{ target: header }]);
        assert.equal(
          fileElement.style.getPropertyValue(
            "--hunkmark-sticky-hunk-top",
          ),
          testCase.expectedAfterResize,
        );

        // A responsive CSS rule can change only the sticky offset, which does
        // not notify ResizeObserver because the header's box size is stable.
        header.style.top = "11px";
        await waitFor(() => {
          assert.equal(
            fileElement.style.getPropertyValue(
              "--hunkmark-sticky-hunk-top",
            ),
            "61px",
          );
        });

        const hostHeaderClassName = Array.from(header.classList)
          .filter((className) => className !== "hunkmark-sticky-file-header")
          .join(" ");
        header.className = hostHeaderClassName;
        await waitFor(() => {
          assert.equal(
            header.classList.contains("hunkmark-sticky-file-header"),
            true,
          );
        });

        const replacementHeader = header.cloneNode(true);
        replacementHeader.style.top = "9px";
        replacementHeader.style.height = "52px";
        header.replaceWith(replacementHeader);
        await app.refresh();
        assert.equal(
          header.classList.contains("hunkmark-sticky-file-header"),
          false,
        );
        assert.equal(headerObserver.observed.has(header), false);
        assert.equal(headerObserver.observed.has(replacementHeader), true);
        assert.equal(
          replacementHeader.classList.contains(
            "hunkmark-sticky-file-header",
          ),
          true,
        );
        assert.equal(
          fileElement.style.getPropertyValue(
            "--hunkmark-sticky-hunk-top",
          ),
          "61px",
        );
        const replacementHeaderAttributeObserver =
          state.headerAttributeObserver;

        app.destroyController(controller);
        if (controllers.length > 1) {
          controllers.slice(1).forEach((sibling) => {
            app.destroyController(sibling);
          });
        }
        assert.equal(
          fileElement.style.getPropertyValue(
            "--hunkmark-sticky-hunk-top",
          ),
          "",
        );
        assert.equal(
          replacementHeader.classList.contains(
            "hunkmark-sticky-file-header",
          ),
          false,
        );
        replacementHeader.style.top = "17px";
        assert.equal(
          replacementHeaderAttributeObserver.takeRecords().length,
          0,
        );
        assert.equal(row.classList.contains("hunkmark-sticky-hunk-prepared"), false);
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("selects a newly inserted preferred sticky file header", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const fileElement = controller.fileElement;
    const state = app.hunkStickyStateByFile.get(fileElement);
    const previousHeader = state.header;
    const previousHeaderAttributeObserver =
      state.headerAttributeObserver;
    assert.ok(previousHeaderAttributeObserver);
    const preferredHeader = dom.window.document.createElement("div");
    preferredHeader.className = "Diff-module__diffHeaderWrapper__replacement";
    preferredHeader.style.cssText =
      "position: sticky; top: 7px; height: 41px";
    fileElement.prepend(preferredHeader);

    await app.refresh();

    assert.equal(previousHeader.isConnected, true);
    assert.equal(
      previousHeader.classList.contains("hunkmark-sticky-file-header"),
      false,
    );
    assert.equal(state.header, preferredHeader);
    assert.notEqual(
      state.headerAttributeObserver,
      previousHeaderAttributeObserver,
    );
    assert.equal(
      preferredHeader.classList.contains("hunkmark-sticky-file-header"),
      true,
    );
    assert.equal(
      fileElement.style.getPropertyValue("--hunkmark-sticky-hunk-top"),
      "48px",
    );
    previousHeader.style.top = "13px";
    assert.equal(previousHeaderAttributeObserver.takeRecords().length, 0);
    preferredHeader.style.top = "9px";
    assert.equal(state.headerAttributeObserver.takeRecords().length, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not treat an arbitrary first file child as a sticky header", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const fileElement = dom.window.document.createElement("section");
    const toolbar = dom.window.document.createElement("div");
    toolbar.className = "unrelated-toolbar";
    fileElement.append(toolbar);

    assert.equal(app.stickyFileHeader(fileElement), null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("remeasures a hunk after GitHub lays out a taller row", async () => {
  const observers = [];
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.observed = new Set();
      observers.push(this);
    }

    observe(element) {
      this.observeCalls.push(element);
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }

    disconnect() {
      this.observed.clear();
    }
  }

  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<button aria-label="Expand file down from line 1">↓</button>',
      '<code class="diff-text-cell hunk">',
      '<span class="diff-text-inner">@@ -1 +1 @@</span>',
      "</code>",
    ].join(""),
  );
  const { app, dom } = await startExtension(html, {}, {
    resizeObserverClass: TestResizeObserver,
  });
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const controller = controllers[0];
    const row = controller.hunkRow;
    const text = row.querySelector(".diff-text-inner");
    const rowObserver = observers.find((observer) =>
      observer.observed.has(row),
    );
    assert.ok(rowObserver);
    assert.equal(controller.stickyHunkContentInset ?? 0, 0);

    const rect = (top, height, left = 0, width = 900) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      get: () => 48,
    });
    row.getBoundingClientRect = () => rect(100, 48);
    text.getBoundingClientRect = () => rect(112, 24, 140, 220);
    rowObserver.callback([{ target: row }]);

    await waitFor(() => {
      assert.equal(controller.stickyHunkContentInset, 12);
    });
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "12px",
    );
    await app.refresh();
    assert.equal(
      rowObserver.observeCalls.filter((element) => element === row).length,
      1,
    );

    app.destroyController(controller);
    assert.equal(rowObserver.observed.has(row), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("compacts wrapped hunk text without changing the original row or controls", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    '<button aria-label="Expand file down from line 1">↓</button>' +
      '<code><span class="diff-text-inner">@@ -1 +1 @@ wrapped signature</span></code>',
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const row = controller.hunkRow;
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: 72 });
    row.getBoundingClientRect = () => ({ top: 100, height: 72 });
    row.querySelector(".diff-text-inner").getBoundingClientRect = () => ({
      top: 112, height: 48,
    });
    syncStickyHunkContentInset(app, controller);
    assert.deepEqual([
      controller.stickyHunkCompactHeight,
      controller.stickyHunkContentInset,
      controller.stickyHunkBottomInset,
    ], [48, 12, 12]);
    assert.equal(row.offsetHeight, 72);
    assert.equal(controller.actions.parentElement, controller.hunkCell);
    assert.equal(row.querySelectorAll(".hunkmark-hunk-actions").length, 1);
    assert.equal(dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"), null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("measures a direct hunk text node without including its controls", async () => {
  const html = modernGridFixture();
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const row = controller.hunkRow;
    const cell = controller.hunkCell;
    const precedingControl = dom.window.document.createElement("button");
    precedingControl.textContent = "Expand";
    cell.prepend(precedingControl);
    const headerTextNode = Array.from(cell.childNodes).find(
      (node) => node.nodeValue?.includes("@@ -4 +4,2 @@"),
    );
    const rect = (top, height, left = 0, width = 900) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      value: 72,
    });
    row.getBoundingClientRect = () => rect(100, 72);
    cell.getBoundingClientRect = () => rect(100, 72, 120, 600);
    let rangeTarget = null;
    dom.window.document.createRange = () => ({
      detach() {},
      getBoundingClientRect: () =>
        rangeTarget === headerTextNode
          ? rect(124, 20, 120, 240)
          : rect(100, 72, 120, 600),
      selectNodeContents(target) {
        rangeTarget = target;
      },
    });

    syncStickyHunkContentInset(app, controller);

    assert.equal(controller.stickyHunkCompactHeight, 24);
    assert.equal(controller.stickyHunkContentInset, 22);
    assert.equal(controller.stickyHunkBottomInset, 26);
    assert.equal(rangeTarget, headerTextNode);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not clip a deeply wrapped hunk header", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<code class="diff-text-cell hunk">',
      '<span class="diff-text-inner">',
      "@@ -1 +1 @@ function withADeeplyWrappedSignature() {",
      "</span>",
      "</code>",
    ].join(""),
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const row = controller.hunkRow;
    const text = row.querySelector(".diff-text-inner");
    const rect = (top, height, left = 0, width = 900) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      value: 96,
    });
    row.getBoundingClientRect = () => rect(100, 96);
    text.getBoundingClientRect = () => rect(108, 80, 140, 600);

    syncStickyHunkContentInset(app, controller);

    assert.equal(controller.stickyHunkCompactHeight, 96);
    assert.equal(controller.stickyHunkContentInset ?? 0, 0);
    assert.equal(controller.stickyHunkBottomInset ?? 0, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not clip a deeply wrapped raw table hunk header", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    "@@ -1 +1 @@ function withADeeplyWrappedLegacySignature() {",
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const row = controller.hunkRow;
    const cell = controller.hunkCell;
    const rect = (top, height, left = 0, width = 320) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    assert.equal(row.querySelector(".diff-text-inner"), null);
    Object.defineProperty(row, "offsetHeight", {
      configurable: true,
      value: 144,
    });
    row.getBoundingClientRect = () => rect(100, 144);
    cell.getBoundingClientRect = () => rect(100, 144);

    syncStickyHunkContentInset(app, controller);

    assert.equal(controller.stickyHunkCompactHeight, 144);
    assert.equal(controller.stickyHunkContentInset ?? 0, 0);
    assert.equal(controller.stickyHunkBottomInset ?? 0, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("right-aligns hunk Viewed and keeps Collapse in hover actions", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<code class="diff-text-cell hunk">',
      '<span class="diff-text-inner">',
      "@@ -1 +1 @@ function createExclusiveLockManager() {",
      "</span>",
      "</code>",
    ].join(""),
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    assert.equal(controller.label.parentElement, controller.actions);
    assert.equal(controller.label.className, app.constants.CONTROL_CLASS);
    assert.equal(controller.label.hasAttribute("data-hunkmark-ui"), false);
    assert.equal(
      controller.actions.contains(controller.collapseButton),
      true,
    );
    assert.equal(
      controller.actions.contains(controller.label),
      true,
    );
    assert.equal(controller.collapseButton.textContent, "");
    assert.equal(controller.collapseButton.childElementCount, 0);
    assert.equal(
      controller.collapseButton.getAttribute("aria-label"),
      "Collapse this diff hunk",
    );
    assert.equal(
      controller.collapseButton.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      app.cleanElementText(controller.hunkCell).includes("Viewed"),
      false,
    );

    const style = installContentStyles(dom);
    const collapseIndicatorRule = Array.from(style.sheet.cssRules).find(
      (rule) =>
        rule.selectorText === ".hunkmark-collapse-button::before",
    );
    const collapsedIndicatorRule = Array.from(style.sheet.cssRules).find(
      (rule) =>
        rule.selectorText ===
          ".hunkmark-collapse-button.is-collapsed::before",
    );
    assert.equal(collapseIndicatorRule.style.content, '""');
    assert.equal(collapseIndicatorRule.style.width, "8px");
    assert.equal(collapseIndicatorRule.style.height, "8px");
    assert.equal(collapsedIndicatorRule.style.transform, "rotate(45deg)");
    assert.equal(
      dom.window.getComputedStyle(controller.actions).right,
      "8px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.actions).top,
      "50%",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.actions).transform,
      "translateY(-50%)",
    );

    const label = controller.label;
    const actions = controller.actions;
    app.destroyController(controller);
    assert.equal(label.isConnected, false);
    assert.equal(actions.isConnected, false);
    assert.equal(
      controller.hunkCell.style.getPropertyValue(
        "--hunkmark-host-hunk-action-inset",
      ),
      "",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps prepared rows in place and reserves active state for return controls", async () => {
  const html = duplicateHunkFixture().replace(
    '<div class="file-header">',
    '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
  );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const controller = controllers[0];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    const viewport = mockStickyRows(dom, controllers, [100, 200]);
    installContentStyles(dom);
    app.invalidateStickyHunkOrigins(controller.fileElement);
    app.updateStickyHunkState(state);
    assert.equal(controller.returnButton.hidden, true);
    assert.equal(dom.window.getComputedStyle(controller.hunkRow).position, "sticky");

    viewport.scrollY = 100;
    app.updateStickyHunkState(state);
    assert.equal(controller.returnButton.hidden, false);
    assert.equal(dom.window.getComputedStyle(controller.hunkRow).position, "sticky");
    assert.equal(controller.actions.parentElement, controller.hunkCell);
    assert.equal(dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length, controllers.length);
    assert.equal(dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"), null);
    controller.collapsed = true;
    app.applyControllerAppearance(controller);
    assert.equal(controller.collapseButton.getAttribute("aria-label"), "Expand this diff hunk");
    assert.equal(dom.window.getComputedStyle(controller.collapseButton).visibility, "visible");
    controller.collapsed = false;
    app.applyControllerAppearance(controller);

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    const naturalTop = app.stickyHunkNaturalDocumentTop.bind(app);
    app.stickyHunkNaturalDocumentTop = (target, options) =>
      options?.refreshLayout ? naturalTop(target, options) : 400;
    const hostButton = dom.window.document.createElement("button");
    hostButton.textContent = "Host action";
    controller.hunkCell.append(hostButton);
    hostButton.click();
    assert.equal(scrollCalls.length, 0);
    controller.hunkCell.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 359);

    // CSS has reached the next hunk, but no scroll callback has updated JS yet.
    viewport.scrollY = 200;
    assert.equal(controllers[1].returnButton.hidden, true);
    controllers[1].hunkCell.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.equal(controllers[1].returnButton.hidden, false);
    assert.equal(scrollCalls.length, 2);
  } finally {
    app.stop();
    dom.window.close();
  }
});
test("anchors the compact clip to the rendered hunk text", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<div class="d-flex flex-column">',
      '<button aria-label="Expand file down from line 1">↓</button>',
      '<button aria-label="Expand file up from line 50">↑</button>',
      "</div>",
      '<code class="diff-text-cell hunk">',
      '<span class="diff-text-inner">@@ -1 +1 @@</span>',
      "</code>",
    ].join(""),
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const text = controller.hunkRow.querySelector(".diff-text-inner");
    const rect = (top, height, left = 12, width = 900) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    controller.hunkRow.getBoundingClientRect = () => rect(100, 60);
    controller.hunkCell.getBoundingClientRect = () => rect(112, 24);
    text.getBoundingClientRect = () => rect(126, 20, 120, 200);

    syncStickyHunkContentInset(app, controller);

    assert.equal(controller.stickyHunkContentInset, 24);
    assert.equal(
      controller.hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "24px",
    );

    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    controller.hunkRow.getBoundingClientRect = () => rect(40, 60);
    text.getBoundingClientRect = () => rect(66, 20, 120, 200);
    syncStickyHunkContentInset(app, controller);

    assert.equal(controller.stickyHunkContentInset, 24);
    assert.equal(
      controller.hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "24px",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("prepares tall hunk affordances for CSS-driven visibility", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<div class="hunk-kebab-icon"><svg aria-hidden="true"></svg></div>',
      '<a class="js-expand" aria-label="Expand Down">↓</a>',
      '<button class="js-expand-full" aria-label="Expand all">↕</button>',
      '<button class="Button Button--iconOnly Button--invisible ExpandableHunkHeaderDiffLine-module__expandButton">↕</button>',
      '<div data-react-expansion-shell class="d-flex flex-row">',
      '<div data-react-expansion-group class="d-flex flex-column">',
      '<button class="Button Button--iconOnly Button--invisible ExpandableHunkHeaderDiffLine-module__expand-button-line__hash ExpandableHunkHeaderDiffLine-module__expand-up-and-down__hash">↓</button>',
      '<button class="Button Button--iconOnly Button--invisible ExpandableHunkHeaderDiffLine-module__expand-button-line__hash ExpandableHunkHeaderDiffLine-module__expand-up-and-down__hash">↑</button>',
      '</div>',
      '<code class="diff-text-cell hunk">',
      '<span class="diff-text-inner">@@ -1 +1 @@</span>',
      '</code>',
      '</div>',
      '<button aria-label="Expand file up from line 1">↑</button>',
    ].join(""),
  );
  const { app, dom } = await startExtension(html);
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const text = controller.hunkRow.querySelector(".diff-text-inner");
    const rect = (top, height, left = 12, width = 900) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    controller.hunkRow.getBoundingClientRect = () => rect(100, 72);
    controller.hunkCell.getBoundingClientRect = () => rect(110, 24);
    text.getBoundingClientRect = () => rect(118, 20, 120, 200);

    syncStickyHunkContentInset(app, controller);

    installContentStyles(dom);
    const reactExpansionControl = controller.hunkRow.querySelector(
      'button[class*="ExpandableHunkHeaderDiffLine-module__"]',
    );
    const reactExpansionStyle = dom.window.getComputedStyle(
      reactExpansionControl,
    );
    assert.equal(reactExpansionStyle.alignSelf, "stretch");
    assert.equal(reactExpansionStyle.height, "auto");
    const reactExpansionGroup = controller.hunkRow.querySelector(
      "[data-react-expansion-group]",
    );
    const reactExpansionGroupStyle = dom.window.getComputedStyle(
      reactExpansionGroup,
    );
    assert.equal(reactExpansionGroupStyle.alignSelf, "stretch");
    assert.equal(reactExpansionGroupStyle.height, "auto");
    reactExpansionGroup.querySelectorAll("button").forEach((control) => {
      const style = dom.window.getComputedStyle(control);
      assert.equal(style.alignSelf, "auto");
      assert.equal(style.flexBasis, "0px");
      assert.equal(style.flexGrow, "1");
      assert.equal(style.flexShrink, "1");
    });
    assert.equal(controller.stickyHunkContentInset, 16);
    assert.equal(
      controller.hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "16px",
    );

    app.invalidateStickyHunkOrigins(controller.fileElement);
    app.updateStickyHunkLayouts();
    const auxiliaryElements = controller.hunkRow.querySelectorAll(
      '.hunk-kebab-icon, .js-expand, .js-expand-full, button[class*="ExpandableHunkHeaderDiffLine-module__"], [aria-label^="Expand file up"]',
    );
    assert.equal(auxiliaryElements.length, 7);
    auxiliaryElements.forEach((element) => {
      assert.equal(
        element.classList.contains("hunkmark-sticky-hunk-auxiliary"),
        true,
      );
      assert.match(
        dom.window.getComputedStyle(element).animationTimeline,
        /scroll\(root block\)/,
      );
    });

    app.destroyController(controller);
    auxiliaryElements.forEach((element) => {
      assert.equal(
        element.classList.contains("hunkmark-sticky-hunk-auxiliary"),
        false,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("resyncs hunk auxiliary elements added to a stable row", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[0];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    app.updateStickyHunkState(state);
    assert.equal(state.contentLayoutDirtyControllers.size, 0);

    const auxiliaryElement = dom.window.document.createElement("button");
    auxiliaryElement.className = "js-expand";
    auxiliaryElement.setAttribute("aria-label", "Expand Down");
    controller.hunkCell.prepend(auxiliaryElement);
    app.attachStickyHunkRow(controller);

    assert.equal(
      auxiliaryElement.classList.contains(
        "hunkmark-sticky-hunk-auxiliary",
      ),
      true,
    );
    assert.equal(state.contentLayoutDirtyControllers.has(controller), true);

    app.updateStickyHunkState(state);
    assert.equal(state.contentLayoutDirtyControllers.size, 0);
    auxiliaryElement.remove();
    app.attachStickyHunkRow(controller);
    assert.equal(
      auxiliaryElement.classList.contains(
        "hunkmark-sticky-hunk-auxiliary",
      ),
      false,
    );
    assert.equal(state.contentLayoutDirtyControllers.has(controller), true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps a prepared table hunk's natural origin for returning and explicit remeasurement", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[1];
    const tops = [570];
    const viewport = mockStickyRows(dom, [controller], tops);
    viewport.scrollY = 300;
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-prepared");
    assert.equal(app.stickyHunkNaturalDocumentTop(controller, { refreshLayout: true }), 570);
    viewport.scrollY = 600;
    assert.equal(controller.hunkRow.getBoundingClientRect().top, 40);
    assert.equal(app.stickyHunkNaturalDocumentTop(controller), 570);

    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    state.stickyTop = 40;
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    controller.hunkCell.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 529);

    tops[0] = 524;
    assert.equal(app.stickyHunkNaturalDocumentTop(controller), 570);
    assert.equal(app.stickyHunkNaturalDocumentTop(controller, { refreshLayout: true }), 524);
    assert.equal(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared"), true);
    assert.equal(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-active"), true);
    assert.equal(controller.fileElement.classList.contains("hunkmark-sticky-file-measuring"), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});


test("bounds animated hunks and reuses geometry and ranges within a prepared window", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(128, 48, { hunkSize: 1 }),
  );
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const tops = controllers.map((_, index) => 500 + index * 100);
    const events = [];
    let scrollY = 0;
    Object.defineProperty(dom.window, "scrollY", {
      configurable: true, get: () => scrollY,
    });
    controllers.forEach((controller, index) => {
      const row = controller.hunkRow;
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        get() { events.push("read"); return 48; },
      });
      row.getBoundingClientRect = () => {
        events.push("read");
        const measuring = state.fileElement.classList.contains("hunkmark-sticky-file-measuring");
        const top = tops[index] - scrollY;
        return {
          top: row.classList.contains("hunkmark-sticky-hunk-prepared") && !measuring
            ? Math.max(40, top) : top,
          height: 48,
        };
      };
      for (const method of ["setProperty", "removeProperty"]) {
        const original = row.style[method].bind(row.style);
        row.style[method] = (...args) => {
          events.push("write");
          return original(...args);
        };
      }
    });
    state.stickyTop = 40;
    app.markStickyHunkContentDirty(state);
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);

    assert.ok(events.includes("read"));
    assert.ok(events.includes("write"));
    assert.ok(events.lastIndexOf("read") < events.indexOf("write"));
    const preparedControllers = () => controllers.filter((controller) =>
      controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared"),
    );
    assert.equal(preparedControllers().includes(controllers[0]), true);
    assert.equal(preparedControllers().includes(controllers.at(-1)), false);
    assert.ok(preparedControllers().length <= 30);
    const assertPreparedRanges = () => {
      preparedControllers().forEach((controller) => {
        const index = controllers.indexOf(controller);
        assert.equal(controller.stickyHunkOriginDocumentTop, tops[index]);
        assert.equal(
          controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-compress-start"),
          (tops[index] - state.fileOriginDocumentTop) + "px",
        );
      });
    };
    assertPreparedRanges();
    for (scrollY of [460, 600, 12_000, 800, 0]) {
      app.updateStickyHunkState(state);
      assert.ok(preparedControllers().length > 0);
      assert.ok(preparedControllers().length <= 30);
      assertPreparedRanges();
      if (state.activeController) {
        assert.equal(preparedControllers().includes(state.activeController), true);
      }
      if (scrollY === 12_000) {
        assert.equal(preparedControllers().includes(controllers[0]), false);
      }
      const styles = controllers.map((controller) => controller.hunkRow.style.cssText);
      events.length = 0;
      app.updateStickyHunkState(state);
      assert.deepEqual(events, []);
      assert.deepEqual(controllers.map((controller) => controller.hunkRow.style.cssText), styles);
    }
    assert.equal(preparedControllers().includes(controllers[0]), true);
    assert.equal(preparedControllers().includes(controllers.at(-1)), false);

    tops.forEach((top, index) => { tops[index] = top + 200; });
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    assert.ok(events.includes("read"));
    assert.ok(events.includes("write"));
    assert.ok(events.lastIndexOf("read") < events.indexOf("write"));
    assertPreparedRanges();
    scrollY = tops.at(-1);
    app.updateStickyHunkState(state);
    assert.equal(state.activeController, controllers.at(-1));
    assert.equal(
      controllers.at(-1).hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-push-distance"), "0px",
    );
    assert.equal(state.fileElement.classList.contains("hunkmark-sticky-file-measuring"), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bounds geometry reads and range writes after large-file invalidation and jumps", async () => {
  const observers = [];
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      observers.push(this);
    }
    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
  }
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(512, 48, { hunkSize: 1 }), {},
    { resizeObserverClass: TestResizeObserver, scopeWaitTimeoutMs: 15000 },
  );
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const tops = controllers.map((_, index) => 500 + index * 100);
    const viewport = mockStickyRows(dom, controllers, tops);
    Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 800 });
    state.fileElement.getBoundingClientRect = () => ({ top: 100 - viewport.scrollY });
    state.stickyTop = 40;
    const measured = new Set();
    const written = new Set();
    let tallHeight = 24;
    controllers.forEach((controller) => {
      const rect = controller.hunkRow.getBoundingClientRect;
      controller.hunkRow.getBoundingClientRect = () => {
        measured.add(controller);
        const bounds = rect();
        return { ...bounds, height: controller === controllers[450] ? tallHeight : bounds.height };
      };
      const setProperty = controller.hunkRow.style.setProperty.bind(controller.hunkRow.style);
      controller.hunkRow.style.setProperty = (...args) => {
        written.add(controller);
        return setProperty(...args);
      };
    });
    const fileObserver = observers.find((observer) => observer.observed.has(state.fileElement));
    assert.ok(fileObserver);
    const check = (index, inset = 0) => {
      measured.clear();
      written.clear();
      viewport.scrollY = tops[index] - 20 + inset;
      app.updateStickyHunkState(state);
      assert.equal(state.activeController, controllers[index]);
      assert.ok(measured.size < 80, `remeasured ${measured.size} of 512 hunks`);
      assert.ok(written.size < 80, `rewrote ${written.size} of 512 hunks`);
      assert.ok(state.preparedControllers.has(controllers[index]));
      assert.equal(controllers[index].stickyHunkOriginDocumentTop, tops[index]);
      assert.equal(controllers[index].hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-push-end"), `${tops[index + 1] - 100}px`);
      assert.equal(state.fileElement.classList.contains("hunkmark-sticky-file-measuring"), false);
    };
    tops.forEach((top, index) => { tops[index] = top + 75; });
    fileObserver.callback([{ target: state.fileElement }]);
    check(10);
    // Mutate an offscreen part of this file before jumping across it.
    tops.forEach((top, index) => { if (index >= 200) tops[index] = top + 125; });
    app.invalidateStickyHunkOriginsForMutations([{ target: controllers[200].groupRows.at(-1) }]);
    check(450);
    check(100);
    tops.forEach((top, index) => { if (index >= 445) tops[index] = top - 50; });
    fileObserver.callback([{ target: state.fileElement }]);
    check(450);
    check(100);
    tallHeight = 96;
    const rowObserver = observers.find((observer) => observer.observed.has(controllers[450].hunkRow));
    rowObserver.callback([{ target: controllers[450].hunkRow }]);
    check(450, 36);
    assert.equal(controllers[450].stickyHunkContentInset, 36);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not remeasure stable sticky hunk rows during refresh", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    let measurementCount = 0;
    app.measureStickyHunkContentInset = () => {
      measurementCount += 1;
    };
    const stateGenerations = Array.from(
      app.hunkStickyStateByFile.values(),
      (state) => state.originLayoutGeneration,
    );

    await app.refresh();

    assert.equal(measurementCount, 0);
    const states = Array.from(app.hunkStickyStateByFile.values());
    assert.deepEqual(
      states.map((state) => state.originLayoutGeneration),
      stateGenerations,
    );
    assert.equal(states.every((state) => !state.orderDirty), true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("reorders cached sticky hunks when GitHub moves existing rows", async () => {
  const html = duplicateHunkFixture()
    .replace("@@ -1 +1 @@", "@@ -1 +1 @@ first")
    .replace("@@ -50 +50 @@", "@@ -50 +50 @@ second")
    .replace(
      '<tr><td class="blob-num">1</td><td class="blob-code-addition">+return null;</td></tr>',
      "",
    )
    .replace(
      '<tr><td class="blob-num">50</td><td class="blob-code-addition">+return null;</td></tr>',
      "",
    );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const [first, second] = controllers;
    const state = app.hunkStickyStateByFile.get(first.fileElement);
    let orderedControllers = app.orderedStickyHunkControllers(state);
    assert.equal(orderedControllers[0], first);
    assert.equal(orderedControllers[1], second);
    assert.equal(state.orderDirty, false);

    first.hunkRow.before(second.hunkRow);
    await app.refresh();

    assert.equal(state.orderDirty, false);
    orderedControllers = app.orderedStickyHunkControllers(state);
    assert.equal(orderedControllers[0], second);
    assert.equal(orderedControllers[1], first);
  } finally {
    app.stop();
    dom.window.close();
  }
});


test("updates sticky layout only for intersecting files", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const visibleState = Array.from(app.hunkStickyStateByFile.values())[0];
    const hiddenFile = dom.window.document.createElement("div");
    const hiddenState = app.createStickyHunkState(hiddenFile);
    hiddenState.visible = false;
    app.hunkStickyStateByFile.set(hiddenFile, hiddenState);
    app.hunkStickyFileVisibilityObserver = { disconnect() {} };
    app.hunkStickyVisibleStates.clear();
    app.hunkStickyVisibleStates.add(visibleState);
    const updated = [];
    app.updateStickyHunkState = (state) => updated.push(state);

    app.updateStickyHunkLayouts();

    assert.deepEqual(updated, [visibleState]);
    app.hunkStickyStateByFile.delete(hiddenFile);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not schedule sticky layout when no file intersects", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    if (app.hunkStickyLayoutFrameId !== null) {
      dom.window.cancelAnimationFrame(app.hunkStickyLayoutFrameId);
      app.hunkStickyLayoutFrameId = null;
    }
    const [state] = app.hunkStickyStateByFile.values();
    app.hunkStickyFileVisibilityObserver = { disconnect() {} };
    app.hunkStickyVisibleStates.clear();
    let frameRequests = 0;
    dom.window.requestAnimationFrame = () => {
      frameRequests += 1;
      return frameRequests;
    };

    app.boundStickyHunkLayout();
    assert.equal(frameRequests, 0);

    app.hunkStickyVisibleStates.add(state);
    app.boundStickyHunkLayout();
    assert.equal(frameRequests, 1);
    app.hunkStickyLayoutFrameId = null;
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps initial expanded appearance from invalidating sticky origins", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const host = dom.window.document.createElement("div");
    host.innerHTML = duplicateHunkFixture().replaceAll(
      "src/example.js",
      "src/another.js",
    );
    const [hunk] = await app.discoverHunks(host);
    const controller = app.createController(hunk);
    let invalidations = 0;
    app.invalidateStickyHunkOrigins = () => {
      invalidations += 1;
    };

    app.applyControllerAppearance(controller);
    assert.equal(invalidations, 0);

    controller.collapsed = true;
    app.applyControllerAppearance(controller);
    assert.equal(invalidations, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("defers sticky hunk observers and style reads until a file intersects", async () => {
  const intersectionObservers = [];
  const resizeObservers = [];
  const geometryReads = [];
  let headerStyleReads = 0;
  class TestIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      intersectionObservers.push(this);
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
  }

  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      resizeObservers.push(this);
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
  }

  const html = duplicateHunkFixture().replace(
    '<div class="file-header">',
    '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
  );
  const { app, dom } = await startExtension(html, {}, {
    intersectionObserverClass: TestIntersectionObserver,
    resizeObserverClass: TestResizeObserver,
    setupWindow(window) {
      const original = window.Element.prototype.getBoundingClientRect;
      const getComputedStyle = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element, pseudoElement) => {
        if (element.classList?.contains("file-header")) {
          headerStyleReads += 1;
        }
        return getComputedStyle(element, pseudoElement);
      };
      window.Element.prototype.getBoundingClientRect = function measuredRect() {
        if (
          this.matches?.(
            "tr, [role='row'], .diff-text-inner, .file-header",
          ) &&
          this.closest?.(".js-file")
        ) {
          geometryReads.push(this);
        }
        return original.call(this);
      };
    },
  });
  try {
    const fileElement = dom.window.document.querySelector(".js-file");
    const header = fileElement.querySelector(".file-header");
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(fileElement);
    const fileObserver = intersectionObservers.find((observer) =>
      observer.observed.has(fileElement),
    );
    const fileLayoutObserver = resizeObservers.find((observer) =>
      observer.observed.has(fileElement),
    );
    assert.ok(fileObserver);
    assert.ok(fileLayoutObserver);
    assert.equal(
      fileLayoutObserver.observed.has(dom.window.document.body),
      true,
    );
    assert.equal(state.visible, false);
    assert.equal(state.header, null);
    assert.equal(headerStyleReads, 0);
    assert.equal(
      resizeObservers.every(
        (observer) =>
          !observer.observed.has(header) &&
          controllers.every(
            (controller) => !observer.observed.has(controller.hunkRow),
          ),
      ),
      true,
    );
    assert.equal(state.contentLayoutDirtyControllers.size, 0);
    assert.equal(
      controllers.every((controller) => !controller.stickyHunkRowObserved),
      true,
    );
    const readsBeforeIntersection = geometryReads.length;
    assert.equal(
      geometryReads.some((element) =>
        element.classList.contains("file-header"),
      ),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(geometryReads.length, readsBeforeIntersection);

    fileObserver.callback([{ isIntersecting: true, target: fileElement }]);
    await waitFor(() => {
      assert.ok(geometryReads.length > readsBeforeIntersection);
      assert.equal(
        geometryReads.some((element) =>
          element.classList.contains("file-header"),
        ),
        true,
      );
    });
    assert.ok(headerStyleReads > 0);
    assert.equal(state.header, header);
    assert.equal(
      header.classList.contains("hunkmark-sticky-file-header"),
      true,
    );
    assert.equal(
      controllers.every((controller) => controller.stickyHunkRowObserved),
      true,
    );
    const headerObserver = resizeObservers.find((observer) =>
      observer.observed.has(header),
    );
    const rowObserver = resizeObservers.find((observer) =>
      observer.observed.has(controllers[0].hunkRow),
    );
    assert.ok(headerObserver);
    assert.ok(rowObserver);

    const originGenerationBeforeFileResize =
      state.originLayoutGeneration;
    fileLayoutObserver.callback([{ target: fileElement }]);
    assert.equal(
      state.originLayoutGeneration,
      originGenerationBeforeFileResize + 1,
    );
    const originGenerationBeforePageResize =
      state.originLayoutGeneration;
    fileLayoutObserver.callback([{ target: dom.window.document.body }]);
    assert.equal(
      state.originLayoutGeneration,
      originGenerationBeforePageResize,
    );
    assert.equal(state.fileOriginDirty, true);

    fileObserver.callback([{ isIntersecting: false, target: fileElement }]);
    assert.equal(state.visible, false);
    assert.equal(state.header, null);
    assert.equal(
      header.classList.contains("hunkmark-sticky-file-header"),
      false,
    );
    assert.equal(headerObserver.observed.has(header), false);
    assert.equal(
      controllers.every(
        (controller) =>
          !controller.stickyHunkRowObserved &&
          !rowObserver.observed.has(controller.hunkRow),
      ),
      true,
    );
    state.contentLayoutDirtyControllers.clear();
    rowObserver.callback([{ target: controllers[0].hunkRow }]);
    assert.equal(state.contentLayoutDirtyControllers.size, 0);

    controllers.forEach((controller) => app.destroyController(controller));
    assert.equal(
      fileLayoutObserver.observed.has(dom.window.document.body),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("cleans prepared timelines and return controls when a file leaves or is destroyed", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const viewport = mockStickyRows(dom, controllers, [0, 80]);
    state.stickyTop = 40;
    viewport.scrollY = 70;
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    assert.equal(controllers[1].returnButton.hidden, false);

    app.setStickyHunkStateVisibility(state, false);
    controllers.forEach((controller) => {
      const row = controller.hunkRow;
      assert.equal(row.classList.contains("hunkmark-sticky-hunk-prepared"), false);
      assert.equal(row.classList.contains("hunkmark-sticky-hunk-active"), false);
      assert.equal(Array.from(row.style).some((name) =>
        /--hunkmark-sticky-hunk-(compress|tail|auxiliary|push)-/.test(name),
      ), false);
      assert.equal(controller.returnButton.hidden, true);
      assert.equal(controller.returnButton.tabIndex, -1);
    });

    app.setStickyHunkStateVisibility(state, true);
    viewport.scrollY = 0;
    app.updateStickyHunkState(state);
    assert.equal(controllers[0].returnButton.hidden, false);
    controllers.forEach((controller) => {
      assert.equal(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared"), true);
      app.destroyController(controller);
      assert.equal(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-row"), false);
      assert.equal(Array.from(controller.hunkRow.style).some((name) =>
        name.startsWith("--hunkmark-sticky-hunk-"),
      ), false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("transfers keyboard focus to the current sticky hunk's return control", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const viewport = mockStickyRows(dom, controllers, [0, 80]);
    state.stickyTop = 40;
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    controllers[0].returnButton.focus();
    assert.equal(dom.window.document.activeElement, controllers[0].returnButton);

    viewport.scrollY = 70;
    controllers[0].returnButton.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    assert.equal(dom.window.document.activeElement, controllers[1].returnButton);
    assert.equal(controllers[0].returnButton.hidden, true);
    assert.equal(controllers[0].returnButton.tabIndex, -1);
    assert.equal(controllers[1].returnButton.hidden, false);
    assert.equal(controllers[1].returnButton.tabIndex, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("reveals obscured focused controls without moving focus or scrolling visible controls", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const controller = controllers[0];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    const viewport = mockStickyRows(dom, controllers, [500, 600]);
    state.stickyTop = 40;
    viewport.scrollY = 600;
    app.invalidateStickyHunkOrigins(controller.fileElement);
    app.updateStickyHunkState(state);
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push({ ...options });
    for (const top of [16, 39, 40]) {
      controller.input.blur();
      controller.input.getBoundingClientRect = () => ({ top });
      scrollCalls.length = 0;
      controller.input.focus();
      assert.equal(dom.window.document.activeElement, controller.input);
      assert.deepEqual(scrollCalls, top < 40 ? [{ behavior: "instant", top: 459 }] : []);
    }
    let revealCalls = 0;
    app.revealFocusedStickyHunk = () => { revealCalls += 1; };
    app.detachStickyHunkRow(controller);
    controller.input.blur();
    controller.input.focus();
    assert.equal(revealCalls, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("updates natural hunk origins after window resize without losing prepared state", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const tops = [100, 200];
    const viewport = mockStickyRows(dom, controllers, tops);
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    viewport.scrollY = 500;
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    assert.equal(controllers[1].stickyHunkOriginDocumentTop, 200);

    tops[1] = 400;
    app.boundStickyHunkResize();
    app.updateStickyHunkState(state);
    assert.equal(controllers[1].stickyHunkOriginDocumentTop, 400);
    assert.equal(controllers[1].hunkRow.classList.contains("hunkmark-sticky-hunk-prepared"), true);
    assert.equal(state.fileElement.classList.contains("hunkmark-sticky-file-measuring"), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});



test("returns to each sticky hunk's cached origin after marking it viewed", async () => {
  const html = duplicateHunkFixture().replace(
    '<div class="file-header">',
    '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
  );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const [previous, current] = controllers;
    const state = app.hunkStickyStateByFile.get(current.fileElement);
    const viewport = mockStickyRows(dom, controllers, [400, 600]);
    viewport.scrollY = 400;
    app.invalidateStickyHunkOrigins(current.fileElement);
    app.updateStickyHunkState(state);
    viewport.scrollY = 600;
    assert.equal(current.returnButton.hidden, true);

    const scrollCalls = [];
    const refreshLayoutCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = (controller, options) => {
      if (options && "refreshLayout" in options) {
        refreshLayoutCalls.push(options.refreshLayout);
      }
      if (Number.isInteger(options?.originLayoutGeneration)) {
        controller.stickyHunkOriginLayoutGeneration =
          options.originLayoutGeneration;
      }
      if (options?.refreshLayout) {
        return 200;
      }
      return controller === current ? 600 : 400;
    };

    current.input.getBoundingClientRect = () => ({ top: 40 });
    current.input.focus();
    current.input.click();
    await waitFor(() => {
      assert.equal(current.input.disabled, false);
      assert.equal(current.marked, true);
      assert.equal(scrollCalls.length, 1);
    });
    assert.equal(scrollCalls[0].behavior, "smooth");
    assert.equal(scrollCalls[0].top, 559);
    assert.ok(refreshLayoutCalls.includes(true));
    assert.equal(refreshLayoutCalls.at(-1), false);
    assert.equal(previous.marked, false);
    assert.equal(dom.window.document.activeElement, current.input);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not return an expanded sticky hunk when auto-collapse is disabled", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const [controller] = Array.from(app.controllersByRow.values());
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    app.autoCollapseViewed = false;

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);

    changeCheckbox(dom, controller.input, true);
    await waitFor(() => {
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, false);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(scrollCalls.length, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("returns a sticky hunk after its final line is marked viewed", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const [controller, dragged] = controllers;
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    state.stickyTop = 40;
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    const naturalTop = app.stickyHunkNaturalDocumentTop.bind(app);
    app.stickyHunkNaturalDocumentTop = () => 600;
    controller.lines[0].control.focus();

    await app.setLineViewed(controller.lines[0], true);
    await waitFor(() => {
      assert.equal(scrollCalls.length, 1);
    });

    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
    assert.equal(scrollCalls[0].top, 559);
    assert.equal(dom.window.document.activeElement, controller.input);

    // Scrolling while the pointer is held must not skip return on release.
    app.stickyHunkNaturalDocumentTop = naturalTop;
    const viewport = mockStickyRows(dom, controllers, [400, 600]);
    viewport.scrollY = 400;
    app.invalidateStickyHunkOrigins(controller.fileElement);
    app.updateStickyHunkState(state);
    dragged.lines[0].control.getBoundingClientRect = () => ({ top: 200 });
    dragged.lines[0].control.focus();
    app.startLineDrag(dragged.lines[0], true, 7);
    viewport.scrollY = 600;
    assert.equal(dragged.returnButton.hidden, true);
    const pointerUp = new dom.window.Event("pointerup", { bubbles: true });
    Object.defineProperty(pointerUp, "pointerId", { value: 7 });
    dragged.lines[0].control.dispatchEvent(pointerUp);
    await waitFor(() => assert.equal(scrollCalls.length, 2));
    assert.equal(dragged.marked, true);
    assert.equal(dragged.collapsed, true);
    assert.equal(scrollCalls[1].top, 559);
    assert.equal(dom.window.document.activeElement, dragged.input);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("syncs prepared file interactions while another file is dirty during refresh", async (t) => {
  const fixture = new JSDOM(duplicateHunkFixture());
  const firstFile = fixture.window.document.querySelector(".js-file");
  const secondFile = firstFile.cloneNode(true);
  secondFile.dataset.filePath = "src/second.js";
  secondFile.querySelector(".file-info").textContent = "src/second.js";
  fixture.window.document.body.append(secondFile);
  const html = fixture.serialize();
  fixture.window.close();

  const scenarios = [
    {
      busyField: "refreshQueued",
      name: "hunk click",
      async interact({ app, controller, dom }) {
        controller.input.dispatchEvent(
          new dom.window.MouseEvent("pointerdown", {
            bubbles: true,
            button: 0,
          }),
        );
        controller.input.click();
        await waitFor(() => assert.equal(controller.marked, true));
      },
    },
    {
      busyField: "refreshRunning",
      name: "drag completion",
      async interact({ app, controller }) {
        app.startLineDrag(controller.lines[0], true, 17);
        await app.finishLineDrag(true);
      },
    },
  ];

  for (const scenario of scenarios.flatMap((entry) => [
    entry,
    { ...entry, dirtyGeometry: true, name: `${entry.name} after row resize` },
  ])) {
    await t.test(scenario.name, async () => {
      const { app, dom } = await startExtension(html);
      try {
        const controllers = Array.from(app.controllersByRow.values());
        const firstControllers = controllers.filter(
          (controller) => controller.filePath === "src/example.js",
        );
        const secondControllers = controllers.filter(
          (controller) => controller.filePath === "src/second.js",
        );
        assert.equal(firstControllers.length, 2);
        assert.equal(secondControllers.length, 2);
        const [firstSecond] = firstControllers.slice(1);
        const [secondFirst, secondSecond] = secondControllers;
        const firstState = app.hunkStickyStateByFile.get(
          firstControllers[0].fileElement,
        );
        const secondState = app.hunkStickyStateByFile.get(
          secondFirst.fileElement,
        );
        const firstFileTop = 100;
        let secondFileTop = 1_000;
        let secondFileRectReads = 0;
        firstState.fileElement.getBoundingClientRect = () => ({
          top: firstFileTop - (Number(dom.window.scrollY) || 0),
        });
        secondState.fileElement.getBoundingClientRect = () => {
          secondFileRectReads += 1;
          return {
            top: secondFileTop - (Number(dom.window.scrollY) || 0),
          };
        };
        const naturalTops = [200, 400, 1_200, 1_600];
        const viewport = mockStickyRows(
          dom,
          controllers,
          naturalTops,
        );
        viewport.scrollY = 1_200;
        app.invalidateVisibleStickyHunkOrigins();
        app.updateStickyHunkLayouts();
        if (app.hunkStickyLayoutFrameId !== null) {
          dom.window.cancelAnimationFrame(app.hunkStickyLayoutFrameId);
          app.hunkStickyLayoutFrameId = null;
        }
        assert.equal(
          secondFirst.hunkRow.classList.contains(
            "hunkmark-sticky-hunk-active",
          ),
          true,
        );

        app.markStickyHunkOriginsDirty(firstState);
        app.suspendReviewControllersForDiffMutation(
          new Set([firstControllers[0].filePath]),
        );
        secondFileTop = 1_200;
        app.markStickyHunkFileOriginDirty(secondState);
        naturalTops[2] += 200;
        naturalTops[3] += 200;
        if (scenario.dirtyGeometry) {
          naturalTops[3] += 24;
          app.markStickyHunkOriginsDirty(secondState);
        }
        viewport.scrollY = scenario.dirtyGeometry ? 1_824 : 1_800;
        let firstOriginReads = 0;
        let secondOriginReads = 0;
        const stickyHunkNaturalDocumentTop =
          app.stickyHunkNaturalDocumentTop.bind(app);
        app.stickyHunkNaturalDocumentTop = (controller, options) => {
          if (options?.refreshLayout) {
            firstOriginReads += Number(controller.fileElement === firstState.fileElement);
            secondOriginReads += Number(controller.fileElement === secondState.fileElement);
          }
          return stickyHunkNaturalDocumentTop(controller, options);
        };
        secondFileRectReads = 0;
        const scrollCalls = [];
        dom.window.scrollTo = (options) => scrollCalls.push(options);
        app[scenario.busyField] = true;

        await scenario.interact({
          app,
          controller: secondSecond,
          dom,
        });
        await waitFor(() => assert.equal(secondSecond.collapsed, true));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(firstOriginReads, 0);
        assert.equal(secondOriginReads, scenario.dirtyGeometry ? 4 : 2);
        assert.equal(
          firstState.preparedOriginLayoutGeneration <
            firstState.originLayoutGeneration,
          true,
        );
        assert.equal(secondState.fileOriginDirty, false);
        assert.equal(
          secondState.preparedOriginLayoutGeneration ===
            secondState.originLayoutGeneration,
          true,
        );
        assert.equal(secondFileRectReads, 2);
        assert.equal(secondSecond.stickyHunkOriginDocumentTop,
          scenario.dirtyGeometry ? 1_824 : 1_800);
        assert.equal(
          secondFirst.hunkRow.classList.contains(
            "hunkmark-sticky-hunk-active",
          ),
          false,
        );
        assert.equal(
          secondSecond.hunkRow.classList.contains(
            "hunkmark-sticky-hunk-active",
          ),
          true,
        );
        assert.equal(scrollCalls.length, 1);
        assert.equal(scrollCalls[0].top, scenario.dirtyGeometry ? 1_823 : 1_799);
        assert.equal(firstSecond.marked, false);
      } finally {
        app.refreshQueued = false;
        app.refreshRunning = false;
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("remeasures a collapsed React hunk after preceding layout changes", async () => {
  const html = `<!doctype html>
    <html><body>
      <section data-file-path="src/grid.ts">
        <header>src/grid.ts</header>
        <div role="row"><div role="gridcell" class="diff-hunk-cell">@@ -1 +1 @@</div></div>
        <div role="row" data-line-type="addition"><div role="gridcell" class="diff-text-cell">+first</div></div>
        <div role="row"><div role="gridcell" class="diff-hunk-cell">@@ -20 +20 @@</div></div>
        <div role="row" data-line-type="addition"><div role="gridcell" class="diff-text-cell">+second</div></div>
      </section>
    </body></html>`;
  const { app, dom } = await startExtension(html);
  try {
    const [, controller] = Array.from(app.controllersByRow.values());
    controller.collapsed = true;
    app.applyControllerAppearance(controller);
    assert.equal(
      controller.groupRows[1].classList.contains("hunkmark-collapsed"),
      true,
    );

    controller.stickyHunkOriginDocumentTop = 600;
    controller.hunkRow.classList.add(
      "hunkmark-sticky-hunk-active",
      "hunkmark-sticky-hunk-prepared",
    );
    controller.hunkRow.getBoundingClientRect = () => ({
      height: 24,
      top: controller.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-prepared",
      ) && !controller.fileElement.classList.contains("hunkmark-sticky-file-measuring")
        ? 40
        : 500,
    });

    assert.equal(
      app.stickyHunkNaturalDocumentTop(controller, {
        refreshLayout: true,
      }),
      500,
    );
    assert.equal(controller.stickyHunkOriginDocumentTop, 500);
    assert.equal(
      controller.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      ),
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("offers keyboard return navigation and honors reduced motion", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(
      controllers[0].fileElement,
    );
    mockStickyRows(dom, controllers, [20, 80]);
    state.stickyTop = 40;
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkLayouts();

    assert.equal(controllers[0].returnButton.hidden, false);
    assert.equal(controllers[0].returnButton.tabIndex, 0);
    assert.equal(controllers[1].returnButton.hidden, true);

    dom.window.matchMedia = () => ({ matches: true });
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 400;
    controllers[0].returnButton.focus();
    controllers[0].returnButton.click();

    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].behavior, "auto");
    assert.equal(scrollCalls[0].top, 359);
    assert.equal(dom.window.document.activeElement, controllers[0].input);

    controllers[0].stickyHunkContentInset = 16;
    controllers[0].returnButton.click();
    assert.equal(scrollCalls.length, 2);
    assert.equal(scrollCalls[1].top, 359);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("returns a manually collapsed sticky hunk to its cached origin", async () => {
  const html = duplicateHunkFixture().replace(
    '<div class="file-header">',
    '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
  );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const current = controllers[1];
    const viewport = mockStickyRows(dom, controllers, [200, 400]);
    viewport.scrollY = 200;
    app.invalidateStickyHunkOrigins(current.fileElement);
    app.updateStickyHunkLayouts();
    viewport.scrollY = 400;
    assert.equal(current.returnButton.hidden, true);

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 400;

    current.collapseButton.getBoundingClientRect = () => ({ top: 40 });
    current.collapseButton.focus();
    current.collapseButton.dispatchEvent(
      new dom.window.Event("pointerdown", { bubbles: true }),
    );
    assert.equal(current.returnButton.hidden, false);
    current.collapseButton.click();
    await waitFor(() => {
      assert.equal(current.collapsePending, false);
      assert.equal(current.collapsed, true);
      assert.equal(scrollCalls.length, 1);
    });
    assert.equal(scrollCalls[0].behavior, "smooth");
    assert.equal(scrollCalls[0].top, 359);
    assert.equal(
      dom.window.document.activeElement,
      current.collapseButton,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("looks up a scheduled sticky return without sorting every hunk", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const target = controllers.at(-1);
    controllers.forEach((controller) => {
      controller.hunkRow.compareDocumentPosition = () => {
        throw new Error("Scheduled returns must not sort hunk rows");
      };
    });

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 600;

    app.scheduleStickyHunkReturn(target.key);
    await waitFor(() => {
      assert.equal(scrollCalls.length, 1);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

for (const scenario of [
  {
    expectedScrollCalls: 0,
    name: "does not auto-return after the user points elsewhere while collapse state saves",
    prepare({ dom }) {
      return () => {
        dom.window.document.body.dispatchEvent(
          new dom.window.Event("pointerdown", { bubbles: true }),
        );
      };
    },
  },
  {
    expectedScrollCalls: 1,
    name: "keeps auto-return pending across layout-only scroll and programmatic clicks",
    prepare({ app, dom }) {
      const navigationGeneration = app.hunkStickyNavigationGeneration;
      return () => {
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
        dom.window.document.body.click();
        assert.equal(
          app.hunkStickyNavigationGeneration,
          navigationGeneration,
        );
      };
    },
  },
  {
    expectedScrollCalls: 0,
    name: "cancels auto-return after scroll-only user movement",
    prepare({ dom }) {
      let virtualScroll = 0;
      Object.defineProperty(dom.window, "scrollY", {
        configurable: true,
        get: () => virtualScroll,
      });
      return () => {
        virtualScroll = 240;
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
      };
    },
  },
]) {
  test(scenario.name, async () => {
    const html = duplicateHunkFixture().replace(
      '<div class="file-header">',
      '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
    );
    const { app, dom } = await startExtension(html);
    try {
      const [current] = Array.from(app.controllersByRow.values());
      current.hunkRow.classList.add("hunkmark-sticky-hunk-active");

      let finishSaving;
      app.setReviewStorage = () =>
        new Promise((resolve) => {
          finishSaving = resolve;
        });
      const scrollCalls = [];
      dom.window.scrollTo = (options) => scrollCalls.push(options);
      const signalNavigation = scenario.prepare({ app, dom });

      const collapsing = app.setCollapsed(current, true);
      signalNavigation();
      finishSaving();
      await collapsing;
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(current.collapsed, true);
      assert.equal(scrollCalls.length, scenario.expectedScrollCalls);
    } finally {
      app.stop();
      dom.window.close();
    }
  });
}

test("cancels a scheduled sticky return when the user navigates", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const [, target] = Array.from(app.controllersByRow.values());
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 600;

    app.scheduleStickyHunkReturn(target.key);
    dom.window.dispatchEvent(new dom.window.Event("wheel"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(scrollCalls.length, 0);
    assert.equal(app.hunkStickyScrollFrameId, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("cancels a scheduled sticky return when the route changes", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const [, target] = Array.from(app.controllersByRow.values());
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 600;
    const navigationGeneration = app.hunkStickyNavigationGeneration;

    app.scheduleStickyHunkReturn(target.key);
    dom.window.history.pushState({}, "", "/octo/repo/pull/123");
    assert.equal(app.checkForNavigation(), true);
    assert.equal(
      app.hunkStickyNavigationGeneration,
      navigationGeneration + 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(scrollCalls.length, 0);
    assert.equal(app.hunkStickyScrollFrameId, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("separates external file translation from internal hunk geometry", async () => {
  const resizeObservers = [];
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      resizeObservers.push(this);
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
  }

  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    resizeObserverClass: TestResizeObserver,
  });
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = Array.from(app.hunkStickyStateByFile.values())[0];
    const controllers = Array.from(state.controllers);
    const fileLayoutObserver = resizeObservers.find(
      (observer) =>
        observer.observed.has(dom.window.document.body) &&
        observer.observed.has(state.fileElement),
    );
    assert.ok(fileLayoutObserver);
    let fileTop = 100;
    state.fileElement.getBoundingClientRect = () => ({ top: fileTop });
    let rowGeometryReads = 0;
    const naturalTops = controllers.map((controller, index) => {
      const top = 300 + index * 200;
      controller.hunkRow.getBoundingClientRect = () => {
        rowGeometryReads += 1;
        return { height: 24, top };
      };
      return top;
    });
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkLayouts();
    if (app.hunkStickyLayoutFrameId !== null) {
      dom.window.cancelAnimationFrame(app.hunkStickyLayoutFrameId);
      app.hunkStickyLayoutFrameId = null;
    }
    const timelineStyles = controllers.map(
      (controller) => controller.hunkRow.style.cssText,
    );
    const cachedOrigins = controllers.map(
      (controller) => controller.stickyHunkOriginDocumentTop,
    );
    const originGenerationBeforeMutation = state.originLayoutGeneration;
    let refreshCalls = 0;
    const originalRefresh = app.refresh.bind(app);
    app.refresh = async () => {
      refreshCalls += 1;
      return originalRefresh();
    };
    const invalidations = [];
    const invalidateVisibleStickyHunkOrigins =
      app.invalidateVisibleStickyHunkOrigins.bind(app);
    app.invalidateVisibleStickyHunkOrigins = (options) => {
      invalidations.push(options);
      return invalidateVisibleStickyHunkOrigins(options);
    };

    rowGeometryReads = 0;
    fileTop = 180;
    const unrelated = dom.window.document.createElement("aside");
    unrelated.textContent = "unrelated notification";
    dom.window.document.body.append(unrelated);
    await waitFor(() => {
      assert.equal(
        invalidations.some((options) => options?.translationOnly),
        true,
      );
      assert.equal(
        state.fileElement.style.getPropertyValue(
          "--hunkmark-sticky-hunk-file-start",
        ),
        `${fileTop - state.stickyTop}px`,
      );
    });

    assert.equal(rowGeometryReads, 0);
    assert.deepEqual(
      controllers.map(
        (controller) => app.cachedStickyHunkNaturalDocumentTop(controller),
      ),
      cachedOrigins.map((origin) => origin + 80),
    );
    assert.deepEqual(
      controllers.map((controller) => controller.stickyHunkOriginDocumentTop),
      cachedOrigins,
    );
    assert.deepEqual(
      controllers.map((controller) => controller.hunkRow.style.cssText),
      timelineStyles,
    );
    assert.equal(state.fileOriginDirty, false);
    assert.equal(
      state.originLayoutGeneration,
      originGenerationBeforeMutation,
    );
    assert.equal(refreshCalls, 0);

    fileLayoutObserver.callback(
      [{ target: dom.window.document.body }],
      fileLayoutObserver,
    );
    assert.equal(state.fileOriginDirty, true);
    assert.equal(
      state.originLayoutGeneration,
      originGenerationBeforeMutation,
    );

    const generationBeforeFileResize = state.originLayoutGeneration;
    fileLayoutObserver.callback(
      [{ target: state.fileElement }],
      fileLayoutObserver,
    );
    assert.equal(
      state.originLayoutGeneration,
      generationBeforeFileResize + 1,
    );
    assert.equal(state.fileOriginDirty, true);

    const changedLine = dom.window.document.querySelector(
      "td.blob-code-addition",
    );
    changedLine.prepend("updated ");
    await waitFor(() => {
      assert.equal(refreshCalls, 1);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("remeasures file-relative hunk origins after an identity-safe diff mutation", async () => {
  const fixture = new JSDOM(
    currentReactOverlappingContextExpansionFixture(),
  );
  const region = fixture.window.document.querySelector('[role="region"]');
  const nestedGrid = region.querySelector('[role="grid"]').cloneNode(true);
  nestedGrid.querySelectorAll(".diff-hunk-cell").forEach((cell, index) => {
    const line = 100 + index * 10;
    cell.textContent = `@@ -${line} +${line} @@ nested${index}()`;
  });
  nestedGrid.querySelectorAll("[data-line-anchor]").forEach((cell, index) => {
    cell.dataset.lineAnchor = `diff-overlap-N${index}`;
    cell.querySelector("code").textContent = `+nested${index}`;
  });
  const nestedFile = fixture.window.document.createElement("div");
  nestedFile.className = "js-file";
  nestedFile.dataset.filePath = "src/react-overlap.js";
  nestedFile.append(nestedGrid);
  region.append(nestedFile);
  const html = fixture.serialize();
  fixture.window.close();
  const { app, dom } = await startExtension(html);
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 6);
    });
    const liveRegion = dom.window.document.querySelector('[role="region"]');
    const liveNestedFile = liveRegion.querySelector(".js-file");
    const controllers = Array.from(app.controllersByRow.values());
    const outerControllers = controllers.filter(
      (controller) => controller.fileElement === liveRegion,
    );
    const innerControllers = controllers.filter(
      (controller) => controller.fileElement === liveNestedFile,
    );
    assert.equal(outerControllers.length, 3);
    assert.equal(innerControllers.length, 3);
    const outerState = app.hunkStickyStateByFile.get(liveRegion);
    const innerState = app.hunkStickyStateByFile.get(liveNestedFile);
    liveRegion.getBoundingClientRect = () => ({ top: 100 });
    liveNestedFile.getBoundingClientRect = () => ({ top: 800 });
    const naturalTops = controllers.map((_, index) => 300 + index * 200);
    mockStickyRows(dom, controllers, naturalTops);
    app.invalidateStickyHunkOrigins(liveRegion);
    app.invalidateStickyHunkOrigins(liveNestedFile);
    app.updateStickyHunkLayouts();
    if (app.hunkStickyLayoutFrameId !== null) {
      dom.window.cancelAnimationFrame(app.hunkStickyLayoutFrameId);
      app.hunkStickyLayoutFrameId = null;
    }
    let descendantOwnershipScans = 0;
    const querySelectorAll = liveRegion.querySelectorAll.bind(liveRegion);
    liveRegion.querySelectorAll = (selector) => {
      descendantOwnershipScans += Number(
        selector === ".hunkmark-sticky-hunk-row",
      );
      return querySelectorAll(selector);
    };

    const outerGenerationBeforeMutation = outerState.originLayoutGeneration;
    const innerGenerationBeforeMutation = innerState.originLayoutGeneration;
    let refreshCalls = 0;
    const refresh = app.refresh.bind(app);
    app.refresh = async () => {
      refreshCalls += 1;
      return refresh();
    };
    const auxiliary = dom.window.document.createElement("span");
    auxiliary.dataset.hostAuxiliary = "true";
    auxiliary.style.height = "8px";
    naturalTops[4] = 1_120;
    naturalTops[5] = 1_320;
    innerControllers[0].lines[0].element.append(auxiliary);
    await waitFor(() => {
      assert.equal(refreshCalls, 0);
      assert.equal(descendantOwnershipScans, 0);
      assert.equal(
        outerState.originLayoutGeneration,
        outerGenerationBeforeMutation + 1,
      );
      assert.equal(
        innerState.originLayoutGeneration,
        innerGenerationBeforeMutation + 1,
      );
      assert.equal(
        outerState.preparedOriginLayoutGeneration,
        outerState.originLayoutGeneration,
      );
      assert.equal(
        innerState.preparedOriginLayoutGeneration,
        innerState.originLayoutGeneration,
      );
      assert.equal(
        innerControllers[1].stickyHunkOriginDocumentTop,
        naturalTops[4],
      );
      assert.equal(
        innerControllers[1].hunkRow.style.getPropertyValue(
          "--hunkmark-sticky-hunk-compress-start",
        ),
        "320px",
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("invalidates unrelated DOM layout immediately without ResizeObserver", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    setupWindow(window) {
      window.ResizeObserver = undefined;
    },
  });
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    assert.equal(app.hunkStickyFileLayoutObserver, null);
    const state = Array.from(app.hunkStickyStateByFile.values())[0];
    await waitFor(() => {
      assert.equal(state.fileOriginDirty, false);
    });
    const originGenerationBeforeMutation = state.originLayoutGeneration;
    const unrelated = dom.window.document.createElement("aside");
    unrelated.textContent = "unrelated notification";
    dom.window.document.body.append(unrelated);

    await waitFor(() => {
      assert.equal(
        state.originLayoutGeneration,
        originGenerationBeforeMutation + 1,
      );
    });
    assert.equal(state.fileOriginDirty, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps settings behind an accessible gear menu", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.ok(dom.window.document.getElementById("hunkmark-panel"));
    });

    const panel = dom.window.document.getElementById("hunkmark-panel");
    const settingsButton = panel.querySelector(
      'button[aria-label="HunkMark settings"]',
    );
    const settings = panel.querySelector("#hunkmark-panel-settings");

    assert.ok(settingsButton);
    assert.ok(settings);
    const settingsIcon = settingsButton.querySelector(
      "svg.hunkmark-settings-icon",
    );
    assert.ok(settingsIcon);
    assert.equal(settingsIcon.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(settingsIcon.getAttribute("viewBox"), "0 0 16 16");
    assert.equal(settingsIcon.getAttribute("aria-hidden"), "true");
    assert.ok(settingsIcon.querySelector("path")?.getAttribute("d"));
    assert.equal(settingsButton.getAttribute("aria-expanded"), "false");
    assert.equal(
      settingsButton.getAttribute("aria-controls"),
      settings.id,
    );
    assert.equal(settings.hidden, true);
    assert.equal(settings.getAttribute("role"), "dialog");
    assert.ok(
      settings.querySelector(
        'input[aria-label="Automatically collapse viewed hunks"]',
      ),
    );
    assert.ok(
      settings.querySelector('input[aria-label="Link split diff sides"]'),
    );
    assert.equal(
      settings.querySelector(
        'input[aria-label="Sync GitHub file Viewed"]',
      ).checked,
      true,
    );
    assert.deepEqual(
      Array.from(
        settings.querySelectorAll(".hunkmark-panel-toggle > span"),
        (label) => label.textContent,
      ),
      [
        "Auto-collapse hunks",
        "Sync GitHub file Viewed",
        "Link split sides",
      ],
    );
    assert.equal(
      settings.querySelector(".hunkmark-reset-button").textContent,
      "Reset page",
    );

    settingsButton.click();
    assert.equal(settings.hidden, false);
    assert.equal(settingsButton.getAttribute("aria-expanded"), "true");

    const settingsInput = settings.querySelector(
      'input[aria-label="Automatically collapse viewed hunks"]',
    );
    const dispatchPointerDown = (target) =>
      target.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
        }),
      );
    const summary = panel.querySelector(".hunkmark-panel-summary");
    dom.window.document.body.tabIndex = -1;

    settingsButton.focus();
    dispatchPointerDown(summary);
    dom.window.document.body.focus();
    summary.click();
    assert.equal(settings.hidden, true);
    assert.equal(settingsButton.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, settingsButton);

    settingsButton.click();
    settingsInput.focus();
    dispatchPointerDown(summary);
    dom.window.document.body.focus();
    summary.click();
    assert.equal(settings.hidden, true);
    assert.equal(dom.window.document.activeElement, settingsButton);

    settingsButton.click();
    const outsideButton = dom.window.document.createElement("button");
    dom.window.document.body.append(outsideButton);
    settingsInput.focus();
    dispatchPointerDown(outsideButton);
    outsideButton.focus();
    outsideButton.click();
    assert.equal(settings.hidden, true);
    assert.equal(dom.window.document.activeElement, outsideButton);

    settingsButton.click();
    dom.window.document.body.click();
    assert.equal(settings.hidden, true);
    assert.equal(settingsButton.getAttribute("aria-expanded"), "false");

    settingsButton.click();
    const escape = new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    dom.window.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(settings.hidden, true);
    assert.equal(settingsButton.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, settingsButton);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("uses the current React file container for panel clearance", async () => {
  const { app, dom } = await startExtension(modernGridFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    const fileElement = dom.window.document.querySelector(
      "section.position-relative",
    );
    const pathButton = dom.window.document.querySelector(
      "button[data-file-path]",
    );
    dom.window.document
      .querySelector('button[aria-label="Not Viewed"]')
      .remove();
    Array.from(app.controllersByRow.values()).forEach((controller) =>
      app.destroyController(controller),
    );
    fileElement
      .querySelectorAll('[role="row"]')
      .forEach((row) => row.remove());
    fileElement.append(
      Object.assign(dom.window.document.createElement("button"), {
        textContent: "Load Diff",
      }),
    );
    panel.style.bottom = "18px";
    panel.getBoundingClientRect = () => ({ height: 40 });
    fileElement.getBoundingClientRect = () => ({ bottom: 300 });
    spacer.getBoundingClientRect = () => ({ top: 320 });

    assert.equal(app.controllersByRow.size, 0);
    assert.equal(app.lastPanelClearanceFile(), fileElement);
    assert.notEqual(app.lastPanelClearanceFile(), pathButton);
    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "54px");
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("adds only the missing panel clearance after the last file", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    panel.style.bottom = "18px";
    let panelLayoutReads = 0;
    panel.getBoundingClientRect = () => {
      panelLayoutReads += 1;
      return { height: 40 };
    };
    const fileElement = Array.from(app.controllersByRow.values())[0].fileElement;
    fileElement.getBoundingClientRect = () => ({ bottom: 300 });
    let rowLayoutReads = 0;
    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.groupRows.forEach((row) => {
        row.getClientRects = () => {
          throw new Error("Panel clearance must not inspect row visibility");
        };
        row.getBoundingClientRect = () => {
          rowLayoutReads += 1;
          return { bottom: 400 };
        };
      });
    });
    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    spacer.getBoundingClientRect = () => ({ top: 400 });
    spacer.style.height = "0px";
    app.updatePanelClearance(panel, spacer, fileElement);
    assert.equal(spacer.style.height, "74px");
    assert.equal(rowLayoutReads, 1);

    const collapsedFile = dom.window.document.createElement("section");
    collapsedFile.className = "js-file";
    collapsedFile.innerHTML = '<button aria-label="Expand file">Expand</button>';
    collapsedFile.getBoundingClientRect = () => ({ bottom: 470 });
    dom.window.document.body.insertBefore(collapsedFile, panel);
    spacer.getBoundingClientRect = () => ({ top: 470 });
    spacer.style.height = "0px";
    app.ensurePanelClearance(panel);
    assert.equal(spacer.style.height, "74px");

    const unresolvedFile = dom.window.document.createElement("section");
    unresolvedFile.className = "js-file";
    unresolvedFile.innerHTML = "<button>Load Diff</button>";
    unresolvedFile.getBoundingClientRect = () => ({ bottom: 500 });
    dom.window.document.body.insertBefore(unresolvedFile, panel);
    spacer.getBoundingClientRect = () => ({ top: 500 });
    spacer.style.height = "0px";
    app.ensurePanelClearance(panel);
    assert.equal(spacer.style.height, "74px");

    spacer.getBoundingClientRect = () => ({ top: 600 });
    spacer.style.height = "0px";
    app.updatePanelClearance(panel, spacer, unresolvedFile);
    assert.equal(spacer.style.height, "0px");

    spacer.getBoundingClientRect = () => ({ top: 480 });
    app.updatePanelClearance(panel, spacer, unresolvedFile);
    assert.equal(spacer.style.height, "94px");

    const layoutReadsBeforeStableEnsure = panelLayoutReads;
    app.ensurePanelClearance(panel);
    assert.equal(panelLayoutReads, layoutReadsBeforeStableEnsure);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("limits synchronous interaction layout to the target hunk's file", async () => {
  const fixture = new JSDOM(duplicateHunkFixture());
  const second = fixture.window.document.querySelector('.js-file').cloneNode(true);
  second.dataset.filePath = 'src/other.js';
  fixture.window.document.body.append(second);
  const html = fixture.serialize();
  fixture.window.close();
  const { app, dom } = await startExtension(html);
  try {
    app.observer.disconnect();
    const [controller] = app.controllersByRow.values();
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    const updated = [];
    app.updateStickyHunkState = (target) => updated.push(target);
    const unrelated = dom.window.document.createElement('button');
    dom.window.document.body.append(unrelated);
    for (const type of ['click', 'pointerdown', 'keydown']) {
      unrelated.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
      assert.deepEqual(updated, []);
      controller.hunkCell.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
      assert.deepEqual(updated.splice(0), [state]);
    }
    controller.lines[0].element.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.deepEqual(updated, [state]);
  } finally {
    app.stop(); dom.window.close();
  }
});

test("cancels sticky returns for trusted clicks without canceling programmatic clicks", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const target = dom.window.document.createElement('button');
    dom.window.document.body.append(target);
    app.hunkStickyScrollFrameId = 41;
    const generation = app.hunkStickyNavigationGeneration;
    app.boundStickyHunkNavigationIntent({ type: 'click', isTrusted: true, target });
    assert.equal(app.hunkStickyScrollFrameId, null);
    assert.equal(app.hunkStickyNavigationGeneration, generation + 1);
    app.hunkStickyScrollFrameId = 42;
    app.boundStickyHunkNavigationIntent({ type: 'click', isTrusted: false, target });
    assert.equal(app.hunkStickyScrollFrameId, 42);
    assert.equal(app.hunkStickyNavigationGeneration, generation + 1);
  } finally {
    app.stop(); dom.window.close();
  }
});

test("restores equal animation ranges when hunk rows move to a replacement file root", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    app.observer.disconnect();
    const controllers = Array.from(app.controllersByRow.values());
    const [controller] = controllers;
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    mockStickyRows(dom, controllers, [100, 200]);
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    const ranges = controllers.map((c) => c.hunkRow.style.getPropertyValue('--hunkmark-sticky-hunk-push-end'));
    const replacement = state.fileElement.cloneNode(false);
    replacement.append(...state.fileElement.childNodes);
    state.fileElement.replaceWith(replacement);
    await app.refresh();
    assert.deepEqual(Array.from(app.controllersByRow.values()), controllers);
    controllers.forEach((c, index) => {
      assert.equal(c.fileElement, replacement);
      assert.equal(c.hunkRow.style.getPropertyValue('--hunkmark-sticky-hunk-push-end'), ranges[index]);
      assert.ok(c.hunkRow.classList.contains('hunkmark-sticky-hunk-prepared'));
    });
  } finally {
    app.stop(); dom.window.close();
  }
});

test("resolves file translation without rewriting every cached hunk origin", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(512, 48, { hunkSize: 1 }), {}, { scopeWaitTimeoutMs: 15000 },
  );
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const tops = controllers.map((_, index) => 500 + index * 100);
    mockStickyRows(dom, controllers, tops);
    let fileTop = 100;
    state.fileElement.getBoundingClientRect = () => ({ top: fileTop });
    app.invalidateStickyHunkOrigins(state.fileElement);
    app.updateStickyHunkState(state);
    controllers.forEach((c) => app.stickyHunkNaturalDocumentTop(c, {
      refreshLayout: true, originLayoutGeneration: state.originLayoutGeneration,
    }));
    let rewritten = 0;
    controllers.forEach((c) => {
      let origin = c.stickyHunkOriginDocumentTop;
      Object.defineProperty(c, 'stickyHunkOriginDocumentTop', {
        configurable: true, get: () => origin,
        set(value) { rewritten += 1; origin = value; },
      });
      c.hunkRow.getBoundingClientRect = () => { throw new Error('translation must reuse row geometry'); };
    });
    fileTop += 80;
    app.markStickyHunkFileOriginDirty(state);
    app.updateStickyHunkState(state);
    assert.equal(rewritten, 0);
    for (const index of [0, 200, 511]) {
      assert.equal(app.stickyHunkNaturalDocumentTop(controllers[index], {
        originLayoutGeneration: state.originLayoutGeneration,
      }), tops[index] + 80);
    }
  } finally {
    app.stop(); dom.window.close();
  }
});
