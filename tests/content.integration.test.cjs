"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Core = require("../core.js");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
const extensionScripts = manifest.content_scripts[0].js;
const DEFAULT_VIEWER_LOGIN = "octocat";

function viewerReviewContext(
  context,
  viewerLogin = DEFAULT_VIEWER_LOGIN,
) {
  return Core.reviewViewerScope(context, `login:${viewerLogin}`);
}

function createChromeApi(initial = {}) {
  const data = { ...structuredClone(initial) };
  const listeners = new Set();
  let contextInvalidated = false;
  let nextSetError = null;

  function requireValidContext() {
    if (contextInvalidated) {
      throw new Error("Extension context invalidated.");
    }
  }

  function emit(changes) {
    if (Object.keys(changes).length === 0) {
      return;
    }
    listeners.forEach((listener) => listener(changes, "local"));
  }

  const local = {
    async get(keys) {
      requireValidContext();
      if (keys === null || keys === undefined) {
        return structuredClone(data);
      }
      if (typeof keys === "string") {
        return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => key in data)
            .map((key) => [key, structuredClone(data[key])]),
        );
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          key in data ? structuredClone(data[key]) : fallback,
        ]),
      );
    },

    async set(values) {
      requireValidContext();
      if (nextSetError) {
        const error = nextSetError;
        nextSetError = null;
        throw error;
      }
      const changes = {};
      Object.entries(values).forEach(([key, value]) => {
        const oldValue = data[key];
        data[key] = structuredClone(value);
        changes[key] = {
          oldValue: structuredClone(oldValue),
          newValue: structuredClone(value),
        };
      });
      emit(changes);
    },

    async remove(keys) {
      requireValidContext();
      const changes = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => {
        if (!(key in data)) {
          return;
        }
        changes[key] = {
          oldValue: structuredClone(data[key]),
          newValue: undefined,
        };
        delete data[key];
      });
      emit(changes);
    },
  };

  return {
    api: {
      storage: {
        local,
        onChanged: {
          addListener(listener) {
            requireValidContext();
            listeners.add(listener);
          },
          removeListener(listener) {
            requireValidContext();
            listeners.delete(listener);
          },
        },
      },
    },
    snapshot() {
      return structuredClone(data);
    },
    failNextSet(message = "storage write failed") {
      nextSetError = new Error(message);
    },
    invalidateContext() {
      contextInvalidated = true;
    },
  };
}

async function waitFor(assertion, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function startExtension(
  html,
  initialStorage = {},
  {
    url = "https://github.com/octo/repo/pull/123/files",
    viewerLogin = DEFAULT_VIEWER_LOGIN,
    waitForScope = true,
  } = {},
) {
  const chrome = createChromeApi(initialStorage);
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url,
  });
  if (viewerLogin !== null) {
    const viewerMeta = dom.window.document.createElement("meta");
    viewerMeta.name = "user-login";
    viewerMeta.content = viewerLogin;
    dom.window.document.head.append(viewerMeta);
  }
  dom.window.chrome = chrome.api;
  dom.window.ResizeObserver = class ResizeObserver {
    observe() {}
    disconnect() {}
  };

  extensionScripts.forEach((relative) => {
    dom.window.eval(fs.readFileSync(path.join(root, relative), "utf8"));
  });

  if (waitForScope) {
    await waitFor(() => {
      assert.ok(dom.window.HunkMarkContent.activeApp.currentScope);
    });
  }
  return { chrome, dom, app: dom.window.HunkMarkContent.activeApp };
}

function duplicateHunkFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/example.js">
        <div class="file-header"><span class="file-info">src/example.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+return null;</td></tr>
          <tr><td class="blob-code-hunk">@@ -50 +50 @@</td></tr>
          <tr><td class="blob-num">50</td><td class="blob-code-addition">+return null;</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function mergeableHunkFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/merge.js">
        <div class="file-header"><span class="file-info">src/merge.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
          <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
          <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
          <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function commitSelectionFixture({ withOfficialControl = true } = {}) {
  const officialControl = withOfficialControl
    ? '<button aria-label="Not Viewed" aria-pressed="false">Viewed</button>'
    : "";
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/selection.js">
        <div class="file-header">
          <span class="file-info">src/selection.js</span>
          ${officialControl}
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function evolvingCommitFixture(updated = false, officialViewed = null) {
  const officialControl =
    officialViewed === null
      ? ""
      : `<button aria-label="${officialViewed ? "Viewed" : "Not Viewed"}" aria-pressed="${officialViewed}">Viewed</button>`;
  const changedRows = updated
    ? `<tr><td class="blob-num">0</td><td class="blob-code-context">before stable</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-addition">+new</td></tr>
       <tr><td class="blob-num">3</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">4</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">5</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">6</td><td class="blob-code-context">after repeats</td></tr>`
    : `<tr><td class="blob-num">0</td><td class="blob-code-context">before stable</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after stable</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">3</td><td class="blob-code-addition">+repeat</td></tr>
       <tr><td class="blob-num">4</td><td class="blob-code-context">after repeats</td></tr>`;
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/evolving.js">
        <div class="file-header">
          <span class="file-info">src/evolving.js</span>
          ${officialControl}
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1,${updated ? 5 : 3} @@</td></tr>
          ${changedRows}
        </tbody></table>
      </div>
    </body></html>`;
}

function replacePageBody(dom, html) {
  const replacement = new JSDOM(html);
  const nodes = Array.from(replacement.window.document.body.childNodes, (node) =>
    dom.window.document.importNode(node, true),
  );
  dom.window.document.body.replaceChildren(...nodes);
  replacement.window.close();
  dom.window.document.dispatchEvent(new dom.window.Event("turbo:load"));
}

function replaceMergeFixtureRows(document, merged) {
  const tbody = document.querySelector("tbody");
  tbody.innerHTML = merged
    ? `<tr><td class="blob-code-hunk">@@ -1,10 +1,10 @@</td></tr>
       <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
       <tr data-test-context><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
       <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
       <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
       <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>`
    : `<tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
       <tr><td class="blob-num">0</td><td class="blob-code-context">before first</td></tr>
       <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
       <tr><td class="blob-num">2</td><td class="blob-code-context">after first</td></tr>
       <tr><td class="blob-code-hunk">@@ -10 +10 @@</td></tr>
       <tr><td class="blob-num">9</td><td class="blob-code-context">before second</td></tr>
       <tr><td class="blob-num">10</td><td class="blob-code-addition">+second</td></tr>
       <tr><td class="blob-num">11</td><td class="blob-code-context">after second</td></tr>`;
}

function splitFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/split.js">
        <div class="file-header">
          <span class="file-info">src/split.js</span>
          <button aria-label="Not Viewed" aria-pressed="false">Viewed</button>
        </div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
          <tr>
            <td class="blob-num">1</td>
            <td class="blob-code-deletion" data-diff-side="left">-oldValue</td>
            <td class="blob-num">1</td>
            <td class="blob-code-addition" data-diff-side="right">+newValue</td>
          </tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function dragFixture() {
  return `<!doctype html>
    <html><body>
      <div class="js-file" data-file-path="src/drag.js">
        <div class="file-header"><span class="file-info">src/drag.js</span></div>
        <table><tbody>
          <tr><td class="blob-code-hunk">@@ -1 +1,3 @@</td></tr>
          <tr><td class="blob-num">1</td><td class="blob-code-addition">+first</td></tr>
          <tr><td class="blob-num">2</td><td class="blob-code-addition">+second</td></tr>
          <tr><td class="blob-num">3</td><td class="blob-code-addition">+third</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

function modernGridFixture() {
  return `<!doctype html>
    <html><body>
      <section class="position-relative">
        <div class="Diff-module__diffHeaderWrapper__VTI5w">
          <div class="DiffFileHeader-module__diff-file-header__UuNN4">
            <div class="d-flex overflow-hidden DiffFileHeader-module__file-path-section__ZcmB1">
              <h3 class="DiffFileHeader-module__file-name__VVXpg DiffFileHeader-module__file-name-truncate__NBVtv">
                <a href="#diff-modern"><code>src/modern.ts</code></a>
              </h3>
            </div>
            <button aria-label="Not Viewed" aria-pressed="false">Viewed</button>
            <button aria-labelledby="modern-file-toggle-label">Collapse</button>
            <span id="modern-file-toggle-label">Collapse file</span>
          </div>
        </div>
        <div role="row">
          <div role="gridcell" class="diff-hunk-cell" style="padding-right: 16px">@@ -4 +4,2 @@ render()</div>
        </div>
        <div role="row" data-line-type="deletion">
          <div role="gridcell" class="diff-text-cell left-side-diff-cell" data-line-anchor="diff-modernL4" style="line-height: 24px; padding-right: 24px">
            <code class="deletion" data-diff-side="left">-old</code>
          </div>
        </div>
        <div role="row" data-line-type="addition">
          <div role="gridcell" class="diff-text-cell right-side-diff-cell" data-line-anchor="diff-modernR4" style="line-height: 24px; padding-right: 24px">
            <button aria-label="Add a line comment" style="background-color: rgb(31, 111, 235)">+</button>
            <code class="addition" data-diff-side="right"><span style="background-color: rgb(46, 160, 67)">+import</span><br>long.package.name<br>Type</code>
          </div>
        </div>
      </section>
    </body></html>`;
}

function contextualLineFixture({
  after = "after();",
  before = "before();",
  header = "@@ -10,3 +10,4 @@ function checkAccess() {",
  line = "+return true;",
  officialControl = false,
  signedOut = false,
  unresolved = false,
} = {}) {
  return `<!doctype html>
    <html><body>
      ${
        signedOut
          ? '<header><a href="/login?return_to=%2Focto%2Frepo">Sign in</a></header>'
          : ""
      }
      <div class="js-file" data-file-path="src/context.js">
        <div class="file-header">
          <span class="file-info">src/context.js</span>
          ${
            officialControl
              ? '<button aria-label="Not Viewed" aria-pressed="false">Viewed</button>'
              : ""
          }
        </div>
        ${
          unresolved
            ? '<div class="js-diff-load-container"><button>Load more lines</button></div>'
            : ""
        }
        <table><tbody>
          <tr><td class="blob-code-hunk">${header}</td></tr>
          <tr><td class="blob-num">9</td><td class="blob-code-context">${before}</td></tr>
          <tr><td class="blob-num">10</td><td class="blob-code-addition">${line}</td></tr>
          <tr><td class="blob-num">11</td><td class="blob-code-context">${after}</td></tr>
        </tbody></table>
      </div>
    </body></html>`;
}

test("places per-file progress beside the file name", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    const fileInfo = dom.window.document.querySelector(".file-info");
    await waitFor(() => {
      assert.match(
        fileInfo.querySelector(":scope > .hunkmark-file-progress").textContent,
        /Hunks 0\/2 · Lines 0\/2/,
      );
    });
    assert.equal(
      dom.window.document.querySelector(
        ".file-header > .hunkmark-file-progress",
      ),
      null,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("boots on a pull request and isolates duplicate lines in separate hunks", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-control input")
          .length,
        2,
      );
    });

    const inputs = dom.window.document.querySelectorAll(
      ".hunkmark-line-control input",
    );
    const firstController = Array.from(app.controllersByRow.values())[0];
    inputs[0].checked = true;
    inputs[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await waitFor(() => {
      assert.equal(inputs[0].checked, true);
      assert.equal(inputs[1].checked, false);
      assert.equal(firstController.marked, true);
      assert.equal(firstController.collapsed, true);
    });
    assert.equal(
      firstController.lines[0].element.classList.contains(
        "hunkmark-line-viewed",
      ),
      true,
    );
    assert.equal(
      firstController.lines[0].element.previousElementSibling.classList.contains(
        "hunkmark-line-viewed",
      ),
      false,
    );
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 1 \/ 2/,
    );

    const storedLineKeys = Object.keys(chrome.snapshot()).filter((key) =>
      key.includes(":line:"),
    );
    assert.equal(storedLineKeys.length, 1);
    assert.equal(
      chrome.snapshot()[firstController.collapsedKey].autoCollapsed,
      true,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("links split diff sides and syncs GitHub's official Viewed control", async () => {
  const { app, dom } = await startExtension(splitFixture());
  try {
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-pressed", "true");
    });

    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-control input")
          .length,
        2,
      );
    });
    const inputs = dom.window.document.querySelectorAll(
      ".hunkmark-line-control input",
    );
    inputs[0].checked = true;
    inputs[0].dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await waitFor(() => {
      assert.equal(inputs[0].checked, true);
      assert.equal(inputs[1].checked, true);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("distinguishes a manual official Viewed removal from a host reset", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
    });

    controllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });

    officialControl.click();
    const suppressionKey = app.officialViewedSuppressionKey(
      controllers[0].filePath,
    );
    await waitFor(() => {
      assert.equal(officialClicks, 2);
      assert.equal(officialControl.getAttribute("aria-pressed"), "false");
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), true);
    });

    app.syncOfficialViewedForControllers(controllers);
    assert.equal(officialClicks, 2);

    controllers[0].input.checked = false;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controllers[0].input.disabled, false);
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
    });
    controllers[0].input.checked = true;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 3);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores collapsed hunks before paint after GitHub removes its diff body", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
      if (viewed) {
        fileElement.querySelector("table")?.remove();
      } else {
        fileElement.insertAdjacentHTML("beforeend", cleanTable);
      }
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.collapsed,
        ),
        true,
      );
    });
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(fileElement.querySelector("table"), null);
    });

    officialControl.click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const rows = Array.from(dom.window.document.querySelectorAll("tbody tr"));
    assert.equal(rows.length, 4);
    assert.equal(rows[1].classList.contains("hunkmark-collapsed"), true);
    assert.equal(rows[3].classList.contains("hunkmark-collapsed"), true);

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.collapsed,
        ),
        true,
      );
      assert.equal(app.officialViewedRestoreGuards.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores cached controls before paint when GitHub expands a Viewed file", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    officialControl.addEventListener("click", () => {
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
      fileElement.querySelector("table")?.remove();
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
      assert.equal(app.controllersByRow.size, 0);
      assert.equal(fileElement.querySelector("table"), null);
    });

    fileElement.insertAdjacentHTML("beforeend", cleanTable);
    await Promise.resolve();

    const rows = Array.from(fileElement.querySelectorAll("tbody tr"));
    assert.equal(rows.length, 4);
    assert.equal(rows[1].classList.contains("hunkmark-collapsed"), true);
    assert.equal(rows[3].classList.contains("hunkmark-collapsed"), true);
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-hunk-actions").length,
      2,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );
    assert.match(
      fileElement.querySelector(".hunkmark-file-progress").textContent,
      /Hunks 2\/2 · Lines 2\/2/,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("synchronizes modern file progress with expand and collapse before paint", async () => {
  const { app, dom } = await startExtension(modernGridFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    const fileElement = controller.fileElement;
    const fileToggle = fileElement.querySelector(
      'button[aria-labelledby="modern-file-toggle-label"]',
    );
    const fileToggleLabel = fileElement.querySelector(
      "#modern-file-toggle-label",
    );
    const cleanFixture = new JSDOM(modernGridFixture());
    const rowsHtml = Array.from(
      cleanFixture.window.document.querySelectorAll('[role="row"]'),
      (row) => row.outerHTML,
    ).join("");
    cleanFixture.window.close();
    fileToggle.addEventListener("click", () => {
      if (fileToggleLabel.textContent === "Collapse file") {
        fileToggleLabel.textContent = "Expand file";
        fileElement
          .querySelectorAll('[role="row"]')
          .forEach((row) => row.remove());
        return;
      }
      fileToggleLabel.textContent = "Collapse file";
      fileElement
        .querySelector(".Diff-module__diffHeaderWrapper__VTI5w")
        .setAttribute("aria-busy", "true");
      fileElement.insertAdjacentHTML("beforeend", rowsHtml);
    });

    fileToggle.click();
    await Promise.resolve();

    assert.equal(fileElement.querySelector(".hunkmark-file-progress"), null);
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 0);
    });

    fileToggle.click();
    await Promise.resolve();

    assert.equal(app.controllersByRow.size, 1);
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-hunk-actions").length,
      1,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );
    assert.match(
      fileElement.querySelector(".hunkmark-file-progress").textContent,
      /Hunks 0\/1 · Lines 0\/2/,
    );
    assert.equal(
      fileElement
        .querySelector(".Diff-module__diffHeaderWrapper__VTI5w")
        .getAttribute("aria-busy"),
      "true",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores reviewed line backgrounds before rebuilding controllers", async () => {
  const autoCollapsePreferenceKey =
    `${Core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
  const { app, dom } = await startExtension(
    commitSelectionFixture(),
    { [autoCollapsePreferenceKey]: false },
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(app.autoCollapseViewed, false);
    });
    const cleanFixture = new JSDOM(commitSelectionFixture());
    const cleanTable =
      cleanFixture.window.document.querySelector("table").outerHTML;
    cleanFixture.window.close();
    const fileElement = dom.window.document.querySelector(".js-file");
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let progressPresentWhenOfficialViewed = null;
    officialControl.addEventListener("click", () => {
      const viewed = officialControl.getAttribute("aria-pressed") !== "true";
      officialControl.setAttribute(
        "aria-label",
        viewed ? "Viewed" : "Not Viewed",
      );
      officialControl.setAttribute("aria-pressed", String(viewed));
      if (viewed) {
        progressPresentWhenOfficialViewed = Boolean(
          fileElement.querySelector(".hunkmark-file-progress"),
        );
        fileElement.querySelector("table")?.remove();
      } else {
        fileElement.insertAdjacentHTML("beforeend", cleanTable);
      }
    });

    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
      assert.equal(app.controllersByRow.size, 0);
    });
    assert.equal(progressPresentWhenOfficialViewed, false);
    assert.equal(fileElement.querySelector(".hunkmark-file-progress"), null);

    officialControl.click();
    await Promise.resolve();

    const restoredLines = Array.from(
      fileElement.querySelectorAll(".blob-code-addition"),
    );
    assert.equal(restoredLines.length, 2);
    assert.equal(
      restoredLines.every((line) =>
        line.classList.contains("hunkmark-line-viewed"),
      ),
      true,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      0,
    );
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-collapsed").length,
      0,
    );
    const progress = fileElement.querySelector(".hunkmark-file-progress");
    assert.ok(progress);
    assert.match(progress.textContent, /Hunks 2\/2 · Lines 2\/2/);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(
      fileElement.querySelectorAll(".hunkmark-line-control").length,
      2,
    );

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) =>
            !controller.collapsed &&
            controller.lines.every(
              (line) =>
                line.marked &&
                line.element.classList.contains("hunkmark-line-viewed"),
            ),
        ),
        true,
      );
      assert.equal(app.officialViewedRestoreGuards.size, 0);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("respects a persisted manual official Viewed removal after reload", async () => {
  const reviewContext = viewerReviewContext(
    "github.com:octo/repo:pull:123",
  );
  const reviewScope = Core.reviewStateScope(
    reviewContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const filePath = "src/selection.js";
  const suppressionKey = Core.officialSyncSuppressionKey(
    reviewScope,
    filePath,
  );
  const now = Date.now();
  const initial = {
    [Core.lineStorageKey(
      reviewScope,
      filePath,
      "addition",
      "+first",
    )]: {
      contextFingerprint: Core.lineReviewContextFingerprint({
        headerText: "@@ -1 +1 @@",
        blockSignature: "addition:unified:+first",
      }),
      viewedAt: now,
    },
    [Core.lineStorageKey(
      reviewScope,
      filePath,
      "addition",
      "+second",
    )]: {
      contextFingerprint: Core.lineReviewContextFingerprint({
        headerText: "@@ -10 +10 @@",
        blockSignature: "addition:unified:+second",
      }),
      viewedAt: now,
    },
    [suppressionKey]: { suppressed: true, updatedAt: now },
    [Core.reviewContextMetadataKey(reviewContext)]: { lastAccessedAt: now },
  };
  const { app, chrome, dom } = await startExtension(
    commitSelectionFixture(),
    initial,
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => controller.marked,
        ),
        true,
      );
      assert.equal(app.officialViewedSyncSuppressed.has(suppressionKey), true);
    });

    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    app.syncOfficialViewedForControllers(controllers);
    assert.equal(officialClicks, 0);

    controllers[0].input.checked = false;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
    });
    controllers[0].input.checked = true;
    controllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("auto-collapses a viewed hunk but allows expansion without unmarking", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );

    await waitFor(() => {
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, true);
      assert.equal(controller.collapseButton.textContent, "Expand");
    });
    assert.ok(chrome.snapshot()[controller.collapsedKey]);

    controller.collapseButton.click();
    await waitFor(() => {
      assert.equal(controller.collapsed, false);
      assert.equal(controller.marked, true);
      assert.equal(controller.input.checked, true);
      assert.equal(controller.collapsedKey in chrome.snapshot(), false);
    });

    controller.input.checked = false;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
      assert.equal(controller.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores saved review state after a page reload", async () => {
  const first = await startExtension(duplicateHunkFixture());
  let stored;
  try {
    await waitFor(() => {
      assert.equal(
        first.dom.window.document.querySelectorAll(
          ".hunkmark-line-control input",
        ).length,
        2,
      );
    });
    const input = first.dom.window.document.querySelector(
      ".hunkmark-line-control input",
    );
    input.checked = true;
    input.dispatchEvent(
      new first.dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(input.disabled, false);
      assert.equal(input.checked, true);
    });
    stored = first.chrome.snapshot();
  } finally {
    first.app.stop();
    first.dom.window.close();
  }

  const second = await startExtension(duplicateHunkFixture(), stored);
  try {
    await waitFor(() => {
      const inputs = second.dom.window.document.querySelectorAll(
        ".hunkmark-line-control input",
      );
      assert.equal(inputs.length, 2);
      assert.equal(inputs[0].checked, true);
      assert.equal(inputs[1].checked, false);
      assert.equal(
        Array.from(second.app.controllersByRow.values())[0].collapsed,
        true,
      );
    });
  } finally {
    second.app.stop();
    second.dom.window.close();
  }
});

test("reattaches hunk controls when GitHub replaces a header cell", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
    const oldCell = dom.window.document.querySelector("td.blob-code-hunk");
    const replacement = oldCell.cloneNode(false);
    replacement.textContent = "@@ -1 +1 @@";
    oldCell.replaceWith(replacement);

    await waitFor(() => {
      assert.equal(replacement.querySelectorAll(".hunkmark-hunk-actions").length, 1);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("expands a viewed hunk when GitHub reveals surrounding context", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.collapsed, true);
      assert.ok(chrome.snapshot()[controller.collapsedKey]);
    });

    const contextRow = dom.window.document.createElement("tr");
    const contextCell = dom.window.document.createElement("td");
    contextCell.colSpan = 2;
    contextCell.textContent = "surrounding context";
    contextRow.append(contextCell);
    controller.hunkRow.after(contextRow);

    await waitFor(() => {
      assert.equal(app.controllersByRow.get(controller.hunkRow), controller);
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, false);
      assert.equal(contextRow.classList.contains("hunkmark-collapsed"), false);
      assert.equal(controller.collapsedKey in chrome.snapshot(), false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("preserves viewed lines when GitHub merges expanded hunks", async () => {
  const { app, chrome, dom } = await startExtension(mergeableHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const before = Array.from(app.controllersByRow.values());
    const lineKeys = before.flatMap((controller) =>
      controller.lines.map((line) => line.key),
    );
    const collapsedKeys = before.map((controller) => controller.collapsedKey);

    before.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(before.every((controller) => controller.marked), true);
      assert.equal(before.every((controller) => controller.collapsed), true);
      assert.equal(
        collapsedKeys.every((key) => Boolean(chrome.snapshot()[key])),
        true,
      );
    });

    replaceMergeFixtureRows(dom.window.document, true);

    let merged;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      [merged] = Array.from(app.controllersByRow.values());
      assert.equal(merged.hunkRow.isConnected, true);
      assert.equal(merged.marked, true);
      assert.equal(merged.indeterminate, false);
      assert.equal(merged.collapsed, false);
      assert.equal(merged.collapseButton.textContent, "Collapse");
      assert.deepEqual(
        Array.from(merged.lines, (line) => line.key),
        lineKeys,
      );
      assert.equal(
        dom.window.document
          .querySelector("[data-test-context]")
          .classList.contains("hunkmark-collapsed"),
        false,
      );
      assert.equal(merged.collapsedKey in chrome.snapshot(), false);
      assert.equal(
        collapsedKeys.some((key) => key in chrome.snapshot()),
        false,
      );
    });
    assert.match(
      dom.window.document.querySelector(".hunkmark-panel-summary").textContent,
      /Hunks 1 \/ 1 · Lines 2 \/ 2/,
    );

    merged.input.checked = false;
    merged.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(merged.marked, false);
      assert.equal(
        lineKeys.some((key) => key in chrome.snapshot()),
        false,
      );
    });

    replaceMergeFixtureRows(dom.window.document, false);
    await waitFor(() => {
      const split = Array.from(app.controllersByRow.values());
      assert.equal(split.length, 2);
      assert.equal(split.every((controller) => controller.hunkRow.isConnected), true);
      assert.equal(split.every((controller) => !controller.marked), true);
      assert.equal(split.every((controller) => !controller.collapsed), true);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps unchanged lines viewed after a commit and resets ambiguous duplicates", async () => {
  const { app, chrome, dom } = await startExtension(evolvingCommitFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
      assert.equal(before.input.disabled, false);
    });
    const stableKey = before.lines[0].key;
    const duplicateKeys = before.lines.slice(1).map((line) => line.key);
    assert.equal(duplicateKeys.every((key) => Boolean(chrome.snapshot()[key])), true);

    replacePageBody(dom, evolvingCommitFixture(true));

    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.deepEqual(
        Array.from(after.lines, (line) => [line.text, line.marked]),
        [
          ["+stable", true],
          ["+new", false],
          ["+repeat", false],
          ["+repeat", false],
          ["+repeat", false],
        ],
      );
      assert.equal(after.lines[0].key, stableKey);
      assert.equal(
        after.lines
          .slice(2)
          .some((line) => duplicateKeys.includes(line.key)),
        false,
      );
      assert.equal(after.marked, false);
      assert.equal(after.indeterminate, true);
      assert.equal(after.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("resyncs official Viewed after a host reset without losing unchanged line state", async () => {
  const { app, chrome, dom } = await startExtension(
    evolvingCommitFixture(false, true),
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.input.disabled, false);
    });

    replacePageBody(dom, evolvingCommitFixture(true, false));

    let after;
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.deepEqual(
        Array.from(after.lines, (line) => [line.text, line.marked]),
        [
          ["+stable", true],
          ["+new", false],
          ["+repeat", false],
          ["+repeat", false],
          ["+repeat", false],
        ],
      );
      assert.equal(after.indeterminate, true);
    });

    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    after.input.checked = true;
    after.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(after.marked, true);
      assert.equal(after.input.disabled, false);
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
    const suppressionKey = app.officialViewedSuppressionKey(after.filePath);
    assert.equal(Boolean(chrome.snapshot()[suppressionKey]), false);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("fails closed when a reviewed line moves to a different context", async () => {
  const { app, chrome, dom } = await startExtension(
    contextualLineFixture({ before: "benign();", after: "log();" }),
  );
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
      assert.ok(chrome.snapshot()[before.lines[0].key]);
    });

    const originalLineElement = before.lines[0].element;
    const contextCells = dom.window.document.querySelectorAll(
      ".blob-code-context",
    );
    dom.window.document.querySelector(".blob-code-hunk").textContent =
      "@@ -210,3 +210,4 @@ function checkAccess() {";
    contextCells[0].textContent = "if (isAdmin) {";
    contextCells[1].textContent = "audit();";

    await waitFor(() => {
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.equal(after.lines[0].element, originalLineElement);
      assert.equal(after.lines[0].key, before.lines[0].key);
      assert.notEqual(
        after.lines[0].contextFingerprint,
        before.lines[0].contextFingerprint,
      );
      assert.equal(after.marked, false);
      assert.equal(after.collapsed, false);
      assert.equal(after.lines[0].key in chrome.snapshot(), false);
      assert.equal(after.collapsedKey in chrome.snapshot(), false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("fails closed when invisible Unicode changes a reviewed line", async () => {
  const { app, dom } = await startExtension(contextualLineFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const before = Array.from(app.controllersByRow.values())[0];
    before.input.checked = true;
    before.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(before.marked, true);
      assert.equal(before.collapsed, true);
    });

    replacePageBody(
      dom,
      contextualLineFixture({ line: "+return tr\u202eue;" }),
    );

    await waitFor(() => {
      const after = Array.from(app.controllersByRow.values())[0];
      assert.equal(after.hunkRow.isConnected, true);
      assert.notEqual(after.lines[0].key, before.lines[0].key);
      assert.equal(after.marked, false);
      assert.equal(after.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("ignores legacy line marks that lack context evidence", async () => {
  const discovery = await startExtension(contextualLineFixture());
  let lineKey;
  try {
    await waitFor(() => {
      assert.equal(discovery.app.controllersByRow.size, 1);
    });
    const controller = Array.from(
      discovery.app.controllersByRow.values(),
    )[0];
    lineKey = controller.lines[0].key;
  } finally {
    discovery.app.stop();
    discovery.dom.window.close();
  }

  const restored = await startExtension(contextualLineFixture(), {
    [lineKey]: { viewedAt: Date.now() },
  });
  try {
    await waitFor(() => {
      const controller = Array.from(
        restored.app.controllersByRow.values(),
      )[0];
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
      assert.equal(lineKey in restored.chrome.snapshot(), false);
    });
  } finally {
    restored.app.stop();
    restored.dom.window.close();
  }
});

test("isolates persisted review state by GitHub viewer", async () => {
  const first = await startExtension(contextualLineFixture(), {}, {
    viewerLogin: "alice",
  });
  let stored;
  try {
    await waitFor(() => {
      assert.equal(first.app.controllersByRow.size, 1);
    });
    const controller = Array.from(first.app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new first.dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.input.disabled, false);
    });
    stored = first.chrome.snapshot();
  } finally {
    first.app.stop();
    first.dom.window.close();
  }

  const second = await startExtension(contextualLineFixture(), stored, {
    viewerLogin: "bob",
  });
  try {
    await waitFor(() => {
      const controller = Array.from(second.app.controllersByRow.values())[0];
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, false);
    });
  } finally {
    second.app.stop();
    second.dom.window.close();
  }

  const third = await startExtension(contextualLineFixture(), stored, {
    viewerLogin: "alice",
  });
  try {
    await waitFor(() => {
      const controller = Array.from(third.app.controllersByRow.values())[0];
      assert.equal(controller.input.disabled, false);
      assert.equal(controller.marked, true);
    });
  } finally {
    third.app.stop();
    third.dom.window.close();
  }
});

test("uses an anonymous scope only when GitHub is explicitly signed out", async () => {
  const signedOut = await startExtension(
    contextualLineFixture({ signedOut: true }),
    {},
    { viewerLogin: null },
  );
  try {
    assert.equal(
      signedOut.app.currentScope,
      Core.reviewViewerScope(
        "github.com:octo/repo:pull:123",
        "anonymous",
      ),
    );
    assert.equal(signedOut.app.controllersByRow.size, 1);
  } finally {
    signedOut.app.stop();
    signedOut.dom.window.close();
  }

  const unidentified = await startExtension(
    contextualLineFixture(),
    {},
    { viewerLogin: null, waitForScope: false },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(unidentified.app.currentScope, null);
    assert.equal(unidentified.app.currentReviewScope, null);
    assert.equal(unidentified.app.controllersByRow.size, 0);
  } finally {
    unidentified.app.stop();
    unidentified.dom.window.close();
  }
});

test("does not sync official Viewed while diff content is unresolved", async () => {
  const { app, dom } = await startExtension(
    contextualLineFixture({ officialControl: true, unresolved: true }),
  );
  try {
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.input.disabled, false);
    });
    assert.equal(officialClicks, 0);

    dom.window.document.querySelector(".js-diff-load-container").remove();
    controller.input.checked = false;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, false);
      assert.equal(controller.input.disabled, false);
    });
    controller.input.checked = true;
    controller.input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("isolates selected-commit state and resets only the selected range", async () => {
  const { app, chrome, dom } = await startExtension(commitSelectionFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
      assert.equal(
        app.currentReviewVariant,
        app.Core.ALL_COMMITS_REVIEW_VARIANT,
      );
    });
    const allCommitsScope = app.currentReviewScope;
    const allControllers = Array.from(app.controllersByRow.values());
    allControllers[0].input.checked = true;
    allControllers[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(allControllers[0].marked, true);
      assert.equal(allControllers[1].marked, false);
      assert.equal(allControllers[0].input.disabled, false);
    });
    const allCommitsLineKey = allControllers[0].lines[0].key;

    dom.window.history.pushState(
      {},
      "",
      "/octo/repo/pull/123/changes/abc123",
    );
    replacePageBody(dom, commitSelectionFixture({ withOfficialControl: false }));

    let selectedControllers;
    await waitFor(() => {
      assert.equal(app.currentReviewVariant, "selected:abc123");
      assert.notEqual(app.currentReviewScope, allCommitsScope);
      selectedControllers = Array.from(app.controllersByRow.values());
      assert.equal(selectedControllers.length, 2);
      assert.equal(
        selectedControllers.every((controller) => controller.hunkRow.isConnected),
        true,
      );
      assert.equal(
        selectedControllers.every((controller) => !controller.marked),
        true,
      );
    });
    const selectedReviewScope = app.currentReviewScope;
    assert.equal(
      dom.window.document.querySelector('button[aria-pressed]'),
      null,
    );

    selectedControllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });
    await waitFor(() => {
      assert.equal(
        selectedControllers.every(
          (controller) => controller.marked && !controller.input.disabled,
        ),
        true,
      );
    });
    const selectedLineKeys = selectedControllers.flatMap((controller) =>
      controller.lines.map((line) => line.key),
    );
    const reviewContextMetadataKey = app.Core.reviewContextMetadataKey(
      app.currentScope,
    );
    assert.equal(selectedLineKeys.includes(allCommitsLineKey), false);
    assert.equal(Boolean(chrome.snapshot()[reviewContextMetadataKey]), true);

    dom.window.document.querySelector(".hunkmark-reset-button").click();
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(
        Object.keys(stored).some((key) =>
          app.Core.isReviewStorageKeyForScope(key, selectedReviewScope),
        ),
        false,
      );
      assert.equal(Boolean(stored[allCommitsLineKey]), true);
      assert.equal(Boolean(stored[reviewContextMetadataKey]), true);
      assert.equal(
        selectedControllers.every((controller) => !controller.marked),
        true,
      );
    });

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/changes");
    replacePageBody(dom, commitSelectionFixture());
    await waitFor(() => {
      const restored = Array.from(app.controllersByRow.values());
      assert.equal(app.currentReviewScope, allCommitsScope);
      assert.equal(restored.length, 2);
      assert.equal(restored.every((controller) => controller.hunkRow.isConnected), true);
      assert.equal(restored[0].marked, true);
      assert.equal(restored[1].marked, false);
    });

    dom.window.document.querySelector(".hunkmark-reset-button").click();
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(
        Object.keys(stored).some((key) =>
          app.Core.isReviewStorageKeyForContext(key, app.currentScope),
        ),
        false,
      );
      assert.equal(reviewContextMetadataKey in stored, false);
      assert.equal(
        Array.from(app.controllersByRow.values()).every(
          (controller) => !controller.marked,
        ),
        true,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("syncs official Viewed in a selected range when GitHub exposes it", async () => {
  const { app, dom } = await startExtension(commitSelectionFixture(), {}, {
    url: "https://github.com/octo/repo/pull/123/changes/abc123..head456",
  });
  try {
    await waitFor(() => {
      assert.equal(app.currentReviewVariant, "selected:abc123..head456");
      assert.equal(app.controllersByRow.size, 2);
    });
    const controllers = Array.from(app.controllersByRow.values());
    const officialControl = dom.window.document.querySelector(
      'button[aria-label="Not Viewed"]',
    );
    let officialClicks = 0;
    officialControl.addEventListener("click", () => {
      officialClicks += 1;
      officialControl.setAttribute("aria-label", "Viewed");
      officialControl.setAttribute("aria-pressed", "true");
    });

    controllers.forEach((controller) => {
      controller.input.checked = true;
      controller.input.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
    });

    await waitFor(() => {
      assert.equal(
        controllers.every(
          (controller) => controller.marked && !controller.input.disabled,
        ),
        true,
      );
      assert.equal(officialClicks, 1);
      assert.equal(officialControl.getAttribute("aria-pressed"), "true");
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("backfills access metadata and prunes inactive pull requests as complete units", async () => {
  const now = Date.now();
  const currentContext = viewerReviewContext(
    "github.com:octo/repo:pull:123",
  );
  const expiredContext = viewerReviewContext("github.com:old/repo:pull:9");
  const recentContext = viewerReviewContext("github.com:recent/repo:pull:7");
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const expiredScope = Core.reviewStateScope(
    expiredContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const expiredSelectedScope = Core.reviewStateScope(
    expiredContext,
    "selected:old..head",
  );
  const recentScope = Core.reviewStateScope(
    recentContext,
    "selected:abc..def",
  );
  const currentKey = Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const expiredLineKey = Core.lineStorageKey(
    expiredScope,
    "src/expired.js",
    "addition",
    "+expired",
  );
  const expiredCollapsedKey = `${Core.storageKey(
    expiredScope,
    "src/expired.js",
    "@@\n+expired",
  )}:collapsed`;
  const expiredSelectedKey = Core.lineStorageKey(
    expiredSelectedScope,
    "src/expired-selected.js",
    "deletion",
    "-expired-selected",
  );
  const recentKey = Core.lineStorageKey(
    recentScope,
    "src/recent.js",
    "addition",
    "+recent",
  );
  const preferenceKey =
    `${Core.STORAGE_NAMESPACE}:preference:auto-collapse-viewed`;
  const expiredAt = now - 181 * 24 * 60 * 60 * 1000;
  const recentAt = now - 7 * 24 * 60 * 60 * 1000;
  const obsoleteStateKey =
    `${Core.STORAGE_NAMESPACE}:line:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb:0`;
  const obsoleteMetadataKey =
    `${Core.STORAGE_NAMESPACE}:review-scope:aaaaaaaaaaaaaaaa`;
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture(), {
    [currentKey]: { viewedAt: expiredAt },
    [expiredLineKey]: { viewedAt: expiredAt },
    [expiredCollapsedKey]: { collapsed: true, updatedAt: expiredAt },
    [expiredSelectedKey]: { viewedAt: expiredAt },
    [recentKey]: { viewedAt: recentAt },
    [obsoleteStateKey]: { viewedAt: recentAt },
    [obsoleteMetadataKey]: { lastAccessedAt: recentAt },
    [preferenceKey]: true,
  });
  try {
    await waitFor(() => {
      const stored = chrome.snapshot();
      assert.equal(expiredLineKey in stored, false);
      assert.equal(expiredCollapsedKey in stored, false);
      assert.equal(expiredSelectedKey in stored, false);
      assert.equal(
        Core.reviewContextMetadataKey(expiredContext) in stored,
        false,
      );
      assert.equal(obsoleteStateKey in stored, false);
      assert.equal(obsoleteMetadataKey in stored, false);
      assert.equal(currentKey in stored, true);
      assert.ok(
        stored[Core.reviewContextMetadataKey(currentContext)].lastAccessedAt >=
          now,
      );
      assert.equal(recentKey in stored, true);
      assert.equal(
        stored[Core.reviewContextMetadataKey(recentContext)].lastAccessedAt,
        recentAt,
      );
      assert.equal(stored[preferenceKey], true);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("updates pull-request access metadata at most once per 24 hours", async () => {
  const now = Date.now();
  const currentContext = viewerReviewContext(
    "github.com:octo/repo:pull:123",
  );
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const stateKey = Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const metadataKey = Core.reviewContextMetadataKey(currentContext);
  const previousAccess = now - 60 * 60 * 1000;
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture(), {
    [stateKey]: { viewedAt: previousAccess },
    [metadataKey]: { lastAccessedAt: previousAccess },
  });
  try {
    await waitFor(() => {
      assert.equal(
        chrome.snapshot()[metadataKey].lastAccessedAt,
        previousAccess,
      );
    });

    const beforeInterval = await app.touchReviewContextAccess(
      currentContext,
      previousAccess + app.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS - 1,
    );
    assert.equal(beforeInterval, false);
    assert.equal(
      chrome.snapshot()[metadataKey].lastAccessedAt,
      previousAccess,
    );

    const nextAccess =
      previousAccess + app.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS + 1;
    const afterInterval = await app.touchReviewContextAccess(
      currentContext,
      nextAccess,
    );
    assert.equal(afterInterval, true);
    assert.equal(chrome.snapshot()[metadataKey].lastAccessedAt, nextAccess);

    const emptyContext = viewerReviewContext("github.com:empty/repo:pull:99");
    const emptyAccess = await app.touchReviewContextAccess(
      emptyContext,
      nextAccess,
    );
    assert.equal(emptyAccess, false);
    assert.equal(
      Core.reviewContextMetadataKey(emptyContext) in chrome.snapshot(),
      false,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("evicts every range of the oldest pull request when over capacity", async () => {
  const now = Date.now();
  const currentContext = viewerReviewContext(
    "github.com:octo/repo:pull:123",
  );
  const middleContext = viewerReviewContext("github.com:middle/repo:pull:2");
  const oldestContext = viewerReviewContext("github.com:oldest/repo:pull:1");
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const middleScope = Core.reviewStateScope(
    middleContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestScope = Core.reviewStateScope(
    oldestContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestSelectedScope = Core.reviewStateScope(
    oldestContext,
    "selected:abc..def",
  );
  const stateKeys = (scope, prefix, count) =>
    Array.from({ length: count }, (_, index) =>
      Core.lineStorageKey(
        scope,
        `src/${prefix}.js`,
        "addition",
        `+${prefix}-${index}`,
      ),
    );
  const currentKeys = stateKeys(currentScope, "current", 2);
  const middleKeys = stateKeys(middleScope, "middle", 2);
  const oldestKeys = stateKeys(oldestScope, "oldest", 3);
  const oldestSelectedKeys = stateKeys(
    oldestSelectedScope,
    "oldest-selected",
    1,
  );
  const initial = {};
  [
    [currentContext, currentKeys, now],
    [middleContext, middleKeys, now - 2 * 24 * 60 * 60 * 1000],
    [
      oldestContext,
      [...oldestKeys, ...oldestSelectedKeys],
      now - 3 * 24 * 60 * 60 * 1000,
    ],
  ].forEach(([context, keys, lastAccessedAt]) => {
    keys.forEach((key) => {
      initial[key] = { viewedAt: lastAccessedAt };
    });
    initial[Core.reviewContextMetadataKey(context)] = { lastAccessedAt };
  });

  const { app, chrome, dom } = await startExtension(
    duplicateHunkFixture(),
    initial,
  );
  try {
    await app.pruneStoredReviewState({
      currentContext,
      maxEntries: 8,
      now,
    });
    const stored = chrome.snapshot();
    assert.equal(oldestKeys.every((key) => !(key in stored)), true);
    assert.equal(
      oldestSelectedKeys.every((key) => !(key in stored)),
      true,
    );
    assert.equal(
      Core.reviewContextMetadataKey(oldestContext) in stored,
      false,
    );
    assert.equal(middleKeys.every((key) => key in stored), true);
    assert.equal(currentKeys.every((key) => key in stored), true);
    assert.equal(
      [...middleKeys, ...currentKeys].filter((key) => key in stored).length,
      4,
    );
    assert.equal(
      Object.keys(stored).filter(
        (key) =>
          Core.isReviewStorageKey(key) ||
          Core.isReviewContextMetadataKey(key),
      ).length,
      6,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("enforces the review storage limit after later writes", async () => {
  const now = Date.now();
  const currentContext = viewerReviewContext(
    "github.com:octo/repo:pull:123",
  );
  const middleContext = viewerReviewContext("github.com:middle/repo:pull:2");
  const oldestContext = viewerReviewContext("github.com:oldest/repo:pull:1");
  const currentScope = Core.reviewStateScope(
    currentContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const middleScope = Core.reviewStateScope(
    middleContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const oldestScope = Core.reviewStateScope(
    oldestContext,
    Core.ALL_COMMITS_REVIEW_VARIANT,
  );
  const stateKeys = (scope, prefix, count) =>
    Array.from({ length: count }, (_, index) =>
      Core.lineStorageKey(
        scope,
        `src/${prefix}.js`,
        "addition",
        `+${prefix}-${index}`,
      ),
    );
  const oldestKeys = stateKeys(oldestScope, "oldest", 3);
  const middleKeys = stateKeys(middleScope, "middle", 2);
  const currentKey = Core.lineStorageKey(
    currentScope,
    "src/current.js",
    "addition",
    "+current",
  );
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    app.reviewStorageEntryLimit = () => 8;
    const initial = {};
    [
      [oldestContext, oldestKeys, now - 3 * 24 * 60 * 60 * 1000],
      [middleContext, middleKeys, now - 2 * 24 * 60 * 60 * 1000],
    ].forEach(([context, keys, lastAccessedAt]) => {
      keys.forEach((key) => {
        initial[key] = { viewedAt: lastAccessedAt };
      });
      initial[Core.reviewContextMetadataKey(context)] = { lastAccessedAt };
    });
    await chrome.api.storage.local.set(initial);
    assert.equal(app.reviewStorageKeys.size, 7);

    await app.setReviewStorage(
      { [currentKey]: { viewedAt: now } },
      currentScope,
      now,
    );

    const stored = chrome.snapshot();
    assert.equal(oldestKeys.every((key) => !(key in stored)), true);
    assert.equal(
      Core.reviewContextMetadataKey(oldestContext) in stored,
      false,
    );
    assert.equal(middleKeys.every((key) => key in stored), true);
    assert.equal(currentKey in stored, true);
    assert.equal(
      Core.reviewContextMetadataKey(currentContext) in stored,
      true,
    );
    assert.equal(app.reviewStorageKeys.size <= 8, true);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("shrinks a dragged line range before persisting it", async () => {
  const { app, chrome, dom } = await startExtension(dragFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 1);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-cell").length,
        3,
      );
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    controller.lines.forEach((line, index) => {
      line.element.getClientRects = () => [
        { top: index * 20, bottom: index * 20 + 20 },
      ];
    });

    app.startLineDrag(controller.lines[0], true, 7);
    app.touchLineRange(controller.lines[2]);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, true],
    );

    app.touchLineRange(controller.lines[1]);
    assert.deepEqual(
      Array.from(controller.lines, (line) => line.marked),
      [true, true, false],
    );
    await app.finishLineDrag(true);

    assert.equal(
      Object.keys(chrome.snapshot()).filter((key) => key.includes(":line:"))
        .length,
      2,
    );
    assert.equal(controller.indeterminate, true);

    app.startLineDrag(controller.lines[2], true, 8);
    await app.finishLineDrag(true);
    assert.equal(controller.marked, true);
    assert.equal(controller.collapsed, true);
    assert.ok(chrome.snapshot()[controller.collapsedKey]);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("enables auto-collapse by default and persists its setting", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.ok(dom.window.document.getElementById("hunkmark-panel"));
    });
    const autoCollapse = dom.window.document.querySelector(
      'input[aria-label="Automatically collapse viewed hunks"]',
    );
    assert.equal(app.autoCollapseViewed, true);
    assert.equal(autoCollapse.checked, true);

    autoCollapse.checked = false;
    autoCollapse.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(app.autoCollapseViewed, false);
      assert.equal(autoCollapse.checked, false);
      assert.equal(
        chrome.snapshot()[app.autoCollapsePreferenceKey],
        false,
      );
    });

    const controller = Array.from(app.controllersByRow.values())[0];
    controller.lines[0].input.checked = true;
    controller.lines[0].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.marked, true);
      assert.equal(controller.collapsed, false);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("restores the UI when a storage write fails", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-control input")
          .length,
        2,
      );
    });
    const input = dom.window.document.querySelector(
      ".hunkmark-line-control input",
    );
    const controller = Array.from(app.controllersByRow.values())[0];
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    chrome.failNextSet();
    input.checked = true;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    await waitFor(() => {
      assert.equal(input.disabled, false);
      assert.equal(input.checked, false);
      assert.equal(controller.collapsed, false);
    });
    assert.equal(Object.keys(chrome.snapshot()).length, 0);
    assert.equal(warnings.length, 1);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("stops quietly when the extension context is invalidated", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);

    chrome.invalidateContext();
    replacePageBody(dom, commitSelectionFixture());

    await waitFor(() => {
      assert.equal(app.stopped, true);
      assert.equal(app.observer, null);
      assert.equal(app.navigationPollTimer, null);
      assert.equal(app.refreshTimer, null);
    });
    assert.equal(warnings.length, 0);
    assert.equal(
      dom.window.document.querySelectorAll(
        "[data-hunkmark-ui], .hunkmark-file-progress, #hunkmark-panel",
      ).length,
      0,
    );
    const notice = dom.window.document.getElementById(
      app.constants.RECONNECT_NOTICE_ID,
    );
    assert.ok(notice);
    assert.match(notice.textContent, /Reload this page/);
    assert.equal(notice.querySelector("button").textContent, "Reload");

    app.scheduleRefresh();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(app.refreshQueued, false);
    assert.equal(warnings.length, 0);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("stops quietly when collapse storage loses the extension context", async () => {
  const { app, chrome, dom } = await startExtension(duplicateHunkFixture());
  try {
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args);
    const controller = Array.from(app.controllersByRow.values())[0];

    await waitFor(() => {
      assert.equal(controller.collapseButton.disabled, false);
    });
    chrome.invalidateContext();
    controller.collapseButton.click();

    await waitFor(() => {
      assert.equal(app.stopped, true);
      assert.equal(app.observer, null);
      assert.equal(app.navigationPollTimer, null);
    });
    assert.equal(warnings.length, 0);
    assert.equal(Object.keys(chrome.snapshot()).length, 0);
    assert.equal(
      dom.window.document.querySelectorAll(
        "[data-hunkmark-ui], .hunkmark-file-progress, #hunkmark-panel",
      ).length,
      0,
    );
    const notice = dom.window.document.getElementById(
      app.constants.RECONNECT_NOTICE_ID,
    );
    assert.ok(notice);
    assert.equal(notice.querySelector("button").textContent, "Reload");
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-collapsed").length,
      0,
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("activates after GitHub client-side navigation into Files changed", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(app.currentScope, null);
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      0,
    );

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/files");
    const fixtureDom = new JSDOM(duplicateHunkFixture());
    const fixture = fixtureDom.window.document.querySelector(".js-file");
    dom.window.document.body.replaceChildren(
      dom.window.document.importNode(fixture, true),
    );
    fixtureDom.window.close();
    dom.window.document.dispatchEvent(new dom.window.Event("turbo:load"));

    await waitFor(() => {
      assert.ok(app.currentScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("activates when the diff DOM arrives before the SPA URL change", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    replacePageBody(dom, duplicateHunkFixture());
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      0,
    );

    dom.window.history.pushState({}, "", "/octo/repo/pull/123/changes");

    await waitFor(() => {
      assert.ok(app.currentScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("retries SPA activation when the GitHub viewer identity arrives late", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      viewerLogin: null,
      waitForScope: false,
    },
  );
  try {
    dom.window.history.pushState({}, "", "/octo/repo/pull/123/changes");
    replacePageBody(dom, duplicateHunkFixture());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(app.currentScope, null);
    assert.equal(
      dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
      0,
    );

    const viewerMeta = dom.window.document.createElement("meta");
    viewerMeta.name = "user-login";
    viewerMeta.content = DEFAULT_VIEWER_LOGIN;
    dom.window.document.head.append(viewerMeta);

    await waitFor(() => {
      assert.ok(app.currentScope);
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        2,
      );
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("does not inspect DOM mutations while outside a pull request diff", async () => {
  const { app, dom } = await startExtension(
    "<!doctype html><html><body><main>Repository home</main></body></html>",
    {},
    {
      url: "https://github.com/octo/repo",
      waitForScope: false,
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(app.currentScope, null);
    let diffChecks = 0;
    const originalMutationAffectsDiff = app.mutationAffectsDiff.bind(app);
    app.mutationAffectsDiff = (mutation) => {
      diffChecks += 1;
      return originalMutationAffectsDiff(mutation);
    };

    const unrelated = dom.window.document.createElement("div");
    unrelated.textContent = "dynamic repository notification";
    dom.window.document.body.append(unrelated);
    await new Promise((resolve) => setTimeout(resolve, 180));

    assert.equal(diffChecks, 0);
    assert.equal(app.currentScope, null);
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("supports GitHub's current React diff with persistent controls visible", async () => {
  const { app, dom } = await startExtension(modernGridFixture());
  try {
    await waitFor(() => {
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-hunk-actions").length,
        1,
      );
      assert.equal(
        dom.window.document.querySelectorAll(".hunkmark-line-control").length,
        2,
      );
    });
    const controller = Array.from(app.controllersByRow.values())[0];
    assert.equal(controller.filePath, "src/modern.ts");
    assert.deepEqual(
      Array.from(controller.lines, (line) => [line.kind, line.side]),
      [
        ["deletion", "left"],
        ["addition", "right"],
      ],
    );
    const pathSection = dom.window.document.querySelector(
      '[class*="file-path-section"]',
    );
    const progress = pathSection.nextElementSibling;
    assert.equal(progress.className, "hunkmark-file-progress");
    assert.match(progress.textContent, /Hunks 0\/1 · Lines 0\/2/);

    const style = dom.window.document.createElement("style");
    style.textContent = fs.readFileSync(path.join(root, "content.css"), "utf8");
    dom.window.document.head.append(style);
    const lineHoverRule = Array.from(style.sheet.cssRules).find(
      (rule) => rule.selectorText === ".hunkmark-line-control:hover",
    );
    assert.match(lineHoverRule.style.background, /linear-gradient/);
    assert.match(lineHoverRule.style.background, /--bgColor-default/);
    assert.equal(
      dom.window.getComputedStyle(controller.actions).visibility,
      "visible",
    );
    assert.equal(dom.window.getComputedStyle(controller.actions).opacity, "1");
    assert.equal(dom.window.getComputedStyle(progress).visibility, "visible");
    assert.equal(dom.window.getComputedStyle(progress).opacity, "1");
    assert.equal(
      dom.window.getComputedStyle(controller.hunkCell).paddingRight,
      "16px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].element).paddingRight,
      "24px",
    );
    assert.equal(
      controller.lines[0].element.style.getPropertyValue(
        "--hunkmark-host-line-action-inset",
      ),
      "24px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].label).right,
      "calc(4px + var(--hunkmark-host-line-action-inset, 0px))",
    );
    assert.equal(
      controller.lines[1].element.style.getPropertyValue(
        "--hunkmark-first-line-center",
      ),
      "12px",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[1].label).top,
      "var(--hunkmark-first-line-center, 12px)",
    );
    const reviewButton = dom.window.document.querySelector(
      'button[aria-label="Add a line comment"]',
    );
    const highlightedCode = controller.lines[1].element.querySelector(
      "code > span",
    );
    assert.equal(
      dom.window.getComputedStyle(reviewButton).backgroundColor,
      "rgb(31, 111, 235)",
    );
    controller.lines[1].input.checked = true;
    controller.lines[1].input.dispatchEvent(
      new dom.window.Event("change", { bubbles: true }),
    );
    await waitFor(() => {
      assert.equal(controller.lines[1].marked, true);
    });
    assert.equal(
      dom.window.getComputedStyle(reviewButton).backgroundColor,
      "rgb(31, 111, 235)",
    );
    assert.equal(
      dom.window.getComputedStyle(highlightedCode).backgroundColor,
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      dom.window.getComputedStyle(controller.lines[0].label).opacity,
      "0",
    );
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("ignores DOM mutations unrelated to a diff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    let refreshCalls = 0;
    const originalRefresh = app.refresh.bind(app);
    app.refresh = async () => {
      refreshCalls += 1;
      return originalRefresh();
    };

    const unrelated = dom.window.document.createElement("div");
    unrelated.textContent = "unrelated notification";
    dom.window.document.body.append(unrelated);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(refreshCalls, 0);

    const changedLine = dom.window.document.querySelector(
      "td.blob-code-addition",
    );
    changedLine.prepend("updated ");
    await waitFor(() => {
      assert.equal(refreshCalls, 1);
    });
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("adds only the missing clearance below the final diff", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    panel.style.bottom = "18px";
    panel.getBoundingClientRect = () => ({ height: 40 });
    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.groupRows.forEach((row) => {
        row.getClientRects = () => [{ bottom: 400 }];
        row.getBoundingClientRect = () => ({ bottom: 400 });
      });
    });
    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    spacer.style.height = "0px";

    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "0px");

    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 420,
    });
    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "46px");
  } finally {
    app.stop();
    dom.window.close();
  }
});

test("keeps the panel clear of a collapsed file below the final hunk", async () => {
  const { app, dom } = await startExtension(duplicateHunkFixture());
  try {
    await waitFor(() => {
      assert.equal(app.controllersByRow.size, 2);
    });
    const panel = dom.window.document.getElementById("hunkmark-panel");
    const spacer = dom.window.document.getElementById("hunkmark-panel-spacer");
    panel.style.bottom = "18px";
    panel.getBoundingClientRect = () => ({ height: 40 });
    Array.from(app.controllersByRow.values()).forEach((controller) => {
      controller.groupRows.forEach((row) => {
        row.getClientRects = () => [{ bottom: 400 }];
        row.getBoundingClientRect = () => ({ bottom: 400 });
      });
    });

    const collapsedFile = dom.window.document.createElement("section");
    collapsedFile.className = "js-file";
    collapsedFile.dataset.filePath = "src/collapsed.js";
    collapsedFile.textContent = "src/collapsed.js";
    collapsedFile.getClientRects = () => [{ bottom: 470 }];
    collapsedFile.getBoundingClientRect = () => ({ bottom: 470 });
    dom.window.document.body.insertBefore(collapsedFile, panel);
    Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    spacer.style.height = "0px";

    app.updatePanelClearance(panel, spacer);
    assert.equal(spacer.style.height, "44px");
  } finally {
    app.stop();
    dom.window.close();
  }
});
