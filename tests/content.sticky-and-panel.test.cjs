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
} = require("./content-test-support.cjs");

test("defines the sticky hunk stylesheet contract", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  try {
    const style = installContentStyles(dom);
    const rules = Array.from(style.sheet.cssRules);
    const ruleFor = (selector) => {
      const rule = rules.find((candidate) => candidate.selectorText === selector);
      assert.ok(rule, `Missing CSS rule: ${selector}`);
      return rule;
    };

    const headerRule = ruleFor(".hunkmark-sticky-file-header");
    const activeRule = ruleFor(".hunkmark-sticky-hunk-active");
    const pastRule = ruleFor(".hunkmark-sticky-hunk-past");
    const focusedPastRule = ruleFor(
      ".hunkmark-sticky-hunk-past:focus-within",
    );
    assert.equal(headerRule.style.zIndex, "5");
    assert.equal(headerRule.style.getPropertyPriority("z-index"), "important");
    assert.equal(activeRule.style.position, "sticky");
    assert.match(activeRule.style.top, /--hunkmark-sticky-hunk-top/);
    assert.match(activeRule.style.clipPath, /--hunkmark-sticky-hunk-content-inset/);
    assert.deepEqual(
      [pastRule.style.opacity, pastRule.style.pointerEvents],
      ["0", "none"],
    );
    assert.deepEqual(
      [focusedPastRule.style.opacity, focusedPastRule.style.pointerEvents],
      ["1", "auto"],
    );

    const keyframes = new Map(
      rules.filter((rule) => rule.name).map((rule) => [rule.name, rule]),
    );
    for (const [phase, variable] of [
      ["compress", "top-clip"],
      ["tail", "bottom-clip"],
      ["push", "push-distance"],
    ]) {
      for (const suffix of ["a", "b"]) {
        const name = `hunkmark-sticky-hunk-${phase}-${suffix}`;
        assert.match(
          keyframes.get(name)?.cssText ?? "",
          new RegExp(`--hunkmark-sticky-hunk-${variable}`),
        );
      }
    }
    for (const [phase, property, animation] of [
      ["phase-a", "compress", "compress-a"],
      ["phase-a", "tail", "tail-a"],
      ["phase-b", "compress", "compress-b"],
      ["phase-b", "tail", "tail-b"],
      ["push-phase-a", "push", "push-a"],
      ["push-phase-b", "push", "push-b"],
    ]) {
      assert.equal(
        ruleFor(`.hunkmark-sticky-hunk-${phase}`).style.getPropertyValue(
          `--hunkmark-sticky-hunk-${property}-animation`,
        ),
        `hunkmark-sticky-hunk-${animation}`,
      );
    }

    const animationContracts = [
      [
        ".hunkmark-sticky-hunk-active.hunkmark-sticky-hunk-pushing",
        ["push-start", "push-end"],
        ["push-animation"],
      ],
      [
        ".hunkmark-sticky-hunk-compressing",
        ["compress-start", "compress-end", "tail-start", "tail-end"],
        ["compress-animation", "tail-animation"],
      ],
      [
        ".hunkmark-sticky-hunk-active.hunkmark-sticky-hunk-compressing.hunkmark-sticky-hunk-pushing",
        ["compress-start", "tail-start", "push-start"],
        ["compress-animation", "tail-animation", "push-animation"],
      ],
    ];
    animationContracts.forEach(([selector, ranges, names]) => {
      const rule = ruleFor(selector);
      assert.match(rule.style.animationTimeline, /scroll\(root block\)/);
      ranges.forEach((range) => {
        assert.match(
          rule.style.animationRange,
          new RegExp(`--hunkmark-sticky-hunk-${range}`),
        );
      });
      names.forEach((name) => {
        assert.match(
          rule.style.animationName,
          new RegExp(`--hunkmark-sticky-hunk-${name}`),
        );
      });
    });
    const clipRule = rules.find(
      (rule) =>
        rule.selectorText?.startsWith(".hunkmark-sticky-hunk-compressing,") &&
        rule.style?.clipPath,
    );
    assert.match(clipRule?.style.clipPath ?? "", /--hunkmark-sticky-hunk-top-clip/);
    assert.match(
      clipRule?.style.clipPath ?? "",
      /--hunkmark-sticky-hunk-bottom-clip/,
    );

    const css = style.textContent;
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(
      css,
      /hunkmark-sticky-hunk-pushing[^}]+animation-timing-function: steps\(1, end\)/s,
    );
    assert.match(
      css,
      /hunkmark-sticky-hunk-compressing\.hunkmark-sticky-hunk-pushing[^}]+animation-timing-function: linear, linear, steps\(1, end\)/s,
    );
    assert.doesNotMatch(css, /aria-label\^="Expand "/);
    assert.doesNotMatch(css, /class\*="expand-button"/);
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
        app.stickyHunkNaturalViewportTop = (candidate) =>
          candidate === controller ? 40 : 1000;
        app.updateStickyHunkState(state);
        assert.equal(
          row.classList.contains("hunkmark-sticky-hunk-active"),
          true,
        );
        assert.equal(state.timelineController, null);
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
        assert.equal(state.timelineController, null);
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
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    let measurementCount = 0;
    const measureStickyHunkContentInset =
      app.measureStickyHunkContentInset.bind(app);
    app.measureStickyHunkContentInset = (...args) => {
      measurementCount += 1;
      return measureStickyHunkContentInset(...args);
    };
    rowObserver.callback([{ target: row }]);

    assert.equal(measurementCount, 0);
    await waitFor(() => {
      assert.equal(controller.stickyHunkContentInset, 12);
    });
    assert.equal(measurementCount, 1);
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

test("keeps the original wrapped hunk height while its visible band is compact", async () => {
  const html = duplicateHunkFixture().replace(
    "@@ -1 +1 @@",
    [
      '<button aria-label="Expand file down from line 1">↓</button>',
      '<button aria-label="Expand file up from line 50">↑</button>',
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
      value: 72,
    });
    row.getBoundingClientRect = () => rect(40, 72);
    text.getBoundingClientRect = () => rect(52, 48, 140, 600);

    syncStickyHunkContentInset(app, controller);
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    state.controllers = new Set([controller]);
    state.orderDirty = true;
    state.stickyTop = 40;
    let naturalTop = 28;
    let virtualScroll = 0;
    Object.defineProperty(dom.window, "scrollY", {
      configurable: true,
      get: () => virtualScroll,
    });
    app.stickyHunkNaturalViewportTop = () => naturalTop;
    app.updateStickyHunkLayouts();

    assert.equal(controller.stickyHunkCompactHeight, 48);
    assert.equal(controller.stickyHunkContentInset, 12);
    assert.equal(controller.stickyHunkBottomInset, 12);
    assert.equal(state.timelineController, controller);
    assert.equal(
      row.classList.contains("hunkmark-sticky-hunk-compressing"),
      true,
    );
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-start",
      ),
      "0px",
    );
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-end",
      ),
      "12px",
    );
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-start",
      ),
      "0px",
    );
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-end",
      ),
      "12px",
    );
    let timelineStyleWrites = 0;
    const setTimelineStyle = row.style.setProperty.bind(row.style);
    row.style.setProperty = (...args) => {
      timelineStyleWrites += 1;
      return setTimelineStyle(...args);
    };
    virtualScroll = 6;
    naturalTop = 22;
    app.updateStickyHunkLayouts();
    assert.equal(timelineStyleWrites, 0);
    assert.equal(row.getBoundingClientRect().height, 72);
    assert.equal(
      row.classList.contains("hunkmark-sticky-hunk-active"),
      true,
    );
    assert.equal(
      row.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "12px",
    );
    assert.equal(
      row.style.getPropertyValue("--hunkmark-sticky-hunk-bottom-inset"),
      "12px",
    );
    assert.equal(
      row.querySelectorAll(".hunkmark-hunk-actions").length,
      1,
    );
    assert.equal(
      dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"),
      null,
    );
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

test("uses the original row when a plain hunk becomes active", async () => {
  const html = duplicateHunkFixture().replace(
    '<div class="file-header">',
    '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
  );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const controller = controllers[0];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    state.controllers = new Set([controller]);
    state.orderDirty = true;
    state.stickyTop = 40;
    const rect = (top, height, left = 20, width = 600) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    });
    controller.hunkRow.getBoundingClientRect = () => rect(40, 24);
    let naturalTop = 41;
    app.stickyHunkNaturalViewportTop = () => naturalTop;
    installContentStyles(dom);

    app.updateStickyHunkLayouts();
    assert.notEqual(
      dom.window.getComputedStyle(controller.hunkRow).position,
      "sticky",
    );

    naturalTop = 40;
    app.updateStickyHunkLayouts();
    assert.equal(
      controller.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      ),
      true,
    );
    assert.equal(
      dom.window.getComputedStyle(controller.hunkRow).position,
      "sticky",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.hunkRow).visibility,
      "visible",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      controllers.length,
    );
    assert.equal(
      dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"),
      null,
    );
    assert.equal(controller.actions.parentElement, controller.hunkCell);

    controller.collapsed = true;
    app.applyControllerAppearance(controller);
    assert.equal(
      controller.collapseButton.getAttribute("aria-label"),
      "Expand this diff hunk",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.collapseButton).visibility,
      "visible",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.collapseButton).opacity,
      "1",
    );
    controller.collapsed = false;
    app.applyControllerAppearance(controller);

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 400;
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

    naturalTop = 41;
    app.updateStickyHunkLayouts();
    assert.notEqual(
      dom.window.getComputedStyle(controller.hunkRow).visibility,
      "hidden",
    );
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

test("measures a tall hunk and hides GitHub hunk affordances when sticky", async () => {
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
    assert.notEqual(
      dom.window.getComputedStyle(controller.hunkRow).position,
      "sticky",
    );
    assert.equal(controller.stickyHunkContentInset, 16);
    assert.equal(
      controller.hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "16px",
    );

    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    const auxiliaryElements = controller.hunkRow.querySelectorAll(
      '.hunk-kebab-icon, .js-expand, .js-expand-full, button[class*="ExpandableHunkHeaderDiffLine-module__"], [aria-label^="Expand file up"]',
    );
    assert.equal(auxiliaryElements.length, 7);
    auxiliaryElements.forEach((element) => {
      assert.equal(
        element.classList.contains("hunkmark-sticky-hunk-auxiliary"),
        true,
      );
      assert.equal(dom.window.getComputedStyle(element).visibility, "hidden");
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

test("keeps a sticky table hunk's natural position for scrolling and jumping", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[1];
    const table = controller.hunkRow.closest("table");
    let rowOffsetTop = 70;
    let rowTop = 100;
    Object.defineProperty(dom.window, "scrollY", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(controller.hunkRow, "offsetTop", {
      configurable: true,
      get: () => rowOffsetTop,
    });
    controller.hunkRow.getBoundingClientRect = () => ({
      bottom: rowTop + 60,
      height: 60,
      left: 0,
      right: 100,
      top: rowTop,
      width: 100,
      x: 0,
      y: rowTop,
    });
    table.getBoundingClientRect = () => ({
      bottom: 1200,
      height: 1000,
      left: 0,
      right: 100,
      top: 200,
      width: 100,
      x: 0,
      y: 200,
    });
    controller.stickyHunkOriginDocumentTop = 9999;

    assert.equal(app.stickyHunkNaturalDocumentTop(controller), 570);
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    rowOffsetTop = 0;
    rowTop = 40;
    assert.equal(app.stickyHunkNaturalDocumentTop(controller), 570);

    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    controller.stickyHunkOriginLayoutGeneration =
      state.originLayoutGeneration;
    state.stickyTop = 40;
    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    controller.hunkCell.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 529);

    const followingRow = controller.groupRows[1];
    Object.defineProperty(controller.hunkRow, "offsetHeight", {
      configurable: true,
      value: 60,
    });
    Object.defineProperty(followingRow, "offsetTop", {
      configurable: true,
      value: 84,
    });
    assert.equal(
      app.stickyHunkNaturalDocumentTop(controller, {
        refreshLayout: true,
      }),
      500,
    );

    controller.hunkRow.classList.remove("hunkmark-sticky-hunk-active");
    rowOffsetTop = 24;
    rowTop = 100;
    assert.equal(app.stickyHunkNaturalDocumentTop(controller), 524);
    assert.equal(controller.stickyHunkOriginDocumentTop, 524);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("reuses sticky hunk origins until their layout generation changes", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[1];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    const table = controller.hunkRow.closest("table");
    let scrollY = 300;
    let tableDocumentTop = 500;
    let offsetTopReads = 0;
    let tableRectReads = 0;
    Object.defineProperty(dom.window, "scrollY", {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(controller.hunkRow, "offsetTop", {
      configurable: true,
      get() {
        offsetTopReads += 1;
        return 70;
      },
    });
    table.getBoundingClientRect = () => {
      tableRectReads += 1;
      return { top: tableDocumentTop - scrollY };
    };
    state.controllers = new Set([controller]);
    state.contentLayoutDirtyControllers.clear();
    state.orderDirty = true;
    state.stickyTop = 40;
    controller.stickyHunkContentLayoutGeneration =
      state.contentLayoutGeneration;
    controller.stickyHunkOriginLayoutGeneration = null;

    app.updateStickyHunkState(state);
    assert.equal(controller.stickyHunkOriginDocumentTop, 570);
    assert.ok(offsetTopReads > 0);
    assert.ok(tableRectReads > 0);
    const readsAfterMeasurement = {
      offsetTop: offsetTopReads,
      tableRect: tableRectReads,
    };

    scrollY = 600;
    app.updateStickyHunkState(state);
    assert.deepEqual(
      { offsetTop: offsetTopReads, tableRect: tableRectReads },
      readsAfterMeasurement,
    );
    assert.equal(state.activeController, controller);

    const generationBeforeInvalidation = state.originLayoutGeneration;
    tableDocumentTop = 700;
    app.invalidateStickyHunkOrigins(controller.fileElement);
    assert.equal(
      state.originLayoutGeneration,
      generationBeforeInvalidation + 1,
    );
    app.updateStickyHunkState(state);

    assert.equal(controller.stickyHunkOriginDocumentTop, 770);
    assert.ok(offsetTopReads > readsAfterMeasurement.offsetTop);
    assert.ok(tableRectReads > readsAfterMeasurement.tableRect);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("bounds sticky hunk position measurements in a large file", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(128, 48, { hunkSize: 1 }),
  );
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(
      controllers[0].fileElement,
    );
    const indices = new Map(
      controllers.map((controller, index) => [controller, index]),
    );
    let measurementCount = 0;
    let contentMeasurementCount = 0;
    const measureStickyHunkContentInset =
      app.measureStickyHunkContentInset.bind(app);
    app.measureStickyHunkContentInset = (controller) => {
      contentMeasurementCount += 1;
      return measureStickyHunkContentInset(controller);
    };
    app.stickyHunkNaturalViewportTop = (controller) => {
      measurementCount += 1;
      return indices.get(controller) < 96 ? 20 : 80;
    };
    app.stickyHunkNaturalDocumentTop = () => {
      throw new Error("Sticky layout should reuse its measured position");
    };
    state.orderDirty = true;
    state.contentLayoutDirtyControllers.clear();
    app.markStickyHunkContentDirty(state);
    state.stickyTop = 40;

    assert.equal(state.contentLayoutDirtyControllers.size, 0);

    app.updateStickyHunkLayouts();

    assert.equal(state.activeController, controllers[95]);
    assert.ok(
      measurementCount <= Math.ceil(Math.log2(controllers.length)) + 1,
      `Expected logarithmic measurements, received ${measurementCount}`,
    );
    assert.ok(
      contentMeasurementCount <= Math.ceil(Math.log2(controllers.length)) + 3,
      `Expected lazy content measurements, received ${contentMeasurementCount}`,
    );
    assert.ok(
      controllers.some(
        (controller) =>
          controller.stickyHunkContentLayoutGeneration !==
          state.contentLayoutGeneration,
      ),
      "Expected off-boundary hunks to remain lazily unmeasured",
    );
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

    await app.refresh();

    assert.equal(measurementCount, 0);
    const states = Array.from(app.hunkStickyStateByFile.values());
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

test("updates only crossed sticky hunks during an adjacent handoff", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(128, 48, { hunkSize: 1 }),
  );
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(
      controllers[0].fileElement,
    );
    const indices = new Map(
      controllers.map((controller, index) => [controller, index]),
    );
    let activeCount = 96;
    app.stickyHunkNaturalViewportTop = (controller) =>
      indices.get(controller) < activeCount ? 20 : 80;
    state.orderDirty = true;
    state.stickyTop = 40;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[95]);
    let activeClassMutations = 0;
    let pastClassMutations = 0;
    const restorers = controllers.flatMap((controller) =>
      ["add", "remove", "toggle"].map((method) => {
        const classList = controller.hunkRow.classList;
        const original = classList[method].bind(classList);
        classList[method] = (...tokens) => {
          if (tokens.includes("hunkmark-sticky-hunk-active")) {
            activeClassMutations += 1;
          }
          if (tokens.includes("hunkmark-sticky-hunk-past")) {
            pastClassMutations += 1;
          }
          return original(...tokens);
        };
        return () => {
          classList[method] = original;
        };
      }),
    );

    activeCount = 97;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[96]);
    assert.equal(activeClassMutations, 2);
    assert.equal(pastClassMutations, 1);
    assert.equal(state.pastController, controllers[95]);

    activeClassMutations = 0;
    pastClassMutations = 0;
    activeCount = 98;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[97]);
    assert.equal(activeClassMutations, 2);
    assert.equal(pastClassMutations, 2);
    assert.equal(state.pastController, controllers[96]);
    assert.equal(
      controllers[95].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      false,
    );

    activeClassMutations = 0;
    pastClassMutations = 0;
    activeCount = 97;
    app.updateStickyHunkLayouts();
    restorers.forEach((restore) => restore());
    assert.equal(state.activeController, controllers[96]);
    assert.equal(activeClassMutations, 2);
    assert.equal(pastClassMutations, 1);
    assert.equal(state.pastController, null);
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
    const hiddenState = {
      activeController: null,
      candidateController: null,
      controllers: new Set(),
      fileElement: hiddenFile,
      header: null,
      pushController: null,
      timelineController: null,
      visible: false,
    };
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
      originGenerationBeforePageResize + 1,
    );

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

test("clears active sticky controls and passed-row paint state", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const positions = new Map([
      [controllers[0], 0],
      [controllers[1], 80],
    ]);
    app.stickyHunkNaturalViewportTop = (controller) =>
      positions.get(controller);
    state.contentLayoutDirtyControllers.clear();
    state.orderDirty = true;
    state.stickyTop = 40;
    app.updateStickyHunkState(state);
    assert.equal(state.activeController, controllers[0]);
    positions.set(controllers[1], 10);
    app.updateStickyHunkState(state);
    assert.equal(state.activeController, controllers[1]);
    assert.equal(state.pastController, controllers[0]);
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      true,
    );
    assert.equal(controllers[1].returnButton.hidden, false);
    assert.equal(controllers[1].returnButton.tabIndex, 0);
    const generationBeforeExit = state.contentLayoutGeneration;

    app.setStickyHunkStateVisibility(state, false);

    assert.equal(state.activeController, null);
    assert.equal(state.candidateController, null);
    assert.equal(state.pastController, null);
    assert.equal(state.contentLayoutGeneration, generationBeforeExit);
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      false,
    );
    assert.equal(
      controllers.some((controller) =>
        controller.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-active",
        ),
      ),
      false,
    );
    assert.equal(
      controllers.every(
        (controller) =>
          controller.returnButton.hidden &&
          controller.returnButton.tabIndex === -1,
      ),
      true,
    );

    app.setStickyHunkStateVisibility(state, true);
    assert.equal(
      state.contentLayoutGeneration,
      generationBeforeExit + 1,
    );
    assert.equal(state.contentLayoutDirtyControllers.size, 0);
    positions.set(controllers[1], 80);
    app.updateStickyHunkState(state);
    assert.equal(state.activeController, controllers[0]);
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("transfers focused sticky return control during a hunk handoff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
    const positions = new Map([
      [controllers[0], 0],
      [controllers[1], 80],
    ]);
    app.stickyHunkNaturalViewportTop = (controller) =>
      positions.get(controller);
    state.contentLayoutDirtyControllers.clear();
    state.orderDirty = true;
    state.stickyTop = 40;

    app.updateStickyHunkState(state);
    controllers[0].returnButton.focus();
    assert.equal(dom.window.document.activeElement, controllers[0].returnButton);

    positions.set(controllers[1], 10);
    app.updateStickyHunkState(state);

    assert.equal(state.activeController, controllers[1]);
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

test("remeasures an active sticky table row after window resize", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    const controller = Array.from(app.controllersByRow.values())[1];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    const table = controller.hunkRow.closest("table");
    Object.defineProperty(controller.hunkRow, "offsetTop", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(controller.hunkRow, "offsetHeight", {
      configurable: true,
      value: 24,
    });
    table.getBoundingClientRect = () => ({ top: 0 });
    controller.hunkRow.getBoundingClientRect = () => ({
      height: 24,
      top: controller.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      )
        ? 40
        : 200,
    });
    state.controllers = new Set([controller]);
    state.activeController = controller;
    state.contentLayoutDirtyControllers.clear();
    state.orderDirty = true;
    state.stickyTop = 40;
    controller.stickyHunkContentLayoutGeneration =
      state.contentLayoutGeneration;
    controller.stickyHunkTableOffsetTop = 100;
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    const generationBeforeResize = state.contentLayoutGeneration;
    const originGenerationBeforeResize = state.originLayoutGeneration;

    app.boundStickyHunkResize();
    assert.equal(
      state.contentLayoutGeneration,
      generationBeforeResize + 1,
    );
    assert.notEqual(
      controller.stickyHunkContentLayoutGeneration,
      state.contentLayoutGeneration,
    );
    assert.ok(
      state.originLayoutGeneration > originGenerationBeforeResize,
    );
    app.updateStickyHunkState(state);

    assert.equal(controller.stickyHunkTableOffsetTop, 200);
    assert.equal(controller.stickyHunkOriginDocumentTop, 200);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("hands off between original sticky rows without moving diff rows", async () => {
  const html = duplicateHunkFixture()
    .replace(
      '<div class="file-header">',
      '<div class="file-header" style="position: sticky; top: 0; height: 40px">',
    )
    .replace(
      "@@ -1 +1 @@",
      '<button class="js-expand" aria-label="Expand Down">↓</button>@@ -1 +1 @@',
    )
    .replace(
      "@@ -50 +50 @@",
      [
        '<div class="d-flex flex-column">',
        '<button aria-label="Expand file down from line 50">↓</button>',
        '<button aria-label="Expand file up from line 60">↑</button>',
        "</div>",
        '<code class="diff-text-cell hunk">',
        '<span class="diff-text-inner">@@ -50 +50 @@</span>',
        "</code>",
      ].join(""),
    );
  const { app, dom } = await startExtension(html);
  try {
    const controllers = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(
      controllers[0].fileElement,
    );
    const naturalTops = [500, 570];
    const heights = [24, 60];
    const tableDocumentTop = naturalTops[0];
    let virtualScroll = 459;
    Object.defineProperty(dom.window, "scrollY", {
      configurable: true,
      get: () => virtualScroll,
    });
    const table = controllers[0].hunkRow.closest("table");
    table.getBoundingClientRect = () => ({
      bottom: tableDocumentTop - virtualScroll + 2000,
      height: 2000,
      left: 10,
      right: 910,
      top: tableDocumentTop - virtualScroll,
      width: 900,
      x: 10,
      y: tableDocumentTop - virtualScroll,
    });
    controllers.forEach((controller, index) => {
      Object.defineProperty(controller.hunkRow, "offsetTop", {
        configurable: true,
        get: () => naturalTops[index] - tableDocumentTop,
      });
      Object.defineProperty(controller.hunkRow, "offsetHeight", {
        configurable: true,
        get: () => heights[index],
      });
      controller.hunkRow.getBoundingClientRect = () => {
        const top = naturalTops[index] - virtualScroll;
        return {
          bottom: top + heights[index],
          height: heights[index],
          left: 10,
          right: 910,
          top,
          width: 900,
          x: 10,
          y: top,
        };
      };
      const followingRow = controller.groupRows.find(
        (row) => row !== controller.hunkRow,
      );
      followingRow.getBoundingClientRect = () => {
        const top = naturalTops[index] + heights[index] - virtualScroll;
        return {
          bottom: top + 24,
          height: 24,
          left: 10,
          right: 910,
          top,
          width: 900,
          x: 10,
          y: top,
        };
      };
    });
    const secondText = controllers[1].hunkRow.querySelector(
      ".diff-text-inner",
    );
    secondText.getBoundingClientRect = () => ({
      bottom: naturalTops[1] - virtualScroll + 42,
      height: 24,
      left: 120,
      right: 320,
      top: naturalTops[1] - virtualScroll + 18,
      width: 200,
      x: 120,
      y: naturalTops[1] - virtualScroll + 18,
    });
    syncStickyHunkContentInset(app, controllers[1]);
    assert.equal(controllers[1].stickyHunkContentInset, 18);

    state.orderDirty = true;
    state.stickyTop = 40;
    installContentStyles(dom);
    const originalScrollHeight = dom.window.document.documentElement.scrollHeight;

    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, null);
    assert.equal(state.candidateController, controllers[0]);
    assert.equal(state.timelineController, null);

    virtualScroll = 460;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[0]);
    assert.equal(state.timelineController, controllers[0]);
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-start",
      ),
      "460px",
    );
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-end",
      ),
      "461px",
    );
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-auxiliary-start",
      ),
      "460px",
    );
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-auxiliary-end",
      ),
      "472px",
    );
    assert.equal(state.pushController, controllers[0]);
    assert.equal(state.pushIncomingController, controllers[1]);
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-push-start",
      ),
      "506px",
    );
    assert.equal(
      controllers[0].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-push-end",
      ),
      "530px",
    );
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      ),
      true,
    );
    assert.equal(
      controllers[1].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-candidate",
      ),
      true,
    );

    virtualScroll = 520;
    app.updateStickyHunkLayouts();
    assert.equal(
      controllers[1].hunkRow.getBoundingClientRect().top,
      50,
    );
    assert.equal(state.activeController, controllers[0]);
    assert.equal(state.timelineController, null);
    assert.equal(state.pushController, controllers[0]);
    assert.equal(
      controllers[1].hunkRow.style.translate,
      "",
    );

    virtualScroll = 530;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[0]);
    assert.equal(state.timelineController, controllers[1]);
    assert.equal(
      controllers[1].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-compressing",
      ),
      true,
    );
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      ),
      true,
    );
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-pushing",
      ),
      true,
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-start",
      ),
      "530px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-end",
      ),
      "548px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-start",
      ),
      "548px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-end",
      ),
      "566px",
    );
    const secondTimelinePhase = state.timelinePhase;

    virtualScroll = 548;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[1]);
    assert.equal(state.timelineController, controllers[1]);
    assert.equal(
      controllers[1].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-compressing",
      ),
      true,
    );
    assert.equal(state.timelinePhase, secondTimelinePhase);
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-start",
      ),
      "530px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-compress-end",
      ),
      "548px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-start",
      ),
      "548px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-tail-end",
      ),
      "566px",
    );
    assert.equal(state.pushController, null);
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-content-inset",
      ),
      "18px",
    );
    assert.equal(
      controllers[1].hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-bottom-inset",
      ),
      "18px",
    );
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      true,
    );
    assert.equal(
      controllers[1].hunkRow.getBoundingClientRect().top,
      22,
    );
    assert.equal(
      controllers.every(
        (controller) =>
          controller.hunkRow.style.translate === "" &&
          controller.hunkRow.style.transform === "",
      ),
      true,
    );
    assert.equal(
      dom.window.document.documentElement.scrollHeight,
      originalScrollHeight,
    );

    virtualScroll = 547;
    app.updateStickyHunkLayouts();
    assert.equal(state.activeController, controllers[0]);
    assert.equal(state.timelineController, controllers[1]);
    assert.equal(state.timelinePhase, secondTimelinePhase);
    assert.equal(state.pushController, controllers[0]);
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-past",
      ),
      false,
    );

    virtualScroll = 529;
    app.updateStickyHunkLayouts();
    assert.equal(state.timelineController, null);
    assert.equal(state.pushController, controllers[0]);
    assert.equal(
      controllers[0].hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      ),
      true,
    );
    assert.equal(
      dom.window.document.querySelector(".hunkmark-sticky-hunk-overlay"),
      null,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps pushing after the incoming sticky hunk becomes active", async () => {
  const { app, dom } = await startExtension(
    largeChangedBlockFixture(3, 48, { hunkSize: 1 }),
  );
  try {
    const [previous, current, next] = Array.from(
      app.controllersByRow.values(),
    );
    const state = app.hunkStickyStateByFile.get(current.fileElement);

    state.timelineController = current;
    current.hunkRow.classList.add(
      "hunkmark-sticky-hunk-compressing",
      "hunkmark-sticky-hunk-phase-a",
    );
    state.pushController = previous;
    state.pushIncomingController = current;
    previous.hunkRow.classList.add(
      "hunkmark-sticky-hunk-pushing",
      "hunkmark-sticky-hunk-push-phase-a",
    );

    app.syncStickyHunkPushTimeline(state, current, next, 700);
    app.syncStickyHunkTimeline(state, null);

    assert.equal(state.pushController, current);
    assert.equal(state.pushIncomingController, next);
    assert.equal(state.timelineController, null);
    assert.equal(
      current.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-compressing",
      ),
      false,
    );
    assert.equal(
      current.hunkRow.classList.contains("hunkmark-sticky-hunk-pushing"),
      true,
    );
    assert.equal(
      current.hunkRow.style.getPropertyValue(
        "--hunkmark-sticky-hunk-push-end",
      ),
      "700px",
    );
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
    state.contentLayoutDirtyControllers.clear();
    current.hunkRow.classList.add("hunkmark-sticky-hunk-active");

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

    current.input.focus();
    changeCheckbox(dom, current.input, true);
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
    const [controller] = Array.from(app.controllersByRow.values());
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    state.stickyTop = 40;
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
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
  } finally {
    app.stop();
    dom.window.close();
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
    controller.hunkRow.classList.add("hunkmark-sticky-hunk-active");
    controller.hunkRow.getBoundingClientRect = () => ({
      height: 24,
      top: controller.hunkRow.classList.contains(
        "hunkmark-sticky-hunk-active",
      )
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
    const positions = new Map([
      [controllers[0], 20],
      [controllers[1], 80],
    ]);
    app.stickyHunkNaturalViewportTop = (controller) =>
      positions.get(controller);
    state.orderDirty = true;
    state.stickyTop = 40;
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
    const [current] = Array.from(app.controllersByRow.values());
    current.hunkRow.classList.add("hunkmark-sticky-hunk-active");

    const scrollCalls = [];
    dom.window.scrollTo = (options) => scrollCalls.push(options);
    app.stickyHunkNaturalDocumentTop = () => 400;

    current.collapseButton.focus();
    await app.setCollapsed(current, true);
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
    name: "keeps auto-return pending across layout-only scroll events",
    prepare({ app, dom }) {
      const navigationGeneration = app.hunkStickyNavigationGeneration;
      return () => {
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
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

test("ignores DOM mutations unrelated to a diff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    let refreshCalls = 0;
    const originalRefresh = app.refresh.bind(app);
    app.refresh = async () => {
      refreshCalls += 1;
      return originalRefresh();
    };

    const state = Array.from(app.hunkStickyStateByFile.values())[0];
    const originGenerationBeforeMutation =
      state.originLayoutGeneration;
    const unrelated = dom.window.document.createElement("div");
    unrelated.textContent = "unrelated notification";
    dom.window.document.body.append(unrelated);
    await waitFor(() => {
      assert.ok(
        state.originLayoutGeneration > originGenerationBeforeMutation,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshCalls, 0);

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
