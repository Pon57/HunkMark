const {
  test,
  assert,
  JSDOM,
  createDeferred,
  controllersFor,
  contextExpansionIntentFor,
  currentReactContextExpansionFixture,
  layoutReviewFixture,
  startExtension,
  startSharedExtensions,
  stopExtensions,
  waitFor,
} = require("./content-test-support.cjs");

const filePath = "src/layout.js";
const reviewHunks = (count) =>
  ["First", "Second", "Third"].slice(0, count).map((name, index) => ({
    additions: [`new${name}`],
    deletions: [`old${name}`],
    before: `before ${name.toLowerCase()}`,
    after: `after ${name.toLowerCase()}`,
    headerText: `@@ -${10 + index * 10} +${10 + index * 10} @@ ${name.toLowerCase()}()`,
  }));

function reviewFixture(layout, count, configure = () => {}) {
  const fixture = new JSDOM(layoutReviewFixture({ hunks: reviewHunks(count), layout }));
  try {
    const { document } = fixture.window;
    const file = document.querySelector(".js-file");
    file.className = "Diff-module__diff__layout";
    file.setAttribute("role", "region");
    file.removeAttribute("data-file-path");
    file.querySelector(".file-header").className =
      "DiffFileHeader-module__diff-file-header__layout";
    const table = file.querySelector("table");
    table.setAttribute("role", "grid");
    table.setAttribute("aria-label", `Diff for: ${filePath}`);
    table.querySelectorAll("tr").forEach((row) => {
      row.className = "diff-line-row";
    });
    table.querySelectorAll("td").forEach((cell) => {
      cell.setAttribute("role", "gridcell");
      if (cell.matches(".blob-code-hunk")) {
        cell.className = "diff-hunk-cell";
      } else if (cell.matches(".blob-num")) {
        cell.className = "new-diff-line-number";
      } else {
        const kind = cell.matches(".blob-code-addition") ? "addition"
          : cell.matches(".blob-code-deletion") ? "deletion" : "context";
        const side = cell.dataset.diffSide ??
          (kind === "deletion" ? "left" : "right");
        const code = document.createElement("code");
        code.className = kind === "context" ? "diff-text" : kind;
        code.dataset.diffSide = side;
        code.textContent = cell.textContent;
        cell.className = `diff-text-cell ${side}-side-diff-cell`;
        cell.removeAttribute("data-diff-side");
        cell.replaceChildren(code);
      }
    });
    configure(document);
    return fixture.serialize();
  } finally {
    fixture.window.close();
  }
}

function contextRows(layout, texts) {
  const sides = layout === "split" ? ["left", "right"] : ["right"];
  return texts.map((text) =>
    '<tr class="diff-line-row" data-line-type="context">' +
    sides.map((side) =>
      `<td role="gridcell" class="diff-text-cell ${side}-side-diff-cell">` +
      `<code class="diff-text" data-diff-side="${side}">${text}</code></td>`,
    ).join("") + "</tr>",
  ).join("");
}

function sourceLines(controller) {
  return Object.fromEntries(Array.from(
    controller.sharedCompletionSources,
    (source) => [source.key, Array.from(source.lineKeys)],
  ));
}

// Review decisions belong to changes, not to temporary DOM or hunk boundaries.
const marks = (controller) => Array.from(controller.lines, (line) => line.marked);
const fileControllers = (app) =>
  controllersFor(app).filter((controller) => controller.filePath === filePath);

function addBackground(document) {
  const fixture = new JSDOM(currentReactContextExpansionFixture());
  try {
    document.body.append(document.importNode(
      fixture.window.document.querySelectorAll('[role="region"]')[1], true,
    ));
  } finally {
    fixture.window.close();
  }
}

function expansionButton(document, label) {
  const button = document.createElement("button");
  button.className = label.startsWith("Expand all")
    ? "js-expand-all-difflines-button"
    : "ExpandableHunkHeaderDiffLine-module__expand-button-line__layout";
  button.setAttribute("aria-label", label);
  button.textContent = "Expand";
  return button;
}

function expandAllFixture(layout) {
  return reviewFixture(layout, 2, (document) => {
    document.querySelector(".DiffFileHeader-module__diff-file-header__layout")
      .append(expansionButton(document, "Expand all lines: " + filePath));
    addBackground(document);
  });
}

function separateHunkFixture(layout) {
  return reviewFixture(layout, 3, (document) => {
    const table = document.querySelector("table");
    table.querySelectorAll(".diff-hunk-cell")[1]
      .prepend(expansionButton(document, "Expand file from line 15 to line 19"));
    const row = table.tBodies[0].insertRow();
    row.className = "diff-line-row";
    const cell = row.insertCell();
    cell.className = "diff-hunk-cell";
    cell.setAttribute("role", "gridcell");
    cell.append(expansionButton(document, "Expand file down from line 31"));
    addBackground(document);
  });
}

function mergedTable(document, layout) {
  const fixture = new JSDOM(reviewFixture(layout, 2));
  try {
    const table = fixture.window.document.querySelector("table");
    table.querySelectorAll(".diff-hunk-cell")[1].closest("tr").remove();
    table.querySelector("code.deletion, code.addition").closest("tr")
      .insertAdjacentHTML("beforebegin", contextRows(layout, ["inserted near changes"]));
    return document.importNode(table, true);
  } finally {
    fixture.window.close();
  }
}

async function reviewedPair(html, otherHtml) {
  const pair = await startSharedExtensions(html, otherHtml);
  try {
    const { first, second } = pair;
    first.app.constants = {
      ...first.app.constants,
      DIFF_LOAD_FILE_HYDRATION_SETTLE_MS: 20,
      DIFF_LOAD_REFRESH_SETTLE_MS: 50,
    };
    const original = fileControllers(first.app);
    const other = fileControllers(second.app);
    const sourceKeys = original.map((controller) => controller.sharedCompletionKey);
    assert.deepEqual(other.map((controller) => controller.sharedCompletionKey), sourceKeys);
    assert.notEqual(other[0].lines[0].key, original[0].lines[0].key);
    for (const controller of original) {
      await first.app.setHunkViewed(controller, true);
    }
    await waitFor(() => assert.deepEqual(
      other.map((controller) => controller.marked), original.map(() => true),
    ));
    return { ...pair, original, other, sourceKeys };
  } catch (error) {
    stopExtensions(pair.first, pair.second);
    throw error;
  }
}

async function startBackgroundLoad(app) {
  const background = controllersFor(app).find(
    (controller) => controller.filePath === "src/react-two.js",
  );
  const loader = app.document.createElement("tr");
  loader.dataset.component = "loadingSpinner";
  loader.innerHTML = '<td role="progressbar">Loading another file</td>';
  background.fileElement.querySelector("tbody").append(loader);
  await waitFor(() => assert.equal(background.input.disabled, true));
  return loader;
}

async function changeBackground(app, loader) {
  const generation = app.diffMutationGeneration;
  const next = loader.cloneNode(true);
  loader.replaceWith(next);
  await waitFor(() => assert.ok(app.diffMutationGeneration > generation));
  return next;
}

// Model an obsolete read under the storage lock; do not depend on yield counts.
function holdReviewRead(app, lineKey) {
  const gate = createDeferred();
  const read = app.getLocalStorage.bind(app);
  let waiting = false;
  app.getLocalStorage = async (keys) => {
    const stored = await read(keys);
    if (!waiting && Array.isArray(keys) && keys.includes(lineKey)) {
      waiting = true;
      await gate.promise;
    }
    return stored;
  };
  return {
    wait: () => waitFor(() => assert.equal(waiting, true)),
    release: gate.resolve,
  };
}

async function readyControllers(app) {
  await waitFor(() => {
    assert.equal(app.refreshRunning, false);
    assert.equal(app.refreshQueued, false);
    assert.equal(app.deferredDiffLoadRefreshes.size, 0);
    assert.equal(app.diffLoadHydrations.size, 0);
    assert.ok(fileControllers(app).every((controller) => !controller.input.disabled));
  });
  return fileControllers(app);
}

for (const layout of ["unified", "split"]) {
  test("canonical hunk decisions win over stale render state (" + layout + ")", async () => {
    const { first: local, second: remote, chrome, original, other, sourceKeys } =
      await reviewedPair(
        expandAllFixture(layout),
        reviewFixture(layout === "unified" ? "split" : "unified", 2),
      );
    const { app, dom } = local;
    let read;
    let clearPromise;
    try {
      let loader = await startBackgroundLoad(app);
      read = holdReviewRead(app, original[0].lines[0].key);
      const file = original[0].fileElement;
      const control = file.querySelector('[aria-label="Expand all lines: ' + filePath + '"]');
      app.handleHostContextExpansionClick({ isTrusted: true, target: control });
      control.setAttribute("aria-label", "Collapse non-diff lines: " + filePath);
      control.className = "prc-Button-ButtonBase";
      file.querySelector("table").replaceWith(mergedTable(dom.window.document, layout));
      await read.wait();

      // A newer user decision must win even if the pending render is discarded.
      clearPromise = remote.app.setHunkViewed(other[0], false);
      loader = await changeBackground(app, loader);
      read.release();
      await clearPromise;
      loader.remove();
      let [merged] = await readyControllers(app);
      await waitFor(() => {
        [merged] = fileControllers(app);
        assert.deepEqual(marks(merged), [false, false, true, true]);
      });
      assert.equal(chrome.snapshot()[sourceKeys[0]].viewed, false);
      assert.equal(merged.indeterminate, true);

      const clearedAt = chrome.snapshot()[sourceKeys[0]].updatedAt;
      await app.setHunkViewed(merged, true);
      assert.ok(chrome.snapshot()[sourceKeys[0]].updatedAt > clearedAt);
      await waitFor(() => {
        [merged] = fileControllers(app);
        assert.deepEqual(marks(merged), [true, true, true, true]);
        assert.deepEqual(other.map((controller) => controller.marked), [true, true]);
      });
      await remote.app.setHunkViewed(other[1], false);
      await waitFor(() => {
        [merged] = fileControllers(app);
        assert.deepEqual(marks(merged), [true, true, false, false]);
      });
    } finally {
      read?.release();
      await Promise.resolve(clearPromise).finally(() => stopExtensions(local, remote));
    }
  });
}

test("review decisions stay attached to their changes across unrelated expansion", async () => {
  const { first: local, second: remote, chrome, original, other, sourceKeys } =
    await reviewedPair(separateHunkFixture("unified"), reviewFixture("split", 3));
  const { app } = local;
  let read;
  try {
    const file = original[0].fileElement;
    const gap = file.querySelector('[aria-label="Expand file from line 15 to line 19"]');
    app.handleHostContextExpansionClick({ isTrusted: true, target: gap });
    gap.closest("tr").remove();
    original[0].lines[0].element.closest("tr")
      .insertAdjacentHTML("beforebegin", contextRows("unified", ["inserted near first"]));
    await waitFor(() => {
      assert.equal(fileControllers(app).length, 2);
      assert.deepEqual(marks(fileControllers(app)[0]), [true, true, true, true]);
      assert.equal(contextExpansionIntentFor(app, filePath), null);
    });

    let loader = await startBackgroundLoad(app);
    read = holdReviewRead(app, fileControllers(app)[1].lines[0].key);
    const control = file.querySelector('[aria-label="Expand file down from line 31"]');
    app.handleHostContextExpansionClick({ isTrusted: true, target: control });
    control.closest("tr").insertAdjacentHTML("beforebegin",
      contextRows("unified", ["inserted after third", "more after third"]));
    control.closest("tr").remove();
    await read.wait();
    loader = await changeBackground(app, loader);
    read.release();
    loader.remove();
    await readyControllers(app);

    // Previously merged changes must still observe later decisions independently.
    await remote.app.setHunkViewed(other[0], false);
    assert.equal(chrome.snapshot()[sourceKeys[0]].viewed, false);
    await waitFor(() => {
      const [merged, third] = fileControllers(app);
      assert.deepEqual(marks(merged), [false, false, true, true]);
      assert.deepEqual(marks(third), [true, true]);
      assert.deepEqual(other.map((controller) => controller.marked), [false, true, true]);
    });
    await remote.app.setHunkViewed(other[2], false);
    await waitFor(() => {
      const [merged, third] = fileControllers(app);
      assert.deepEqual(marks(merged), [false, false, true, true]);
      assert.deepEqual(marks(third), [false, false]);
    });
  } finally {
    read?.release();
    stopExtensions(local, remote);
  }
});

test("shared review ownership requires the same change identity", async () => {
  const extension = await startExtension(reviewFixture("unified", 1));
  const { app } = extension;
  try {
    const [controller] = controllersFor(app);
    const snapshot = app.captureFileReviewSnapshot([controller], filePath);
    const sentinel = {
      key: "previously-merged-source",
      lineKeys: [controller.lines[0].key],
    };
    const group = {
      ...snapshot.hunks[0],
      sharedCompletionSources: [...snapshot.hunks[0].sharedCompletionSources, sentinel],
    };
    const sourcesFor = (capturedGroup) => sourceLines({
      sharedCompletionSources: app.contextExpansionSharedCompletionSources(
        controller,
        {
          fileIntents: [{ capture: { cachedHunkGroups: [capturedGroup] } }],
          opensHunk: false,
          previous: [],
          reviewIntents: [],
        },
      ),
    });
    const expected = sourceLines(controller);
    assert.deepEqual(sourcesFor(group), {
      ...expected,
      [sentinel.key]: sentinel.lineKeys,
    });
    for (const [label, replacement] of [
      ["hunk key", { key: `${group.key}:different` }],
      ["semantic header", { headerText: "@@ -10 +10 @@ different()" }],
      ["line order", { lines: Array.from(group.lines).reverse() }],
      ["line key", {
        lines: group.lines.map((line, index) =>
          index === 0 ? { ...line, key: `${line.key}:different` } : line,
        ),
      }],
      ["context fingerprint", {
        lines: group.lines.map((line, index) =>
          index === 0 ? { ...line, contextFingerprint: "different" } : line,
        ),
      }],
    ]) {
      assert.deepEqual(sourcesFor({ ...group, ...replacement }), expected, label);
    }
  } finally {
    stopExtensions(extension);
  }
});
