const {
  test, assert, installContentStyles, startExtension, waitFor, duplicateHunkFixture,
} = require("./content-test-support.cjs");

async function startClip(controls = "") {
  const context = await startExtension(duplicateHunkFixture().replace(
    "@@ -1 +1 @@</td>", `@@ -1 +1 @@${controls}</td>`,
  ));
  const { app, dom } = context;
  installContentStyles(dom);
  const controllers = Array.from(app.controllersByRow.values());
  const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
  const layout = { scrollY: 600, translation: 0, inset: 14, bottomInset: 26, measurements: 0 };
  Object.defineProperty(dom.window, "scrollY", { configurable: true, get: () => layout.scrollY });
  controllers.forEach((controller, index) => {
    controller.hunkRow.getBoundingClientRect = () => ({
      top: 600 + index * 300 + layout.translation - layout.scrollY,
      left: 20, width: 800, height: 64,
    });
  });
  state.fileElement.getBoundingClientRect = () => ({
    top: 100 + layout.translation - layout.scrollY, left: 10, width: 900,
  });
  state.stickyTop = 40;
  app.measureStickyHunkContentInset = () => {
    layout.measurements++;
    return { inset: layout.inset, bottomInset: layout.bottomInset, compactHeight: 24 };
  };
  app.markStickyHunkContentDirty(state);
  app.invalidateStickyHunkOrigins(state.fileElement);
  app.updateStickyHunkState(state);
  return { ...context, controllers, state, layout };
}

function stop({ app, dom }) { app.stop(); dom.window.close(); }

test("keeps a static clip and compensates original cell content without cloning it", async () => {
  const context = await startClip();
  const { app, dom, controllers } = context;
  try {
    for (const controller of controllers) {
      assert.equal(dom.window.getComputedStyle(controller.hunkRow).clipPath, "inset(0)");
      for (const cell of controller.hunkRow.children) {
        assert.match(dom.window.getComputedStyle(cell).animation, /restore-content/);
      }
    }
    assert.equal(dom.window.document.querySelector(".hunkmark-sticky-hunk-natural-layer"), null);
    assert.equal(app.discoverCachedHunks().length, controllers.length);
  } finally { stop(context); }
});

test("reuses content measurements across scrolling and file translation", async () => {
  const context = await startClip();
  const { app, controllers, state, layout } = context;
  try {
    const measured = layout.measurements;
    for (const top of [610, 620, 610]) {
      layout.scrollY = top;
      app.updateStickyHunkState(state);
    }
    layout.translation = 200;
    app.markStickyHunkFileOriginDirty(state);
    app.updateStickyHunkState(state);
    assert.equal(layout.measurements, measured);
    assert.equal(app.cachedStickyHunkNaturalDocumentTop(controllers[0]), 800);
    assert.equal(state.fileElement.style.getPropertyValue("--hunkmark-sticky-hunk-file-start"), "260px");
    layout.inset = 10;
    layout.bottomInset = 30;
    app.markStickyHunkContentDirty(state);
    app.updateStickyHunkState(state);
    assert.equal(controllers[0].hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-bottom-inset"), "30px");
  } finally { stop(context); }
});

test("inherits cell compensation after host replacement and releases content observers", async () => {
  const context = await startClip();
  const { app, dom, controllers, state, layout } = context;
  try {
    app.observer.disconnect();
    const [controller] = controllers;
    const oldCell = controller.hunkRow.firstElementChild;
    const replacement = oldCell.cloneNode(true);
    oldCell.replaceWith(replacement);
    assert.match(dom.window.getComputedStyle(replacement).animation, /restore-content/);
    const observer = controller.stickyHunkContentObserver;
    assert.ok(observer);
    layout.scrollY = 5000;
    app.updateStickyHunkState(state);
    assert.equal(controller.stickyHunkContentObserver, null);
    assert.equal(observer.takeRecords().length, 0);
    app.setStickyHunkStateVisibility(state, false);
    assert.ok(controllers.every((c) => c.stickyHunkContentObserver === null));
    app.stop();
    assert.equal(dom.window.document.documentElement.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "");
  } finally { stop(context); }
});

test("updates clipping for host header changes without rebuilding native controls", async () => {
  const context = await startClip('<input class="native-field" value="original">');
  const { app, dom, controllers, state, layout } = context;
  try {
    const [controller] = controllers;
    const field = controller.hunkRow.querySelector(".native-field");
    layout.inset = 20;
    layout.bottomInset = 20;
    controller.hunkRow.classList.add("host-header-layout-change");
    await waitFor(() => assert.equal(controller.stickyHunkContentInset, 20));
    assert.equal(controller.hunkRow.querySelector(".native-field"), field);
    assert.equal(dom.window.document.querySelectorAll(".native-field").length, 1);
    const measured = layout.measurements;
    controller.hunkRow.classList.add("hunkmark-test-state");
    controller.hunkRow.style.setProperty("--hunkmark-test-state", "1px");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    app.updateStickyHunkState(state);
    assert.equal(layout.measurements, measured);
  } finally { stop(context); }
});

test("restores host-replaced preparation without waiting for another scroll", async () => {
  const context = await startClip();
  const { app, controllers } = context;
  try {
    app.observer.disconnect();
    const row = controllers[0].hunkRow;
    for (const rewrite of ["class", "style", "both"]) {
      if (rewrite !== "style") row.className = "host-hunk-row";
      if (rewrite !== "class") row.style.cssText = "";
      await waitFor(() => {
        assert.ok(row.classList.contains("hunkmark-sticky-hunk-prepared"));
        assert.equal(row.style.getPropertyValue("--hunkmark-sticky-hunk-auxiliary-start"), "500px");
        assert.equal(row.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "1px");
      });
    }
    row.style.removeProperty("--hunkmark-sticky-scroll-extent");
    await waitFor(() => assert.equal(row.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "1px"));
  } finally { stop(context); }
});

test("updates scroll extent only on prepared headers before a body resize paints", async () => {
  class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe() {} unobserve() {} disconnect() {}
  }
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, { resizeObserverClass: ResizeObserver });
  try {
    const root = dom.window.document.documentElement;
    const controller = Array.from(app.controllersByRow.values())[0];
    const state = app.hunkStickyStateByFile.get(controller.fileElement);
    app.updateStickyHunkLayouts();
    const extent = () => controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-scroll-extent");
    let height = 2400;
    Object.defineProperty(root, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 800 });
    app.hunkStickyFileLayoutObserver.callback([{ target: dom.window.document.body }]);
    assert.equal(extent(), "1600px");
    assert.equal(root.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "");
    assert.equal(state.fileElement.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "");
    height = 3000;
    app.reserveStickyHunkScrollRange(controller);
    assert.equal(extent(), "2200px");
    height = 2400;
    app.clearStickyHunkScrollRange();
    assert.equal(extent(), "1600px");
    height = 800;
    app.hunkStickyFileLayoutObserver.callback([{ target: dom.window.document.body }]);
    assert.equal(extent(), "1px");
    app.setStickyHunkStateVisibility(state, false);
    assert.equal(extent(), "");
    app.stop();
    assert.equal(root.style.getPropertyValue("--hunkmark-sticky-scroll-extent"), "");
    assert.equal(app.hunkStickyScrollExtent, null);
  } finally { app.stop(); dom.window.close(); }
});

for (const [name, markup] of [
  ["picker", '<select class="native-control"><option>One</option></select>'],
  ["date", '<input class="native-control" type="date">'],
  ["text", '<input class="native-control" value="original">'],
  ["editable text", '<span class="native-control" contenteditable="">Edit</span>'],
]) {
  test(`keeps original ${name} controls directly interactive`, async () => {
    const context = await startClip(markup);
    const { dom, controllers } = context;
    try {
      const [controller] = controllers;
      const control = controller.hunkRow.querySelector(".native-control");
      let clicks = 0;
      control.addEventListener("click", () => { clicks += 1; });
      const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
      control.dispatchEvent(event);
      assert.equal(clicks, 1);
      assert.equal(event.defaultPrevented, false);
      assert.equal(dom.window.document.querySelectorAll(".native-control").length, 1);
    } finally { stop(context); }
  });
}
