const {
  test,
  assert,
  JSDOM,
  installContentStyles,
} = require("./content-test-support.cjs");

test("anchors only unambiguous native file-toggle tooltips, including Viewed files", () => {
  const pair = (id, attributes = 'data-component="Tooltip" popover="auto"') =>
    `<button data-component="IconButton" aria-labelledby="${id}"></button>` +
    `<span id="${id}" class="native-tooltip" ${attributes}>Expand file</span>`;
  const dom = new JSDOM(`<!doctype html><html><head><style>
    .native-tooltip { position: absolute; }
  </style></head><body>
    <div class="DiffFileHeader-module__diff-file-header__example">
      <div>${pair("expanded")}</div>
    </div>
    <div class="DiffFileHeader-module__diff-file-header__example">
      <div>${pair("viewed")}</div>
      <button aria-label="Viewed" aria-pressed="true"></button>
    </div>
    <div class="DiffFileHeader-module__diff-file-header__example">
      <div>${pair("multiple-first")}${pair("multiple-last")}</div>
      <div><div>${pair("nested")}</div></div>
      <div>${pair("menu", 'data-component="Menu" popover="auto"')}</div>
      <div>${pair("non-popover", 'data-component="Tooltip"')}</div>
    </div>
    <div>${pair("outside-diff")}</div>
  </body></html>`);
  try {
    installContentStyles(dom);
    for (const id of ["expanded", "viewed"]) {
      assert.equal(
        dom.window.getComputedStyle(dom.window.document.getElementById(id)).position,
        "fixed",
        `${id} must not extend the document's scroll range`,
      );
    }
    for (const id of [
      "multiple-first", "multiple-last", "nested", "menu", "non-popover", "outside-diff",
    ]) {
      assert.equal(
        dom.window.getComputedStyle(dom.window.document.getElementById(id)).position,
        "absolute",
        `${id} must retain its native positioning`,
      );
    }
  } finally {
    dom.window.close();
  }
});
