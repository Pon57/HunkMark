(function defineHunkMarkStickyHunkBase(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  if (!namespace?.App) {
    return;
  }

  const classNames = (...suffixes) => Object.freeze(
    suffixes.map((suffix) => `hunkmark-sticky-hunk-${suffix}`),
  );
  const styleNames = (...suffixes) => Object.freeze(
    suffixes.map((suffix) => `--hunkmark-sticky-hunk-${suffix}`),
  );
  const TIMELINE_STYLES = styleNames(
    "auxiliary-start", "auxiliary-end", "push-distance", "push-start", "push-end",
    "tail-compensation",
    "return-end",
  );
  const CONTENT_STYLES = styleNames("content-inset", "bottom-inset", "compact-height", "actions-top", "focus-height");
  const ROW_CLASSES = classNames("active", "row", "prepared", "tail-constrained", "compact-return");

  function clearClasses(element, classes) {
    element?.classList.remove(...classes);
  }

  function clearStyles(element, properties) {
    properties.forEach((property) => element?.style.removeProperty(property));
  }

  function firstPositiveNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) {
        return number;
      }
    }
    return 0;
  }

  function setPixelStyle(element, property, value, removeZero = false) {
    if (removeZero && value === 0) {
      if (element.style.getPropertyValue(property) !== "") {
        element.style.removeProperty(property);
      }
      return;
    }
    const nextValue = `${Math.round(value * 100) / 100}px`;
    if (element.style.getPropertyValue(property) !== nextValue) {
      element.style.setProperty(property, nextValue);
    }
  }

  function setPixelStyles(element, entries) {
    entries.forEach(([property, value]) =>
      setPixelStyle(element, property, value),
    );
  }

  namespace.stickyHunk = Object.freeze({
    AUXILIARY_FADE_DISTANCE_PX: 12,
    AUXILIARY_SELECTOR: [
      ".hunk-kebab-icon",
      namespace.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
    ].join(", "),
    ROW_CLASSES,
    ROW_STYLES: Object.freeze([
      "--hunkmark-sticky-scroll-extent",
      ...CONTENT_STYLES,
      ...TIMELINE_STYLES,
    ]),
    TIMELINE_STYLES,
    clearClasses,
    clearStyles,
    firstPositiveNumber,
    setPixelStyle,
    setPixelStyles,
  });
})(globalThis);
