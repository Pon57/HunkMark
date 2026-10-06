const {
  test, assert, installContentStyles, startExtension, modernGridFixture, duplicateHunkFixture,
} = require("./content-test-support.cjs");

async function startActionGeometry({
  table = false, cellOffset = 20, border = 0, padding = 0, clientHeight = null,
} = {}) {
  const context = await startExtension(table ? duplicateHunkFixture() : modernGridFixture());
  const { app, dom } = context;
  installContentStyles(dom);
  const [controller] = app.controllersByRow.values();
  const state = app.hunkStickyStateByFile.get(controller.fileElement);
  const layout = {
    scrollY: 600, cellOffset, border, padding,
    cellHeight: 64 - 2 * cellOffset,
    clientHeight: clientHeight ?? 64 - 2 * cellOffset - 2 * border,
    cellReads: 0, borderReads: 0, heightReads: 0,
  };
  const rect = (top, height) => ({ top, height, bottom: top + height, left: 0, width: 900 });
  const rowTop = () => 600 - layout.scrollY;
  Object.defineProperty(dom.window, "scrollY", { configurable: true, get: () => layout.scrollY });
  controller.hunkRow.style.cssText = table ? "" : "display:flex;align-items:center;height:64px";
  Object.defineProperty(controller.hunkRow, "offsetHeight", { configurable: true, value: 64 });
  controller.hunkRow.getBoundingClientRect = () => rect(rowTop(), 64);
  controller.hunkCell.style.height = `${64 - 2 * cellOffset}px`;
  controller.hunkCell.style.borderTopWidth = `${border}px`;
  controller.hunkCell.style.paddingTop = `${padding}px`;
  controller.hunkCell.getBoundingClientRect = () => {
    layout.cellReads += 1;
    return rect(rowTop() + layout.cellOffset, layout.cellHeight);
  };
  Object.defineProperty(controller.hunkCell, "clientTop", {
    configurable: true,
    get() { layout.borderReads += 1; return layout.border; },
  });
  Object.defineProperty(controller.hunkCell, "clientHeight", {
    configurable: true,
    get() { layout.heightReads += 1; return layout.clientHeight; },
  });
  dom.window.document.createRange = () => ({
    selectNodeContents() {}, detach() {},
    getBoundingClientRect: () => rect(rowTop() + layout.cellOffset + layout.border + layout.padding + 2, 20),
  });
  state.fileElement.getBoundingClientRect = () => rect(100 - layout.scrollY, 1000);
  state.stickyTop = 40;
  app.markStickyHunkContentDirty(state);
  app.invalidateStickyHunkOrigins(state.fileElement);
  app.updateStickyHunkState(state);
  return { ...context, controller, state, layout };
}

function stop({ app, dom }) { app.stop(); dom.window.close(); }

for (const scenario of [
  { name: "vertically inset grid cell", cellOffset: 20 },
  { name: "grid cell with border and padding", cellOffset: 10, border: 2, padding: 6 },
  { name: "table cell sharing the row top", table: true, cellOffset: 0, border: 2, padding: 10 },
]) {
  test(`centers sticky actions on the header text inside a ${scenario.name}`, async () => {
    const context = await startActionGeometry(scenario);
    const { dom, controller, layout } = context;
    try {
      assert.equal(controller.actions.parentElement, controller.hunkCell);
      assert.equal(dom.window.getComputedStyle(controller.hunkCell).position, "relative");
      const actionsTop = Number.parseFloat(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-actions-top"));
      const cellPaddingEdge = layout.cellOffset + layout.border;
      const actionsCenterInRow = cellPaddingEdge + actionsTop;
      const textCenterInRow = cellPaddingEdge + layout.padding + 12;
      assert.equal(actionsCenterInRow, textCenterInRow, "do not add the cell's row offset or border twice");
      assert.equal(actionsCenterInRow, controller.stickyHunkContentInset + controller.stickyHunkCompactHeight / 2);
      assert.equal(actionsTop, layout.padding + 12, "padding remains part of the absolute containing block");
      assert.equal(dom.window.getComputedStyle(controller.actions).top, "var(--hunkmark-sticky-hunk-actions-top, 50%)");
    } finally { stop(context); }
  });
}

test("caches action placement during scrolling and remeasures it when header content changes", async () => {
  const context = await startActionGeometry();
  const { app, controller, state, layout } = context;
  try {
    // Apply the host-style mutations delivered after the async fixture setup.
    app.updateStickyHunkState(state);
    const reads = [layout.cellReads, layout.borderReads, layout.heightReads];
    for (const scrollY of [610, 620, 610]) {
      layout.scrollY = scrollY;
      app.updateStickyHunkState(state);
    }
    assert.deepEqual([layout.cellReads, layout.borderReads, layout.heightReads], reads, "ordinary scroll must not read cell geometry");
    controller.hunkRow.style.removeProperty("--hunkmark-sticky-hunk-actions-top");
    controller.hunkRow.style.removeProperty("--hunkmark-sticky-hunk-focus-height");
    app.updateStickyHunkState(state);
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-actions-top"), "12px");
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), "24px");
    assert.deepEqual([layout.cellReads, layout.borderReads, layout.heightReads], reads, "restore host-rewritten styles from the cache");
    layout.padding = 4;
    state.contentLayoutDirtyControllers.add(controller);
    app.updateStickyHunkState(state);
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-actions-top"), "16px");
    assert.deepEqual([layout.cellReads, layout.borderReads, layout.heightReads], reads.map((count) => count + 1));
  } finally { stop(context); }
});

test("removes the cell-relative action style when a hunk controller is detached", async () => {
  const context = await startActionGeometry();
  const { app, controller } = context;
  try {
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-actions-top"), "12px");
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), "24px");
    app.detachStickyHunkRow(controller);
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-actions-top"), "");
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), "");
  } finally { stop(context); }
});


test("measures the focus frame's padding box and invalidates its cached height on resize", async () => {
  const context = await startActionGeometry({ cellOffset: 10, border: 2, padding: 6 });
  const { app, dom, controller, state, layout } = context;
  try {
    app.updateStickyHunkState(state);
    assert.equal(controller.stickyHunkFocusHeight, 40, "include padding and exclude both borders from the 44px cell");
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), "40px");
    const reads = [layout.cellReads, layout.heightReads];
    const measurements = new Map();
    assert.equal(app.stickyHunkContentMetrics(state, controller, measurements).focusHeight, 40);
    assert.equal(measurements.size, 0);
    assert.deepEqual([layout.cellReads, layout.heightReads], reads);

    layout.cellOffset = 6;
    layout.cellHeight = 52;
    layout.clientHeight = 48;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    app.updateStickyHunkState(state);
    assert.equal(controller.stickyHunkFocusHeight, 48);
    assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), "48px");
    assert.deepEqual([layout.cellReads, layout.heightReads], reads.map((count) => count + 1));
  } finally { stop(context); }
});

test("bounds focus-height fallbacks when a cell has no positive client height", async () => {
  const context = await startActionGeometry({ cellOffset: 10, clientHeight: 0 });
  const { app, controller, state, layout } = context;
  try {
    for (const [cellHeight, expected] of [[44, 44], [96, 64], [0, 64]]) {
      layout.cellHeight = cellHeight;
      app.markStickyHunkContentDirty(state);
      app.updateStickyHunkState(state);
      assert.equal(controller.stickyHunkFocusHeight, expected);
      assert.equal(controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-focus-height"), `${expected}px`);
    }
  } finally { stop(context); }
});
