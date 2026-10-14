const {
  test,
  assert,
  createChromeApi,
  createDeferred,
  startExtension,
  duplicateHunkFixture,
  controllersFor,
  waitFor,
} = require("./content-test-support.cjs");

function runtimeProbe() {
  const chrome = createChromeApi();
  const storageCalls = [];
  const storageListeners = new Set();
  const inputListeners = [];
  const inputTypes = new Set([
    "pointermove", "pointerup", "pointercancel", "pointerdown", "keydown",
    "click", "scroll", "wheel", "resize", "blur",
  ]);
  for (const method of ["get", "set", "remove"]) {
    const original = chrome.api.storage.local[method];
    chrome.api.storage.local[method] = (...args) => {
      storageCalls.push(method);
      return original(...args);
    };
  }
  for (const [method, operation] of [["addListener", "add"], ["removeListener", "delete"]]) {
    const original = chrome.api.storage.onChanged[method];
    chrome.api.storage.onChanged[method] = (listener) => {
      storageListeners[operation](listener);
      return original(listener);
    };
  }
  let navigation;
  return {
    chrome,
    storageCalls,
    storageListeners,
    get inputListeners() {
      return inputListeners.filter(({ signal }) => !signal?.aborted);
    },
    setupWindow(window) {
      navigation = new window.EventTarget();
      Object.defineProperty(window, "navigation", { value: navigation });
      for (const target of [window, window.document]) {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, listener, options) => {
          // Ignore jsdom's own listeners; abort signals also detach panel input.
          if (inputTypes.has(type) && listener instanceof window.Function) {
            inputListeners.push({ target, type, listener, signal: options?.signal });
          }
          return add(type, listener, options);
        };
        target.removeEventListener = (type, listener, options) => {
          const index = inputListeners.findIndex((entry) =>
            entry.target === target && entry.type === type && entry.listener === listener,
          );
          if (index >= 0) inputListeners.splice(index, 1);
          return remove(type, listener, options);
        };
      }
    },
    navigate(dom, path) {
      const from = { url: dom.window.location.href };
      dom.window.history.pushState({}, "", path);
      const event = new dom.window.Event("currententrychange");
      Object.assign(event, { from, navigationType: "push" });
      navigation.dispatchEvent(event);
    },
  };
}

function assertReviewStopped(app, dom, probe) {
  assert.equal(app.stopped, true);
  assert.equal(app.currentScope, null);
  assert.equal(app.currentReviewScope, null);
  assert.equal(app.observer, null);
  assert.equal(app.refreshTimer, null);
  assert.equal(app.refreshQueued, false);
  assert.equal(app.progressUpdateTimer, null);
  assert.equal(app.navigationPollTimer, null);
  assert.equal(app.controllersByRow.size, 0);
  assert.equal(probe.storageListeners.size, 0);
  assert.deepEqual(probe.inputListeners.map(({ type }) => type), []);
  assert.equal(dom.window.document.querySelector(
    "[data-hunkmark-ui]:not(style), .hunkmark-file-progress, #hunkmark-panel, .hunkmark-collapsed",
  ), null);
}

test("keeps review observers, input handlers, storage, and polling idle outside PR diffs", async (t) => {
  for (const path of [
    "/", "/octo/repo", "/octo/repo/issues/123", "/octo/repo/commit/abc123",
    "/octo/repo/compare/main...topic", "/octo/repo/pull/123",
    "/octo/repo/pull/123/commits", "/octo/repo/pull/123/checks",
  ]) {
    await t.test(path, async () => {
      const probe = runtimeProbe();
      const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
        chromeInstance: probe.chrome,
        setupWindow: probe.setupWindow,
        url: `https://github.com${path}`,
        waitForScope: false,
      });
      try {
        assertReviewStopped(app, dom, probe);
        dom.window.document.body.append(dom.window.document.createElement("main"));
        dom.window.document.body.click();
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
        dom.window.document.dispatchEvent(new dom.window.Event("turbo:load"));
        dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertReviewStopped(app, dom, probe);
        assert.deepEqual(probe.storageCalls, []);
      } finally {
        app.stop();
        dom.window.close();
      }
    });
  }
});

test("detaches review work on exit and restores saved state and fresh preferences on return", async () => {
  const probe = runtimeProbe();
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
    url: "https://github.com/octo/repo",
    waitForScope: false,
  });
  try {
    assertReviewStopped(app, dom, probe);
    probe.navigate(dom, "/octo/repo/pull/123/files");
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(controllersFor(app).length, 2);
    });
    await app.setHunkViewed(controllersFor(app)[0], true);
    const stored = probe.chrome.snapshot();
    app.scheduleProgressUpdate(controllersFor(app));
    app.scheduleRefresh();
    probe.navigate(dom, "/octo/repo/issues/123");
    assertReviewStopped(app, dom, probe);
    assert.equal(app.navigationStarted, true);
    const callsAfterExit = probe.storageCalls.length;
    dom.window.document.body.click();
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    dom.window.document.body.append(dom.window.document.createElement("aside"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    assertReviewStopped(app, dom, probe);
    assert.equal(probe.storageCalls.length, callsAfterExit);
    assert.deepEqual(probe.chrome.snapshot(), stored);

    await probe.chrome.api.storage.local.set({ [app.autoCollapsePreferenceKey]: false });
    probe.navigate(dom, "/octo/repo/pull/123/changes");
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(controllersFor(app).length, 2);
    });
    assert.equal(app.stopped, false);
    assert.ok(app.observer);
    assert.equal(app.navigationPollTimer, null);
    assert.equal(probe.storageListeners.size, 1);
    assert.equal(controllersFor(app)[0].marked, true);
    assert.equal(app.autoCollapseViewed, false);

    probe.navigate(dom, "/octo/repo/pull/123");
    assertReviewStopped(app, dom, probe);
    app.stop();
    probe.navigate(dom, "/octo/repo/pull/123/files");
    assertReviewStopped(app, dom, probe);
    assert.equal(app.navigationStarted, false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("reloads review storage changed by another tab while inactive", async () => {
  const probe = runtimeProbe();
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
  });
  try {
    const controller = controllersFor(app)[0];
    await app.setHunkViewed(controller, true);
    assert.equal(app.reviewStorageKeys.has(controller.lines[0].key), true);
    probe.navigate(dom, "/octo/repo");
    await probe.chrome.api.storage.local.remove(Object.keys(probe.chrome.snapshot()));
    probe.navigate(dom, "/octo/repo/pull/123/files");
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(controllersFor(app).length, 2);
    });
    assert.equal(controllersFor(app)[0].marked, false);
    assert.equal(app.reviewStorageKeys.has(controller.lines[0].key), false);
    assert.equal(app.reviewStorageKeys.has(controller.collapsedKey), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not resume stale discovery after leaving and reentering the same PR", async () => {
  const probe = runtimeProbe();
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
  });
  const pending = createDeferred();
  try {
    const oldSnapshot = app.hunkDiscoverySnapshot(dom.window.document);
    const loadPreferences = app.loadPreferences.bind(app);
    let waiting = false;
    app.loadPreferences = async () => {
      waiting = true;
      await pending.promise;
      return loadPreferences();
    };
    let discoveries = 0;
    const discover = app.discoverHunks.bind(app);
    app.discoverHunks = (...args) => {
      discoveries += 1;
      return discover(...args);
    };
    app.scheduleRefresh({ immediate: true });
    await waitFor(() => assert.equal(waiting, true));
    probe.navigate(dom, "/octo/repo");
    assertReviewStopped(app, dom, probe);
    probe.navigate(dom, "/octo/repo/pull/123/files");
    pending.resolve();
    await waitFor(() => {
      assert.equal(app.refreshRunning, false);
      assert.equal(app.refreshQueued, false);
      assert.equal(controllersFor(app).length, 2);
    });
    assert.equal(discoveries, 1);
    assert.equal(app.hunkDiscoverySnapshotIsCurrent(oldSnapshot), false);
    assert.equal(probe.storageListeners.size, 1);
  } finally {
    pending.resolve();
    app.stop();
    dom.window.close();
  }
});

test("does not show a reconnect notice outside supported PR diffs", async () => {
  const probe = runtimeProbe();
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
  });
  try {
    probe.navigate(dom, "/octo/repo");
    probe.chrome.invalidateContext();
    delete probe.chrome.api.runtime.id;
    app.stopForInvalidatedContext(new Error("Extension context invalidated."));
    assert.equal(dom.window.document.getElementById(app.constants.RECONNECT_NOTICE_ID), null);
    assertReviewStopped(app, dom, probe);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("fixes the reconnect notice to the viewport when review CSS was never loaded", async () => {
  const probe = runtimeProbe();
  let stylesheetRequests = 0;
  const sendMessage = probe.chrome.api.runtime.sendMessage;
  probe.chrome.api.runtime.sendMessage = (...args) => {
    stylesheetRequests += 1;
    return sendMessage(...args);
  };
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
    url: "https://github.com/octo/repo",
    waitForScope: false,
  });
  try {
    assert.equal(app.reviewStylesText, null);
    probe.chrome.invalidateContext();
    delete probe.chrome.api.runtime.id;
    probe.navigate(dom, "/octo/repo/pull/123/files");
    const notice = dom.window.document.getElementById(app.constants.RECONNECT_NOTICE_ID);
    assert.ok(notice);
    const style = dom.window.getComputedStyle(notice);
    assert.equal(style.position, "fixed");
    assert.equal(style.bottom, "18px");
    assert.ok(notice.querySelector("button"));
    assert.equal(stylesheetRequests, 0);
    assert.equal(app.observer, null);
    probe.navigate(dom, "/octo/repo");
    assert.equal(notice.isConnected, false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("shows a disconnected runtime notice only while visiting PR diffs", async () => {
  const probe = runtimeProbe();
  const { app, dom } = await startExtension(duplicateHunkFixture(), {}, {
    chromeInstance: probe.chrome,
    setupWindow: probe.setupWindow,
  });
  try {
    delete probe.chrome.api.runtime.id;
    app.stopForInvalidatedContext();
    const notice = () => dom.window.document.getElementById(app.constants.RECONNECT_NOTICE_ID);
    assert.ok(notice());
    const calls = probe.storageCalls.length;

    probe.navigate(dom, "/octo/repo/pull/123/commits");
    assert.equal(notice(), null);
    assertReviewStopped(app, dom, probe);
    probe.navigate(dom, "/octo/repo");
    assert.equal(notice(), null);
    probe.navigate(dom, "/octo/repo/pull/123/changes");
    assert.ok(notice());
    assertReviewStopped(app, dom, probe);
    assert.equal(probe.storageCalls.length, calls);
    assert.equal(app.navigationStarted, false);

    app.stop();
    assert.equal(notice(), null);
    probe.navigate(dom, "/octo/repo/pull/123/files");
    assert.equal(notice(), null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("updates a reconnect notice on host navigation events without URL polling", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    delete chrome.api.runtime.id;
    app.stopForInvalidatedContext();
    const notice = () => dom.window.document.getElementById(app.constants.RECONNECT_NOTICE_ID);
    assert.ok(notice());
    assert.equal(app.navigationPollTimer, null);
    for (const type of ["turbo:load", "turbo:render", "turbo:frame-load", "pjax:end", "popstate", "pageshow"]) {
      const target = ["popstate", "pageshow"].includes(type) ? dom.window : dom.window.document;
      dom.window.history.pushState({}, "", "/octo/repo/pull/123");
      target.dispatchEvent(new dom.window.Event(type));
      assert.equal(notice(), null, type);
      dom.window.history.pushState({}, "", "/octo/repo/pull/123/files");
      target.dispatchEvent(new dom.window.Event(type));
      assert.ok(notice(), type);
      assert.equal(dom.window.document.querySelectorAll(`#${app.constants.RECONNECT_NOTICE_ID}`).length, 1);
    }
    assert.equal(app.stopped, true);
    assert.equal(app.observer, null);
    assert.equal(app.navigationPollTimer, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});
