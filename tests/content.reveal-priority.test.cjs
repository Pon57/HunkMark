const {
  test, assert, JSDOM, Core, createDeferred, startExtension,
  stopExtensions, waitFor, installContentStyles, delayReviewStorageRead,
  controllersFor, setOfficialViewed, currentReactSplitContextExpansionFixture,
  createExclusiveLockManager, holdReviewStorageLock,
} = require("./content-test-support.cjs");

function revealFixture() {
  const fixture = new JSDOM(currentReactSplitContextExpansionFixture());
  const file = fixture.window.document.querySelector('[role="region"]');
  file.firstElementChild.insertAdjacentHTML("beforeend",
    '<button aria-label="Viewed" aria-pressed="true">Viewed</button>');
  const table = file.querySelector("table");
  const tableHtml = table.outerHTML;
  const rendered = fixture.serialize();
  table.remove();
  const hidden = fixture.serialize();
  fixture.window.close();
  return { hidden, rendered, tableHtml };
}

function installReveal(extension, tableHtml) {
  const { dom } = extension;
  installContentStyles(dom);
  const file = dom.window.document.querySelector('[role="region"]');
  const control = file.querySelector("button");
  control.addEventListener("click", () => {
    const viewed = control.getAttribute("aria-pressed") !== "true";
    setOfficialViewed(control, viewed);
    if (viewed) file.querySelector("table")?.remove();
    else file.insertAdjacentHTML("beforeend", tableHtml);
  });
  return { file, control };
}

test("restores persisted reviews before a cold React reveal paints", async (t) => {
  for (const mode of ["partial", "collapsed"]) {
    await t.test(mode, async () => {
      const fixture = revealFixture();
      const initialStorage = {
        [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
      };
      const seed = await startExtension(fixture.rendered.replace(
        'aria-label="Viewed" aria-pressed="true"',
        'aria-label="Not Viewed" aria-pressed="false"',
      ), initialStorage);
      let stored;
      try {
        const [controller] = controllersFor(seed.app);
        if (mode === "collapsed") await seed.app.setHunkViewed(controller, true);
        else await seed.chrome.api.storage.local.set({
          [controller.lines[0].key]: seed.app.lineReviewStorageValue(controller.lines[0], Date.now()),
        });
        stored = seed.chrome.snapshot();
      } finally { stopExtensions(seed); }

      const extension = await startExtension(fixture.hidden, stored);
      const { app, dom } = extension;
      const gate = createDeferred();
      const discoveryRoots = [];
      const reviewRead = delayReviewStorageRead(app);
      try {
        const { file, control } = installReveal(extension, fixture.tableHtml);
        const discover = app.discoverHunks.bind(app);
        app.discoverHunks = async (root, options) => {
          discoveryRoots.push(root);
          if (root === dom.window.document) {
            await gate.promise;
          }
          return discover(root, options);
        };
        control.click();
        await waitFor(() => assert.ok(discoveryRoots.length > 0));
        assert.equal(discoveryRoots[0], file);
        await reviewRead.started;
        assert.equal(dom.window.getComputedStyle(file.querySelector("table")).display, "none");
        reviewRead.release();
        await waitFor(() => assert.ok(discoveryRoots.includes(dom.window.document)));
        assert.equal(file.classList.contains("hunkmark-file-reveal-restoring"), false);
        const [controller] = controllersFor(app);
        assert.equal(controller.input.disabled, false);
        assert.equal(controller.lines[0].marked, true);
        assert.equal(controller.lines[1].marked, mode === "collapsed");
        assert.equal(controller.collapsed, mode === "collapsed");
        assert.equal(control.getAttribute("aria-pressed"), "false");
        if (mode === "collapsed") {
          assert.ok(controller.groupRows.filter(row => row !== controller.hunkRow)
            .every(row => row.classList.contains("hunkmark-collapsed")));
        }
      } finally {
        reviewRead.release();
        gate.resolve();
        await waitFor(() => assert.equal(app.refreshRunning || app.refreshQueued, false));
        stopExtensions(extension);
      }
    });
  }
});

test("discards stale priority hydration when a React reveal changes while storage is pending", async (t) => {
  for (const mutation of ["replacement", "changed line", "hidden again", "navigation"]) {
    await t.test(mutation, async () => {
      const fixture = revealFixture();
      const extension = await startExtension(fixture.hidden);
      const { app, dom } = extension;
      const read = delayReviewStorageRead(app);
      try {
        const { file, control } = installReveal(extension, fixture.tableHtml);
        control.click();
        await read.started;
        const stale = controllersFor(app)[0];
        assert.ok(stale);
        let currentFile = file;
        if (mutation === "replacement") {
          const clean = new JSDOM(fixture.rendered);
          const replacement = clean.window.document.querySelector('[role="region"]');
          setOfficialViewed(replacement.querySelector("button"), false);
          file.outerHTML = replacement.outerHTML;
          clean.window.close();
          currentFile = dom.window.document.querySelector('[role="region"]');
        } else if (mutation === "changed line") {
          file.querySelector(".right-side-diff-cell .diff-text-inner").textContent = "changedAfterReveal";
        } else if (mutation === "hidden again") {
          control.click();
        } else {
          dom.window.history.pushState({}, "", "/octo/repo/pull/124/files");
          app.checkForNavigation();
        }
        await Promise.resolve();
        read.release();
        await waitFor(() => {
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.controllersByRow.has(stale.hunkRow) &&
            app.controllersByRow.get(stale.hunkRow) === stale, false);
          assert.equal(app.fileRevealPrepaintRestores.size, 0);
        }, 5000);
        const controllers = controllersFor(app);
        if (mutation === "hidden again") assert.equal(controllers.length, 0);
        else {
          assert.equal(controllers.length, 1);
          assert.equal(controllers[0].fileElement, currentFile);
          assert.equal(controllers[0].input.disabled, false);
          if (mutation === "changed line") {
            assert.equal(controllers[0].lines[1].text, "+changedAfterReveal");
          }
        }
      } finally {
        read.release();
        stopExtensions(extension);
      }
    });
  }
});

test("restores simultaneous cold reveals before scanning unrelated files", async () => {
  const fixture = revealFixture();
  const fragment = new JSDOM(fixture.hidden);
  const entry = fragment.window.document.querySelector('[role="region"]').outerHTML;
  fragment.window.close();
  const extension = await startExtension(fixture.hidden.replace("</body>",
    `${entry.replaceAll("split", "second")}</body>`));
  const { app, dom } = extension;
  const gate = createDeferred();
  let wholePageStarted = false;
  try {
    installContentStyles(dom);
    const files = Array.from(dom.window.document.querySelectorAll('[role="region"]'));
    const roots = [];
    const discover = app.discoverHunks.bind(app);
    app.discoverHunks = async (root, options) => {
      roots.push(root);
      if (root === dom.window.document) {
        wholePageStarted = true;
        await gate.promise;
      }
      return discover(root, options);
    };
    files.forEach((file, index) => {
      const control = file.querySelector("button");
      control.addEventListener("click", () => {
        setOfficialViewed(control, false);
        file.insertAdjacentHTML("beforeend", index === 0
          ? fixture.tableHtml : fixture.tableHtml.replaceAll("split", "second"));
      });
      control.click();
    });
    await waitFor(() => assert.equal(wholePageStarted, true));
    assert.deepEqual(roots.slice(0, 2), files);
    assert.equal(app.fileRevealPrepaintRestores.size, 0);
    assert.equal(app.controllersByRow.size, 2);
    assert.ok(files.every(file => dom.window.getComputedStyle(file.querySelector("table")).display !== "none"));
  } finally {
    gate.resolve();
    await waitFor(() => assert.equal(app.refreshRunning || app.refreshQueued, false));
    stopExtensions(extension);
  }
});

test("prioritizes cached Viewed reveals after their identifiers are evicted", async (t) => {
  for (const mode of ["unreviewed", "partial", "collapsed"]) {
    await t.test(mode, async () => {
      const fixture = revealFixture();
      const extension = await startExtension(fixture.rendered.replace(
        'aria-label="Viewed" aria-pressed="true"',
        'aria-label="Not Viewed" aria-pressed="false"',
      ), {
        [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
      });
      const { app, dom, chrome } = extension;
      const gate = createDeferred();
      let reviewRead;
      try {
        const { file, control } = installReveal(extension, fixture.tableHtml);
        const [original] = controllersFor(app);
        if (mode === "collapsed") await app.setHunkViewed(original, true);
        if (mode === "partial") await chrome.api.storage.local.set({
          [original.lines[0].key]: app.lineReviewStorageValue(original.lines[0], Date.now()),
        });
        control.click();
        await waitFor(() => {
          assert.equal(app.controllersByRow.size, 0);
          assert.equal(app.refreshRunning || app.refreshQueued, false);
          assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
        });
        assert.ok(app.fileProgressStateByKey.has(app.fileProgressStateKey(original.filePath)));
        assert.ok(app.fileReviewSnapshotsByKey.has(app.fileProgressStateKey(original.filePath)));
        // Review snapshots outlive the bounded identifier cache. Reopening
        // must recover even when synchronous discovery cannot resolve its keys.
        app.Core.clearIdentifierCache();
        reviewRead = delayReviewStorageRead(app);
        const roots = [];
        const discover = app.discoverHunks.bind(app);
        app.discoverHunks = async (root, options) => {
          roots.push(root);
          if (root === dom.window.document) await gate.promise;
          return discover(root, options);
        };
        control.click();
        await waitFor(() => assert.ok(roots.length > 0));
        assert.equal(roots[0], file, "cached progress must not force a whole-page wait");
        await waitFor(() => assert.ok(roots.includes(dom.window.document)));
        assert.equal(file.classList.contains("hunkmark-file-reveal-restoring"), false);
        const [restored] = controllersFor(app);
        assert.equal(restored.input.disabled, false);
        assert.equal(restored.lines[0].marked, mode !== "unreviewed");
        assert.equal(restored.lines[1].marked, mode === "collapsed");
        assert.equal(restored.collapsed, mode === "collapsed");
        assert.equal(control.getAttribute("aria-pressed"), "false");
      } finally {
        reviewRead?.release();
        gate.resolve();
        await waitFor(() => assert.equal(app.refreshRunning || app.refreshQueued, false));
        stopExtensions(extension);
      }
    });
  }
});

test("paints a verified cached reveal while preserving a queued Not Viewed intent", async () => {
  const fixture = revealFixture();
  const locks = createExclusiveLockManager();
  const extension = await startExtension(fixture.rendered.replace(
    'aria-label="Viewed" aria-pressed="true"',
    'aria-label="Not Viewed" aria-pressed="false"',
  ), {
    [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
  }, { lockManager: locks });
  const { app } = extension;
  let holder;
  try {
    const { file, control } = installReveal(extension, fixture.tableHtml);
    await app.setHunkViewed(controllersFor(app)[0], true);
    control.click();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
    });
    app.Core.clearIdentifierCache();
    holder = holdReviewStorageLock(app, locks);
    await holder.started;
    control.click();
    await waitFor(() => {
      assert.equal(file.classList.contains("hunkmark-file-reveal-restoring"), false);
      assert.equal(app.controllersByRow.size, 1);
    });
    const [restored] = controllersFor(app);
    assert.equal(restored.marked, true);
    assert.equal(restored.collapsed, true);
    assert.equal(app.officialViewedReviewPendingByKey.has(restored.officialSuppressionKey), true);
    app.syncOfficialViewedEnabled = true;
    app.syncOfficialViewedForControllers([restored]);
    assert.equal(control.getAttribute("aria-pressed"), "false");
    holder.release();
    await holder.promise;
    await waitFor(() => {
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.officialViewedReviewPendingByKey.size, 0);
      assert.equal(app.officialViewedSyncSuppressed.has(restored.officialSuppressionKey), true);
    });
    app.syncOfficialViewedForControllers([restored]);
    assert.equal(control.getAttribute("aria-pressed"), "false");
  } finally {
    holder?.release();
    stopExtensions(extension);
  }
});

test("waits for storage when an evicted cached reveal no longer matches its snapshot", async () => {
  const fixture = revealFixture();
  const extension = await startExtension(fixture.rendered.replace(
    'aria-label="Viewed" aria-pressed="true"',
    'aria-label="Not Viewed" aria-pressed="false"',
  ), {
    [`${Core.PREFERENCE_STORAGE_NAMESPACE}:preference:sync-github-file-viewed`]: false,
  });
  const { app, dom } = extension;
  const gate = createDeferred();
  let read;
  try {
    const { file, control } = installReveal(extension, fixture.tableHtml);
    await app.setHunkViewed(controllersFor(app)[0], true);
    control.click();
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(app.refreshRunning || app.refreshQueued, false);
      assert.equal(app.officialViewedReconcileGenerationByKey.size, 0);
    });
    app.Core.clearIdentifierCache();
    read = delayReviewStorageRead(app);
    let fullStarted = false;
    const discover = app.discoverHunks.bind(app);
    app.discoverHunks = async (root, options) => {
      if (root === dom.window.document) {
        fullStarted = true;
        await gate.promise;
      }
      return discover(root, options);
    };
    control.click();
    file.querySelector(".right-side-diff-cell .diff-text-inner").textContent = "differentContent";
    await read.started;
    assert.equal(file.classList.contains("hunkmark-file-reveal-restoring"), true);
    assert.equal(dom.window.getComputedStyle(file.querySelector("table")).display, "none");
    read.release();
    await waitFor(() => assert.equal(fullStarted, true));
    const [restored] = controllersFor(app);
    assert.equal(restored.lines[1].text, "+differentContent");
    assert.equal(restored.lines[1].marked, false);
    assert.equal(restored.collapsed, false);
    assert.equal(restored.input.disabled, false);
    assert.equal(file.classList.contains("hunkmark-file-reveal-restoring"), false);
  } finally {
    read?.release();
    gate.resolve();
    await waitFor(() => assert.equal(app.refreshRunning || app.refreshQueued, false));
    stopExtensions(extension);
  }
});
