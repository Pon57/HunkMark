const {
  test, assert, JSDOM, Core, startExtension, stopExtensions, waitFor,
  createExclusiveLockManager, holdReviewStorageLock, controllersFor,
  setOfficialViewed, currentReactSplitContextExpansionFixture, installContentStyles,
  captureWarnings,
  createDeferred,
} = require("./content-test-support.cjs");

async function startReveals({ count = 2, cold = [], hide = null, review = null } = {}) {
  hide ??= Array.from({ length: count }, (_, index) => index);
  review ??= hide.filter((index) => !cold.includes(index));
  const clean = new JSDOM(currentReactSplitContextExpansionFixture());
  const template = clean.window.document.querySelector('[role="region"]');
  template.firstElementChild.insertAdjacentHTML("beforeend",
    '<button aria-label="Not Viewed" aria-pressed="false">Viewed</button>');
  const entry = template.outerHTML;
  const table = template.querySelector("table").outerHTML;
  clean.window.close();
  const bodies = Array.from({ length: count }, (_, index) => {
    let body = entry.replaceAll("split", `file${index}`);
    if (cold.includes(index)) body = body.replace(/<table[\s\S]*?<\/table>/, "")
      .replace('aria-label="Not Viewed" aria-pressed="false"', 'aria-label="Viewed" aria-pressed="true"');
    return body;
  });
  const locks = createExclusiveLockManager();
  const extension = await startExtension(`<!doctype html><html><body>${bodies.join("")}</body></html>`, {
    [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
  }, { lockManager: locks });
  const { app, dom } = extension;
  try {
    installContentStyles(dom);
    const files = Array.from(dom.window.document.querySelectorAll('[role="region"]'));
    const controls = files.map((file, index) => {
      const control = file.querySelector("button");
      control.addEventListener("click", () => {
        const viewed = control.getAttribute("aria-pressed") !== "true";
        setOfficialViewed(control, viewed);
        if (viewed) file.querySelector("table")?.remove();
        else file.insertAdjacentHTML("beforeend", table.replaceAll("split", `file${index}`));
      });
      return control;
    });
    for (const index of review) {
      await app.setHunkViewed(controllersFor(app).find((c) => c.fileElement === files[index]), true);
    }
    hide.filter((index) => !cold.includes(index)).forEach((index) => controls[index].click());
    await waitFor(() => {
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
      assert.equal(controllersFor(app).some((c) => hide.some((index) => c.fileElement === files[index])), false);
    });
    app.Core.clearIdentifierCache();
    return { ...extension, locks, files, controls };
  } catch (error) { stopExtensions(extension); throw error; }
}

function isVisible(extension, index) {
  const file = extension.files[index];
  return !file.classList.contains("hunkmark-file-reveal-restoring") &&
    extension.dom.window.getComputedStyle(file.querySelector("table")).display !== "none";
}

async function finish(extension, holder) {
  holder?.release();
  if (holder) await holder.promise;
  try {
    await waitFor(() => {
      assert.equal(extension.app.refreshRunning || extension.app.refreshQueued, false);
      assert.equal(extension.app.diffLoadHydrationRunningStates.size, 0);
      assert.equal(extension.app.officialViewedReviewPendingByKey.size, 0);
    }, 5000);
  } finally { stopExtensions(extension); }
}

test("reveals multiple cached files independently of a held storage lock", async (t) => {
  for (const staggered of [false, true]) {
    await t.test(staggered ? "second click after first paint" : "simultaneous clicks", async () => {
      const extension = await startReveals();
      const { app, locks, controls } = extension;
      let holder;
      try {
        holder = holdReviewStorageLock(app, locks); await holder.started;
        controls[0].click();
        if (staggered) await waitFor(() => assert.ok(isVisible(extension, 0)), 1800);
        controls[1].click();
        await waitFor(() => {
          assert.ok(isVisible(extension, 0)); assert.ok(isVisible(extension, 1));
        }, 1800);
        assert.equal(app.officialViewedReviewPendingByKey.size, 2);
        assert.ok(controllersFor(app).every((c) => c.marked && c.collapsed && !c.input.disabled));
        app.syncOfficialViewedEnabled = true;
        app.syncOfficialViewedForControllers(controllersFor(app));
        assert.ok(controls.every((c) => c.getAttribute("aria-pressed") === "false"));
      } finally { await finish(extension, holder); }
    });
  }
});

test("a later cached reveal progresses while cold files await review storage", async () => {
  const extension = await startReveals({ count: 3, cold: [0, 1] });
  const { app, locks, controls, files } = extension;
  let holder;
  try {
    holder = holdReviewStorageLock(app, locks); await holder.started;
    controls[0].click(); controls[1].click();
    await waitFor(() => assert.equal(Array.from(app.diffLoadHydrationRunningStates)
      .filter((state) => state.awaitingReviewState).length, 2), 1800);
    controls[2].click();
    await waitFor(() => assert.ok(isVisible(extension, 2)), 1800);
    assert.equal(isVisible(extension, 0), false);
    assert.equal(isVisible(extension, 1), false);
    const coldControllers = controllersFor(app).filter((c) => files.slice(0, 2).includes(c.fileElement));
    assert.ok(coldControllers.every((c) => c.reviewStateRestoring && c.input.disabled));
    holder.release(); await holder.promise;
    await waitFor(() => assert.ok(files.every((_, index) => isVisible(extension, index))));
    assert.ok(controllersFor(app).every((c) => !c.reviewStateRestoring && !c.input.disabled));
  } finally { await finish(extension, holder); }
});

test("quiet load settlement preserves an in-flight cold reveal", async (t) => {
  for (const phase of ["discovery", "review storage"]) {
    await t.test(phase, async () => {
      const extension = await startReveals({ count: 1, cold: [0] });
      const { app, controls, files, locks, dom } = extension;
      const gate = createDeferred();
      let holder;
      try {
        app.constants = { ...app.constants, DIFF_LOAD_REFRESH_SETTLE_MS: 20 };
        let fileDiscoveries = 0;
        const wholePageReadiness = [];
        const discover = app.discoverHunks.bind(app);
        app.discoverHunks = async (root, options) => {
          if (root === files[0]) fileDiscoveries += 1;
          if (root === dom.window.document) wholePageReadiness.push(
            isVisible(extension, 0) && controllersFor(app).every(
              (c) => !c.reviewStateRestoring && !c.input.disabled,
            ),
          );
          const result = await discover(root, options);
          if (root === files[0] && phase === "discovery") await gate.promise;
          return result;
        };
        if (phase === "review storage") {
          holder = holdReviewStorageLock(app, locks); await holder.started;
        }
        controls[0].click();
        await waitFor(() => {
          assert.equal(fileDiscoveries, 1);
          assert.equal(app.diffLoadHydrationRunningStates.size, 1);
          if (phase === "review storage") assert.ok(
            [...app.diffLoadHydrationRunningStates][0].awaitingReviewState,
          );
        });
        const [running] = app.diffLoadHydrationRunningStates;
        const pendingController = controllersFor(app)[0];
        let settlementChecked = false;
        const status = app.deferredDiffLoadStatus.bind(app);
        app.deferredDiffLoadStatus = () => { settlementChecked = true; return status(); };
        // GitHub updates this label after mounting the diff, while its review
        // restoration may still be waiting for hashing or the storage lock.
        files[0].setAttribute("aria-label", "Loaded diff for src/file0.js");
        await waitFor(() => {
          assert.ok(settlementChecked);
          assert.equal(app.deferredDiffLoadRefreshSettleTimer, null);
        });
        assert.equal(app.diffLoadHydrations.get(running.filePath), running);
        assert.equal(app.deferredDiffLoadRefreshes.size, 1);
        assert.notEqual(app.deferredDiffLoadRefreshTimer, null, "the maximum wait stays bounded");
        assert.equal(isVisible(extension, 0), false);
        gate.resolve(); holder?.release(); if (holder) await holder.promise;
        await waitFor(() => {
          assert.ok(isVisible(extension, 0));
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.diffLoadHydrationRunningStates.size, 0);
          assert.equal(app.deferredDiffLoadRefreshes.size, 0);
        });
        assert.equal(fileDiscoveries, 1, "the file is not discarded and rediscovered");
        assert.ok(wholePageReadiness.length > 0);
        assert.ok(wholePageReadiness.every(Boolean), "the file paints before the aggregate refresh");
        if (pendingController) assert.equal(controllersFor(app)[0], pendingController);
      } finally { gate.resolve(); await finish(extension, holder); }
    });
  }
});

test("a cached reveal uses the same recovery while an unrelated file loads", async () => {
  const extension = await startReveals({ hide: [0], review: [0] });
  const { app, locks, controls, files, dom } = extension;
  let holder, spinner;
  try {
    spinner = dom.window.document.createElement("span");
    spinner.setAttribute("role", "progressbar"); files[1].append(spinner);
    await waitFor(() => assert.ok(app.deferredDiffLoadRefreshes.size > 0));
    holder = holdReviewStorageLock(app, locks); await holder.started;
    controls[0].click();
    await waitFor(() => assert.ok(isVisible(extension, 0)), 1800);
    const target = controllersFor(app).find((c) => c.fileElement === files[0]);
    assert.equal(target.marked, true); assert.equal(target.collapsed, true);
    assert.equal(target.input.disabled, false);
    assert.ok(app.deferredDiffLoadRefreshes.size > 0, "the other loader is still active");
  } finally { spinner?.remove(); await finish(extension, holder); }
});

test("a cached paint does not expose changed content awaiting verification", async () => {
  const extension = await startReveals();
  const { app, controls, files, locks } = extension;
  let holder;
  try {
    holder = holdReviewStorageLock(app, locks); await holder.started;
    controls[0].click();
    files[0].querySelector(".right-side-diff-cell .diff-text-inner").textContent = "changed-content";
    await waitFor(() => assert.ok(controllersFor(app).find((c) => c.fileElement === files[0])?.reviewStateRestoring));
    controls[1].click();
    await waitFor(() => assert.ok(isVisible(extension, 1)), 1800);
    assert.equal(isVisible(extension, 0), false);
    holder.release(); await holder.promise;
    await waitFor(() => assert.ok(isVisible(extension, 0)));
    const changed = controllersFor(app).find((c) => c.fileElement === files[0]);
    assert.equal(changed.lines[1].marked, false); assert.equal(changed.collapsed, false);
  } finally { await finish(extension, holder); }
});

test("cached reveal guards settle after another hide, content replacement, or stop", async (t) => {
  for (const action of ["hide", "replace", "navigation", "stop"]) {
    await t.test(action, async () => {
      const extension = await startReveals({ count: 1 });
      const { app, locks, controls, files } = extension;
      let holder;
      try {
        holder = holdReviewStorageLock(app, locks); await holder.started;
        controls[0].click();
        await waitFor(() => assert.ok(isVisible(extension, 0)), 1800);
        if (action === "hide") controls[0].click();
        if (action === "replace") files[0].querySelector(".right-side-diff-cell .diff-text-inner").textContent = "replaced-after-paint";
        if (action === "navigation") {
          extension.dom.window.history.pushState({}, "", "/octo/repo/pull/124/files");
          app.checkForNavigation();
        }
        if (action === "stop") app.stop();
        holder.release(); await holder.promise;
        await waitFor(() => {
          assert.equal(app.officialViewedReviewPendingByKey.size, 0);
          assert.equal(app.refreshRunning || app.refreshQueued, false);
        }, 5000);
        if (action === "hide") assert.equal(controllersFor(app).length, 0);
        if (action === "replace") {
          const [current] = controllersFor(app);
          assert.equal(current.lines[1].text, "+replaced-after-paint");
          assert.equal(current.lines[1].marked, false);
          assert.equal(current.input.disabled, false);
        }
        if (action === "navigation") {
          assert.ok(app.currentReviewScope.includes("pull:124:"));
          assert.ok(controllersFor(app).every((c) => !c.marked && !c.input.disabled));
        }
      } finally { await finish(extension, holder); }
    });
  }
});

test("a failed queued reconciliation discards its controls and recovers", async () => {
  const extension = await startReveals({ cold: [0] });
  const { app, controls, files, dom } = extension;
  try {
    const warnings = captureWarnings(dom);
    const reconcile = app.reconcileNewReviewControllers.bind(app);
    let failed = false;
    app.reconcileNewReviewControllers = (options) => {
      if (!failed && options.newControllers.some((c) => c.fileElement === files[0])) {
        failed = true;
        return Promise.reject(new Error("test reconciliation failure"));
      }
      return reconcile(options);
    };
    controls.forEach((control) => control.click());
    await waitFor(() => {
      assert.ok(isVisible(extension, 0)); assert.ok(isVisible(extension, 1));
      assert.equal(app.diffLoadHydrationRunningStates.size, 0);
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.ok(controllersFor(app).every((c) => !c.reviewStateRestoring && !c.input.disabled));
    }, 5000);
    assert.equal(warnings.length, 1);
    assert.equal(files[0].querySelectorAll(".hunkmark-hunk-actions").length, 1);
  } finally { await finish(extension); }
});

test("a rejected storage barrier releases the automatic Viewed guard", async () => {
  const extension = await startReveals({ count: 1, hide: [], review: [] });
  const { app, dom } = extension;
  try {
    const warnings = captureWarnings(dom);
    app.withReviewStorageLock = async () => { throw new Error("test lock failure"); };
    app.deferOfficialViewedSyncAfterReveal(controllersFor(app));
    assert.equal(app.officialViewedReviewPendingByKey.size, 1);
    await waitFor(() => {
      assert.equal(app.officialViewedReviewPendingByKey.size, 0);
      assert.equal(warnings.length, 1);
    });
  } finally { stopExtensions(extension); }
});

test("a cached reveal proceeds while an unrelated full refresh waits for storage", async () => {
  const extension = await startReveals({ hide: [0], review: [0] });
  const { app, controls, files, locks } = extension;
  let holder;
  try {
    holder = holdReviewStorageLock(app, locks); await holder.started;
    let fullAtStorage = false;
    const reconcile = app.reconcileNewReviewControllers.bind(app);
    app.reconcileNewReviewControllers = (options) => {
      if (app.refreshRunning && options.newControllers.some((c) => c.fileElement === files[1])) fullAtStorage = true;
      return reconcile(options);
    };
    files[1].querySelector(".right-side-diff-cell .diff-text-inner").textContent = "full-refresh-change";
    await waitFor(() => {
      assert.equal(fullAtStorage, true);
      assert.equal(app.refreshStickyLayoutReady, true);
    });
    controls[0].click();
    await waitFor(() => assert.ok(isVisible(extension, 0)), 1800);
    const pending = controllersFor(app).find((c) => c.fileElement === files[1]);
    assert.equal(pending.input.disabled, true);
    assert.equal(pending.reviewStateRestoring, true);
    holder.release(); await holder.promise;
    await waitFor(() => {
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.diffLoadHydrationRunningStates.size, 0);
      assert.ok(controllersFor(app).every((c) => !c.input.disabled && !c.reviewStateRestoring));
    });
    assert.equal(controllersFor(app).find((c) => c.fileElement === files[1]).lines[1].text, "+full-refresh-change");
  } finally { await finish(extension, holder); }
});

test("keeps file discovery behind an unfinished authoritative identifier generation", async () => {
  const extension = await startReveals({ hide: [0], review: [0] });
  const { app, controls, files, dom } = extension;
  const gate = createDeferred();
  try {
    const warnings = captureWarnings(dom);
    const discover = app.discoverHunks.bind(app);
    let fullHeld = false;
    app.discoverHunks = async (root, options) => {
      const result = await discover(root, options);
      if (root === dom.window.document && !fullHeld) {
        fullHeld = true;
        await gate.promise;
      }
      return result;
    };
    files[1].querySelector(".right-side-diff-cell .diff-text-inner").textContent = "new-full-identity";
    await waitFor(() => assert.equal(fullHeld, true));
    controls[0].click();
    await waitFor(() => assert.ok(Array.from(app.diffLoadHydrations.values()).some((state) => state.ready)));
    assert.equal(app.refreshStickyLayoutReady, false);
    assert.equal(app.diffLoadHydrationRunningStates.size, 0);
    assert.equal(isVisible(extension, 0), false);
    gate.resolve();
    await waitFor(() => {
      assert.ok(isVisible(extension, 0));
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.diffLoadHydrationRunningStates.size, 0);
      assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    }, 5000);
    assert.equal(warnings.length, 0);
    assert.equal(controllersFor(app).length, 2);
  } finally { gate.resolve(); await finish(extension); }
});
