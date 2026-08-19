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
  const TIMELINE_CLASSES = classNames("compressing", "phase-a", "phase-b");
  const TIMELINE_STYLES = styleNames(
    "compress-start", "compress-end", "tail-start", "tail-end",
    "auxiliary-start", "auxiliary-end",
  );
  const PUSH_CLASSES = classNames("pushing", "push-phase-a", "push-phase-b");
  const PUSH_STYLES = styleNames("push-distance", "push-start", "push-end");
  const CONTENT_STYLES = styleNames("content-inset", "bottom-inset");
  const ROW_CLASSES = classNames(
    "active", "candidate", "past", "row", "compressing", "phase-a",
    "phase-b", "pushing", "push-phase-a", "push-phase-b",
  );

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

  function setAnimationPhase(element, activeClass, phasePrefix, phase) {
    element.classList.add(activeClass);
    element.classList.toggle(`${phasePrefix}-a`, phase === "a");
    element.classList.toggle(`${phasePrefix}-b`, phase === "b");
  }

  function setPixelStyle(element, property, value, removeZero = false) {
    if (removeZero && value === 0) {
      element.style.removeProperty(property);
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
    PUSH_CLASSES,
    PUSH_STYLES,
    ROW_CLASSES,
    ROW_STYLES: Object.freeze([
      ...CONTENT_STYLES,
      ...TIMELINE_STYLES,
      ...PUSH_STYLES,
    ]),
    TIMELINE_CLASSES,
    TIMELINE_STYLES,
    clearClasses,
    clearStyles,
    firstPositiveNumber,
    setAnimationPhase,
    setPixelStyle,
    setPixelStyles,
  });
})(globalThis);
