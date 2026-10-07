const {
  test, assert, startExtension, waitFor, largeChangedBlockFixture,
} = require("./content-test-support.cjs");

class IntersectionObserver {
  constructor(callback) { this.callback = callback; this.observed = new Set(); }
  observe(element) { this.observed.add(element); }
  unobserve(element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
}

async function startWindow() {
  const context = await startExtension(largeChangedBlockFixture(128, 48, { hunkSize: 1 }), {}, {
    intersectionObserverClass: IntersectionObserver,
  });
  const { app, dom } = context;
  app.observer.disconnect();
  const viewport = { top: 1000, left: 0, height: 800, documentHeight: 20000 };
  Object.defineProperty(dom.window, "scrollY", { configurable: true, get: () => viewport.top });
  Object.defineProperty(dom.window, "scrollX", { configurable: true, get: () => viewport.left });
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, get: () => viewport.height });
  Object.defineProperty(dom.window.document.documentElement, "offsetHeight", {
    configurable: true, get: () => viewport.documentHeight,
  });
  const controllers = Array.from(app.controllersByRow.values());
  const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
  state.fileElement.getBoundingClientRect = () => ({ top: 100 - viewport.top });
  controllers.forEach((controller, index) => {
    controller.hunkRow.getBoundingClientRect = () => ({ top: 200 + index * 100 - viewport.top, height: 48 });
  });
  app.measureStickyHunkContentInset = () => ({ inset: 12, bottomInset: 12, compactHeight: 24 });
  app.hunkStickyFileVisibilityObserver.callback([{ target: state.fileElement, isIntersecting: true }]);
  state.stickyTop = 40;
  app.updateStickyHunkLayouts();
  await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
  return { ...context, viewport, controllers, state };
}

test("refills a bounded sticky window on observer crossings instead of each scroll", async () => {
  const { app, dom, viewport, controllers, state } = await startWindow();
  try {
    const marker = app.hunkStickyWindowMarker;
    const observer = app.hunkStickyWindowObserver;
    assert.equal(marker.style.top, "1400px");
    assert.ok(observer.observed.has(marker));
    let preparations = 0;
    const prepare = app.prepareStickyHunkState;
    app.prepareStickyHunkState = function (...args) { preparations++; return prepare.apply(this, args); };
    for (const top of [1100, 1200, 1100, 1000]) {
      viewport.top = top;
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
    }
    observer.callback([{ target: marker, isIntersecting: true }]);
    assert.equal(app.hunkStickyLayoutFrameId, null);
    assert.equal(preparations, 0);

    for (const top of [1500, 900, 9000, 500]) {
      viewport.top = top;
      observer.callback([{ target: marker, isIntersecting: false }]);
      await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
      assert.equal(marker.style.top, `${top + 400}px`);
      assert.ok(state.preparedControllers.size < 30);
      assert.ok(state.preparedControllers.has(controllers[Math.floor((top + 40 - 212) / 100)]));
    }
    assert.equal(preparations, 4);
    // Host changes still refresh the prepared geometry without scrolling.
    app.invalidateStickyHunkOrigins(state.fileElement);
    await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
    assert.equal(preparations, 5);
    // Horizontal page scrolling must not strand the marker offscreen.
    viewport.left = 2000;
    observer.callback([{ target: marker, isIntersecting: false }]);
    await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
    assert.equal(marker.style.left, `${2000 + dom.window.innerWidth / 2}px`);
    assert.equal(preparations, 6);
  } finally { app.stop(); dom.window.close(); }
});

test("keeps keyboard return focus synchronized within an otherwise idle sticky window", async () => {
  const { app, dom, viewport, controllers, state } = await startWindow();
  try {
    const previous = state.activeController;
    previous.returnButton.focus();
    viewport.top += 100;
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
    assert.equal(state.activeController, controllers[previous.stickyHunkOrderIndex + 1]);
    assert.equal(dom.window.document.activeElement, state.activeController.returnButton);
  } finally { app.stop(); dom.window.close(); }
});

test("bounds the marker to natural page height and disposes inactive observers", async () => {
  const { app, dom, viewport, state } = await startWindow();
  try {
    const marker = app.hunkStickyWindowMarker;
    const observer = app.hunkStickyWindowObserver;
    viewport.documentHeight = 1200;
    app.updateStickyHunkLayouts();
    assert.equal(marker.style.top, "1199px");
    // A collapse can leave the viewport in a temporary scroll reservation.
    // An always-offscreen marker cannot report the next boundary crossing.
    viewport.top = 1500;
    app.updateStickyHunkLayouts();
    assert.equal(app.hunkStickyWindowObserver, null);
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
    viewport.top = 1000;
    app.setStickyHunkStateVisibility(state, false);
    assert.equal(marker.isConnected, false);
    assert.equal(observer.observed.size, 0);
    assert.equal(app.hunkStickyWindowObserver, null);
    app.setStickyHunkStateVisibility(state, true);
    await waitFor(() => assert.equal(app.hunkStickyLayoutFrameId, null));
    app.updateStickyHunkLayouts();
    const replacement = app.hunkStickyWindowMarker;
    assert.notEqual(replacement, marker);
    observer.callback([{ target: marker, isIntersecting: false }]);
    assert.equal(app.hunkStickyLayoutFrameId, null);
    app.stop();
    assert.equal(replacement.isConnected, false);
    assert.equal(app.hunkStickyWindowObserver, null);
  } finally { app.stop(); dom.window.close(); }
});
