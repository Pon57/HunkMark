const {
  test,
  assert,
  installContentStyles,
  startExtension,
  waitFor,
  duplicateHunkFixture,
} = require("./content-test-support.cjs");

async function startNaturalHeader(controls) {
  const fixture = duplicateHunkFixture().replace(
    "@@ -1 +1 @@</td>",
    `<span class="native-header-text">@@ -1 +1 @@</span>${controls}</td>`,
  );
  const context = await startExtension(fixture);
  const { app, dom } = context;
  installContentStyles(dom);
  const controllers = Array.from(app.controllersByRow.values());
  const [controller] = controllers;
  const state = app.hunkStickyStateByFile.get(controller.fileElement);
  Object.defineProperty(dom.window, "scrollY", {
    configurable: true,
    get: () => 600,
  });
  controllers.forEach((current, index) => {
    current.hunkRow.getBoundingClientRect = () => ({
      top: index * 300,
      left: 20,
      width: 800,
      height: 64,
    });
  });
  state.fileElement.getBoundingClientRect = () => ({
    top: -500,
    left: 10,
    width: 900,
  });
  state.header.style.position = "sticky";
  state.header.style.top = "0px";
  state.header.getBoundingClientRect = () => ({ height: 40 });
  state.stickyTop = 40;
  app.measureStickyHunkContentInset = () => ({
    inset: 14,
    bottomInset: 26,
    compactHeight: 24,
  });
  app.markStickyHunkContentDirty(state);
  app.invalidateStickyHunkOrigins(state.fileElement);
  app.updateStickyHunkState(state);
  assert.ok(controller.stickyHunkNaturalRow?.isConnected);
  assert.ok(controller.hunkRow.classList.contains("hunkmark-sticky-hunk-active"));
  const scrollCalls = [];
  dom.window.scrollTo = (options) => scrollCalls.push(options);
  return { ...context, controller, scrollCalls };
}

for (const scenario of [
  {
    name: "link",
    html: '<a class="native-control" href="#native-target"><span>Inspect</span></a>',
  },
  {
    name: "button",
    html: '<button class="native-control" type="button"><span>Actions</span></button>',
  },
  {
    name: "checkbox",
    html: '<input class="native-control" type="checkbox">',
  },
  {
    name: "label",
    html: '<label class="native-control" for="native-checkbox">Toggle</label><input id="native-checkbox" type="checkbox">',
  },
]) {
  test(`forwards a natural header's ordinary ${scenario.name} to its original control`, async () => {
    const { app, dom, controller, scrollCalls } = await startNaturalHeader(scenario.html);
    try {
      const source = controller.hunkRow.querySelector(".native-control");
      const proxy = controller.stickyHunkNaturalRow.querySelector(".native-control");
      const events = [];
      source.addEventListener("click", (event) => {
        if (scenario.name === "link") event.preventDefault();
        events.push({
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          clientX: event.clientX,
          clientY: event.clientY,
          detail: event.detail,
        });
      });
      const modifiers = {
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
        clientX: 25,
        clientY: 48,
        detail: 1,
      };
      (proxy.querySelector("span") ?? proxy).dispatchEvent(
        new dom.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...modifiers,
        }),
      );

      assert.deepEqual(events, [modifiers]);
      assert.equal(scrollCalls.length, 0);
      if (scenario.name === "checkbox" || scenario.name === "label") {
        assert.equal(controller.hunkRow.querySelector("input:not([data-hunkmark-ui])").checked, true);
      }
      if (scenario.name !== "label") {
        assert.equal(dom.window.document.activeElement, source);
      }
      if ("disabled" in source) {
        source.disabled = true;
        proxy.click();
        assert.equal(events.length, 1, "a stale enabled copy cannot activate a disabled source");
        assert.equal(scrollCalls.length, 0);
      }
      if (scenario.name === "checkbox" || scenario.name === "label") {
        await waitFor(() => assert.equal(
          controller.stickyHunkNaturalRow.querySelector("input").checked,
          true,
        ));
      }
    } finally {
      app.stop();
      dom.window.close();
    }
  });
}

test("forwards overlapping natural control selectors only once and keeps header selection", async () => {
  const { app, dom, controller, scrollCalls } = await startNaturalHeader(
    '<button class="native-control js-expand" type="button" aria-label="Expand up"><span class="hunk-kebab-icon">Expand</span></button>',
  );
  try {
    const source = controller.hunkRow.querySelector(".native-control");
    const proxy = controller.stickyHunkNaturalRow.querySelector(".native-control");
    let captures = 0;
    let clicks = 0;
    const capture = app.captureHostContextExpansionControl.bind(app);
    app.captureHostContextExpansionControl = (control) => {
      captures += 1;
      return capture(control);
    };
    source.addEventListener("click", () => {
      clicks += 1;
      assert.equal(captures, clicks, "capture the original expansion before its click handler runs");
      assert.ok(app.activeHostContextExpansionIntents().some((intent) =>
        intent.source.control === source,
      ));
    });
    const down = new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    proxy.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    proxy.click();
    proxy.querySelector("span").dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(clicks, 2, "button padding and its icon each activate exactly once");
    assert.equal(scrollCalls.length, 0);

    const text = controller.stickyHunkNaturalRow.querySelector(".native-header-text");
    const selection = dom.window.getSelection();
    const range = dom.window.document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.equal(selection.isCollapsed, false);
    text.click();
    assert.equal(scrollCalls.length, 0, "selected header text must not navigate");
    proxy.click();
    assert.equal(clicks, 3, "selection does not block a native control");
    selection.removeAllRanges();
  } finally {
    app.stop();
    dom.window.close();
  }
});
