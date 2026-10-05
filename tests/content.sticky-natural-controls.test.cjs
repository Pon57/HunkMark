const {
  test,
  assert,
  installContentStyles,
  startExtension,
  waitFor,
  duplicateHunkFixture,
} = require("./content-test-support.cjs");

async function startNaturalHeader(controls, { inForm = false } = {}) {
  let fixture = duplicateHunkFixture().replace(
    "@@ -1 +1 @@</td>",
    `<span class="native-header-text">@@ -1 +1 @@</span>${controls}</td>`,
  );
  if (inForm) {
    fixture = fixture.replace("<body>", '<body><form id="native-form">')
      .replace("</body>", "</form></body>");
  }
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


test("keeps natural form controls out of the host form and its submitted entries", async () => {
  const { app, dom, controller } = await startNaturalHeader(`
    <button data-native-kind="button" name="action" type="button" form="native-form">Action</button>
    <input data-native-kind="input" name="title" value="original" required form="native-form">
    <select data-native-kind="select" name="choice" form="native-form"><option selected value="one">One</option></select>
    <textarea data-native-kind="textarea" name="comment" form="native-form">body</textarea>
    <fieldset data-native-kind="fieldset" name="group" form="native-form"></fieldset>
    <object data-native-kind="object" name="preview" form="native-form"></object>
    <output data-native-kind="output" name="status" form="native-form">ready</output>
  `, { inForm: true });
  try {
    const form = dom.window.document.getElementById("native-form");
    assert.deepEqual(Array.from(new dom.window.FormData(form).entries()), [
      ["title", "original"], ["choice", "one"], ["comment", "body"],
    ]);
    const sources = Array.from(controller.hunkRow.querySelectorAll("[data-native-kind]"));
    const proxies = Array.from(controller.stickyHunkNaturalRow.querySelectorAll("[data-native-kind]"));
    assert.equal(sources.length, 7);
    assert.equal(proxies.length, sources.length);
    sources.forEach((source, index) => {
      const proxy = proxies[index];
      assert.equal(source.form, form);
      assert.equal(source.getAttribute("form"), "native-form");
      assert.ok(source.hasAttribute("name"));
      assert.equal(proxy.form, null, `${source.tagName} copy must not join the host form`);
      assert.equal(proxy.hasAttribute("name"), false);
      assert.equal(proxy.matches(":disabled"), source.matches(":disabled"));
      assert.equal(Array.from(form.elements).includes(proxy), false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not validate a natural input copy with the host form", async () => {
  const { app, dom, controller } = await startNaturalHeader(
    '<input class="native-required" name="title" value="valid" required>',
    { inForm: true },
  );
  try {
    const form = dom.window.document.getElementById("native-form");
    const source = controller.hunkRow.querySelector(".native-required");
    const proxy = controller.stickyHunkNaturalRow.querySelector(".native-required");
    proxy.value = "";
    assert.equal(source.checkValidity(), true);
    assert.equal(proxy.validity.valueMissing, true);
    assert.equal(form.checkValidity(), true, "a presentation copy cannot block native submission");
  } finally {
    app.stop();
    dom.window.close();
  }
});

for (const inForm of [true, false]) {
  test(`keeps natural radio copies out of the original group ${inForm ? "with" : "without"} a form`, async () => {
    const { app, dom, controller, scrollCalls } = await startNaturalHeader(`
      <input class="native-first" type="radio" name="review-choice" value="first" checked>
      <input class="native-second" type="radio" name="review-choice" value="second">
    `, { inForm });
    try {
      const first = controller.hunkRow.querySelector(".native-first");
      const second = controller.hunkRow.querySelector(".native-second");
      assert.equal(first.checked, true, "inserting the checked copy must not uncheck its source");
      assert.equal(second.checked, false);
      let clicks = 0;
      let changes = 0;
      second.addEventListener("click", () => { clicks += 1; });
      second.addEventListener("change", () => { changes += 1; });
      controller.stickyHunkNaturalRow.querySelector(".native-second").click();
      assert.equal(first.checked, false);
      assert.equal(second.checked, true, "only the original group performs native radio activation");
      assert.equal(clicks, 1);
      assert.equal(changes, 1);
      assert.equal(scrollCalls.length, 0);
      await waitFor(() => {
        const copies = controller.stickyHunkNaturalRow;
        assert.equal(copies.querySelector(".native-first").checked, false);
        assert.equal(copies.querySelector(".native-second").checked, true);
        assert.equal(first.checked, false);
        assert.equal(second.checked, true, "rebuilding copies must not alter the original selection");
      });
      if (inForm) {
        const form = dom.window.document.getElementById("native-form");
        assert.deepEqual(new dom.window.FormData(form).getAll("review-choice"), ["second"]);
      }
    } finally {
      app.stop();
      dom.window.close();
    }
  });
}
