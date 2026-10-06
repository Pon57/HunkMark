const {
  test, assert, installContentStyles, startExtension, waitFor, duplicateHunkFixture,
} = require("./content-test-support.cjs");

async function startClip(controls = "") {
  const records = [];
  const timelines = [];
  const context = await startExtension(duplicateHunkFixture().replace(
    "@@ -1 +1 @@</td>", `@@ -1 +1 @@${controls}</td>`,
  ), {}, {
    setupWindow(window) {
      window.ScrollTimeline = class {
        constructor(options) { Object.assign(this, options); timelines.push(this); }
      };
      window.Element.prototype.animate = function (frames, options) {
        const record = {
          target: this, frames: JSON.parse(JSON.stringify(frames)), options,
          start: options.rangeStart, end: options.rangeEnd,
          frameWrites: 0, rangeWrites: 0, cancellations: 0,
        };
        records.push(record);
        return {
          effect: { setKeyframes(value) {
            record.frames = JSON.parse(JSON.stringify(value)); record.frameWrites += 1;
          } },
          get rangeStart() { return record.start; },
          set rangeStart(value) { record.start = value; record.rangeWrites += 1; },
          get rangeEnd() { return record.end; },
          set rangeEnd(value) { record.end = value; record.rangeWrites += 1; },
          cancel() { record.cancellations += 1; },
        };
      };
    },
  });
  const { app, dom } = context;
  installContentStyles(dom);
  const controllers = Array.from(app.controllersByRow.values());
  const state = app.hunkStickyStateByFile.get(controllers[0].fileElement);
  const layout = { scrollY: 600, translation: 0, inset: 14, bottomInset: 26 };
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
  app.measureStickyHunkContentInset = () => ({
    inset: layout.inset, bottomInset: layout.bottomInset, compactHeight: 24,
  });
  app.markStickyHunkContentDirty(state);
  app.invalidateStickyHunkOrigins(state.fileElement);
  app.updateStickyHunkState(state);
  return { ...context, controllers, state, layout, records, timelines };
}

function stop({ app, dom }) { app.stop(); dom.window.close(); }

test("clips only original rows and cells on a shared scroll timeline", async () => {
  const context = await startClip();
  const { app, dom, controllers, records, timelines } = context;
  try {
    assert.equal(timelines.length, 1);
    assert.equal(timelines[0].source, dom.window.document.documentElement);
    assert.equal(timelines[0].axis, "block");
    for (const [index, controller] of controllers.entries()) {
      const targets = [controller.hunkRow, ...controller.hunkRow.children];
      assert.deepEqual(Array.from(controller.stickyHunkClipState.animations.keys()), targets);
      for (const target of targets) {
        const record = records.find((entry) => entry.target === target);
        assert.equal(record.options.timeline, timelines[0]);
        assert.equal(record.start, `${560 + index * 300}px`);
        assert.equal(record.end, `${600 + index * 300}px`);
        assert.deepEqual(record.frames, [
          { clipPath: "inset(0px 0px 0px 0px)", offset: 0 },
          { clipPath: "inset(14px 0px 0px 0px)", offset: 0.35 },
          { clipPath: "inset(14px 0px 26px 0px)", offset: 1 },
        ]);
      }
    }
    assert.equal(dom.window.document.querySelector(".hunkmark-sticky-hunk-natural-layer"), null);
    assert.equal(app.discoverCachedHunks().length, controllers.length);
  } finally { stop(context); }
});

test("reuses clip effects and updates only changed geometry or ranges", async () => {
  const context = await startClip();
  const { app, controllers, state, layout, records } = context;
  try {
    const count = records.length;
    const record = records.find((entry) => entry.target === controllers[0].hunkRow);
    for (const top of [610, 620, 610]) {
      layout.scrollY = top;
      app.updateStickyHunkState(state);
    }
    assert.equal(records.length, count);
    assert.equal(record.frameWrites, 0);
    assert.equal(record.rangeWrites, 0);
    layout.translation = 200;
    app.markStickyHunkFileOriginDirty(state);
    app.updateStickyHunkState(state);
    assert.equal(records.length, count);
    assert.equal(record.start, "760px");
    assert.equal(record.end, "800px");
    assert.equal(record.frameWrites, 0);
    layout.inset = 10;
    layout.bottomInset = 30;
    app.markStickyHunkContentDirty(state);
    app.updateStickyHunkState(state);
    assert.equal(records.length, count);
    assert.equal(record.frames[1].offset, 0.25);
    assert.equal(record.frames[2].clipPath, "inset(10px 0px 30px 0px)");
  } finally { stop(context); }
});

test("replaces detached cell effects and cancels effects when preparation ends", async () => {
  const context = await startClip();
  const { app, controllers, state, layout, records } = context;
  try {
    const [controller] = controllers;
    const oldCell = controller.hunkRow.firstElementChild;
    const oldEffect = records.find((entry) => entry.target === oldCell);
    const replacement = oldCell.cloneNode(true);
    oldCell.replaceWith(replacement);
    app.syncStickyHunkClipAnimation(controller, 600, 40);
    assert.equal(oldEffect.cancellations, 1);
    assert.ok(controller.stickyHunkClipState.animations.has(replacement));
    layout.scrollY = 5000;
    app.updateStickyHunkState(state);
    assert.equal(controller.stickyHunkClipState, null);
    assert.equal(controller.stickyHunkClipContentObserver, null);
    app.setStickyHunkStateVisibility(state, false);
    assert.ok(records.every((entry) => entry.cancellations === 1));
    app.stop();
    assert.equal(app.hunkStickyClipTimeline, null);
    assert.ok(records.every((entry) => entry.cancellations === 1));
  } finally { stop(context); }
});

test("updates clipping for host header changes without rebuilding native controls", async () => {
  const context = await startClip('<input class="native-field" value="original">');
  const { app, dom, controllers, state, layout, records } = context;
  try {
    const [controller] = controllers;
    const field = controller.hunkRow.querySelector(".native-field");
    const record = records.find((entry) => entry.target === controller.hunkRow);
    layout.inset = 20;
    layout.bottomInset = 20;
    controller.hunkRow.classList.add("host-header-layout-change");
    await waitFor(() => assert.equal(record.frames[1].offset, 0.5));
    assert.equal(controller.hunkRow.querySelector(".native-field"), field);
    assert.equal(dom.window.document.querySelectorAll(".native-field").length, 1);
    const writes = record.frameWrites;
    controller.hunkRow.classList.add("hunkmark-test-state");
    controller.hunkRow.style.setProperty("--hunkmark-test-state", "1px");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
    app.updateStickyHunkState(state);
    assert.equal(record.frameWrites, writes);
  } finally { stop(context); }
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
