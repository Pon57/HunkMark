"use strict";

const assert = require("node:assert/strict");

function validateProjectReleaseVersion(version) {
  // VERSION is shared with npm metadata, so this project uses three parts
  // within Chrome's supported one-to-four-part version format.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  assert.ok(
    match,
    `VERSION must be a three-part project release version, received ${JSON.stringify(version)}`,
  );

  const components = match.slice(1).map(Number);
  for (const component of components) {
    assert.ok(
      component <= 65535,
      `VERSION component ${component} exceeds Chrome's limit of 65535`,
    );
  }
  assert.ok(
    components.some((component) => component !== 0),
    "VERSION must contain at least one non-zero component",
  );
}

module.exports = { validateProjectReleaseVersion };
