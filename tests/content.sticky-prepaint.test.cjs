const {
  test, assert, startExtension, duplicateHunkFixture, installContentStyles, waitFor,
} = require("./content-test-support.cjs");

async function startPrepaint({ constrainRange = true } = {}) {
  const context = await startExtension(duplicateHunkFixture());
  const { app, dom } = context;
  installContentStyles(dom);
  const controllers = [...app.controllersByRow.values()];
  const [controller] = controllers;
  const state = app.hunkStickyStateByFile.get(controller.fileElement);
  let requestedTop = 700;
  const root = dom.window.document.documentElement;
  const collapsed = () => controller.groupRows.some(row => row.classList.contains("hunkmark-collapsed"));
  const naturalRange = () => constrainRange ? (collapsed() ? 500 : 1000) : 2000;
  const availableRange = () => Math.max(naturalRange(), Number.parseFloat(app.hunkStickyScrollBoundary?.style.top) || 0);
  Object.defineProperty(root, "offsetHeight", { configurable: true, get: () => dom.window.innerHeight + naturalRange() });
  Object.defineProperty(dom.window, "scrollY", { configurable: true, get: () => Math.min(requestedTop, availableRange()) });
  state.fileElement.getBoundingClientRect = () => ({ top: 100 - dom.window.scrollY });
  controllers.forEach((item, index) => {
    item.hunkRow.getBoundingClientRect = () => ({
      height: 64, top: 600 + index * 300 - dom.window.scrollY,
    });
  });
  state.stickyTop = 40;
  app.measureStickyHunkContentInset = () => ({ inset: 14, bottomInset: 26, compactHeight: 24 });
  app.markStickyHunkContentDirty(state);
  app.invalidateStickyHunkOrigins(state.fileElement);
  app.updateStickyHunkState(state);
  const scrolls = [];
  dom.window.scrollTo = options => { scrolls.push({ ...options }); requestedTop = options.top; };
  return {
    ...context, controller, controllers, state, scrolls, collapsed,
    moveTo(top) { requestedTop = top; },
  };
}

for (const action of ["hunk", "collapse", "line", "drag"]) {
  test(`aligns ${action} collapse before persistence yields and never scrolls a second time`, async () => {
    const { app, dom, controller, scrolls, collapsed } = await startPrepaint();
    let finishSaving;
    try {
      const holdSave = () => {
        assert.equal(collapsed(), true);
        assert.equal(dom.window.scrollY, 600, "the first possible paint must already be aligned");
        assert.deepEqual(scrolls, [{ top: 600, behavior: "instant" }]);
        return new Promise(resolve => { finishSaving = resolve; });
      };
      app.setReviewStorage = holdSave;
      app.mutateReviewStorageAndReleaseOfficialViewed = holdSave;
      let saving;
      if (action === "hunk") saving = app.setHunkViewed(controller, true, { returnToOriginFromSticky: true });
      if (action === "collapse") saving = app.setCollapsed(controller, true);
      if (action === "line") saving = app.setLineViewed(controller.lines[0], true);
      if (action === "drag") {
        app.startLineDrag(controller.lines[0], true, 17);
        saving = app.finishLineDrag(true);
      }
      assert.equal(typeof finishSaving, "function");
      await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
      assert.equal(dom.window.scrollY, 600, "waiting for storage must not expose the old scroll position");
      dom.window.dispatchEvent(new dom.window.Event("scrollend"));
      finishSaving();
      await saving;
      await waitFor(() => assert.equal(app.hunkStickyScrollBoundaryTarget, 600));
      assert.equal(scrolls.length, 1);
      assert.equal(dom.window.scrollY, 600);
      assert.equal(app.hunkStickyScrollBoundary.style.top, "600px");
      assert.equal(controller.marked, action !== "collapse");
    } finally {
      finishSaving?.(); app.stop(); dom.window.close();
    }
  });
}

test("keeps the prepaint stop reachable when navigation cancels a still-pending save", async () => {
  const { app, dom, controller, scrolls } = await startPrepaint();
  let finishSaving;
  try {
    app.setReviewStorage = () => new Promise(resolve => { finishSaving = resolve; });
    const saving = app.setCollapsed(controller, true);
    app.cancelStickyHunkReturn();
    assert.equal(dom.window.scrollY, 600, "cancellation must not clamp the visible header to the page end");
    assert.equal(app.hunkStickyScrollBoundaryTarget, 600);
    finishSaving(); await saving;
    await new Promise(resolve => dom.window.setTimeout(resolve, 50));
    assert.equal(scrolls.length, 1);
    assert.equal(dom.window.scrollY, 600);
  } finally {
    finishSaving?.(); app.stop(); dom.window.close();
  }
});

for (const action of ["hunk", "collapse", "line", "drag"]) {
  test(`restores stored state after a ${action} prepaint return fails to persist`, async () => {
    const { app, chrome, dom, controller, scrolls } = await startPrepaint();
    try {
      const warnings = [];
      dom.window.console.warn = (...args) => warnings.push(args);
      chrome.failNextSet();
      if (action === "hunk") await app.setHunkViewed(controller, true, { returnToOriginFromSticky: true });
      if (action === "collapse") await app.setCollapsed(controller, true);
      if (action === "line") await app.setLineViewed(controller.lines[0], true);
      if (action === "drag") {
        app.startLineDrag(controller.lines[0], true, 17);
        await app.finishLineDrag(true);
      }
      assert.equal(warnings.length, 1);
      assert.equal(controller.marked, false);
      assert.equal(controller.collapsed, false);
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.collapseButton.disabled, false);
      assert.equal(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-compact-return"), false);
      assert.equal(app.hunkStickyScrollBoundary, null);
      assert.equal(app.hunkStickyScrollFrameId, null);
      assert.equal(dom.window.scrollY, 600);
      assert.equal(scrolls.length, 1, "rollback must not schedule another return");
      assert.equal(chrome.snapshot()[controller.collapsedKey], undefined);
      controller.lines.forEach(line => assert.equal(chrome.snapshot()[line.key], undefined));
    } finally { app.stop(); dom.window.close(); }
  });
}

for (const newestFinishesFirst of [false, true]) {
  test(`keeps the latest prepaint return when saves finish ${newestFinishesFirst ? "out of order" : "in order"}`, async () => {
    const { app, dom, controllers, state, scrolls, moveTo } = await startPrepaint({ constrainRange: false });
    const completions = [];
    try {
      app.setReviewStorage = () => new Promise(resolve => completions.push(resolve));
      const firstSave = app.setCollapsed(controllers[0], true);
      moveTo(1000);
      app.updateStickyHunkState(state);
      assert.equal(state.activeController, controllers[1]);
      const secondSave = app.setCollapsed(controllers[1], true);
      const latestReservation = app.hunkStickyScrollReservation;
      assert.equal(dom.window.scrollY, 900);
      if (newestFinishesFirst) {
        completions[1](); await secondSave;
        await waitFor(() => assert.equal(app.hunkStickyScrollBoundary, null));
        completions[0](); await firstSave;
      } else {
        completions[0](); await firstSave;
        assert.equal(app.hunkStickyScrollReservation, latestReservation);
        assert.equal(app.hunkStickyScrollBoundaryKey, controllers[1].key);
        completions[1](); await secondSave;
        await waitFor(() => assert.equal(app.hunkStickyScrollBoundary, null));
      }
      assert.equal(scrolls.length, 2);
      assert.equal(dom.window.scrollY, 900, "an older save cannot move the newer return");
    } finally {
      completions.forEach(resolve => resolve());
      app.stop(); dom.window.close();
    }
  });
}

test("does not steal keyboard focus after the user leaves a prepaint return during a save", async () => {
  const { app, dom, controller, scrolls } = await startPrepaint();
  let finishSaving;
  try {
    controller.input.getBoundingClientRect = () => ({ top: 40 });
    controller.input.focus();
    app.mutateReviewStorageAndReleaseOfficialViewed = () => new Promise(resolve => { finishSaving = resolve; });
    const saving = app.setHunkViewed(controller, true, { returnToOriginFromSticky: true });
    const other = dom.window.document.createElement("button");
    dom.window.document.body.append(other);
    controller.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    other.focus();
    finishSaving(); await saving;
    await new Promise(resolve => dom.window.setTimeout(resolve, 50));
    assert.equal(dom.window.document.activeElement, other);
    assert.equal(dom.window.scrollY, 600);
    assert.equal(scrolls.length, 1);
  } finally {
    finishSaving?.(); app.stop(); dom.window.close();
  }
});
