const {
  test,
  assert,
  JSDOM,
  startExtension,
  layoutReviewFixture,
  modernGridFixture,
} = require("./content-test-support.cjs");

const diffCellSelector = [
  ".blob-code-context",
  ".blob-code-addition",
  ".blob-code-deletion",
  ".diff-text-cell",
].join(", ");

function selectedDiffText(document) {
  const cells = Array.from(document.querySelectorAll(diffCellSelector));
  const range = document.createRange();
  const lines = cells.map((cell) => {
    range.selectNodeContents(cell);
    return range.cloneContents().textContent;
  });
  range.setStart(cells[0], 0);
  range.setEnd(cells.at(-1), cells.at(-1).childNodes.length);
  return { lines, multipleRows: range.cloneContents().textContent };
}

const fixtures = [
  ...["unified", "split"].map((layout) => ({
    name: `legacy ${layout}`,
    html: layoutReviewFixture({
      layout,
      additions: ["Viewed", "", "newValue"],
      deletions: ["oldViewed", "oldValue"],
    }),
  })),
  {
    name: "React with highlighted and wrapped code",
    html: modernGridFixture().replace("+import", "+Viewed"),
  },
];

for (const { name, html } of fixtures) {
  test(`keeps ${name} diff selections free of control text`, async () => {
    const original = new JSDOM(html);
    const expected = selectedDiffText(original.window.document);
    original.window.close();
    const { app, dom } = await startExtension(html);
    try {
      assert.ok(app.controllersByRow.size > 0);
      assert.ok(dom.window.document.querySelector(".hunkmark-line-control"));
      assert.deepEqual(selectedDiffText(dom.window.document), expected);

      // Reviewed checkmarks and rematerialized controls must also leave the
      // source text intact, including real occurrences of "Viewed" and blanks.
      const controller = Array.from(app.controllersByRow.values())[0];
      const line = controller.lines[0];
      await app.setLineViewed(line, true);
      line.control.remove();
      app.materializeLineControl(line, app.measureLineHostLayout(line));
      assert.equal(line.control.getAttribute("aria-pressed"), "true");
      assert.deepEqual(selectedDiffText(dom.window.document), expected);
    } finally {
      app.stop();
      dom.window.close();
    }
  });
}
