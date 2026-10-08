(function attachHunkMarkStickyHunkClip(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  if (!App || !namespace.stickyHunk) return;

  const hostClasses = (value) => (value ?? "").split(/\s+/)
    .filter((name) => name && !name.startsWith("hunkmark-")).join(" ");
  const hostStyles = (style) => Array.from(style)
    .filter((property) => !property.startsWith("--hunkmark-"))
    .map((property) => `${property}:${style.getPropertyValue(property)}:${style.getPropertyPriority(property)}`)
    .join(";");
  Object.assign(App.prototype, {
    unobserveStickyHunkContent(controller) {
      controller.stickyHunkContentObserver?.disconnect();
      controller.stickyHunkContentObserver = null;
    },

    observeStickyHunkContent(controller) {
      if (controller.stickyHunkContentObserver) return;
      const observer = new this.window.MutationObserver((mutations) => {
        if (this.stopped || controller.stickyHunkContentObserver !== observer ||
            !controller.hunkRow.isConnected) return;
        const state = this.hunkStickyStateByFile.get(controller.fileElement);
        const preparationLost = state?.preparedControllers.has(controller) &&
          (!controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared") ||
            !controller.hunkRow.classList.contains("hunkmark-sticky-hunk-row") ||
            !controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-scroll-extent") ||
            !controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-auxiliary-start") ||
            !controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-push-end"));
        let previousStyle;
        const contentChanged = mutations.some((mutation) => {
          if (this.mutationIsExtensionOnly(mutation)) return false;
          if (mutation.type !== "attributes") return true;
          const current = mutation.target.getAttribute(mutation.attributeName);
          if (mutation.oldValue === current) return false;
          if (mutation.attributeName === "class") {
            return hostClasses(mutation.oldValue) !== hostClasses(current);
          }
          if (mutation.attributeName === "style") {
            previousStyle ??= this.document.createElement("span").style;
            previousStyle.cssText = mutation.oldValue ?? "";
            return hostStyles(previousStyle) !== hostStyles(mutation.target.style);
          }
          return true;
        });
        if (contentChanged) {
          state?.contentLayoutDirtyControllers.add(controller);
        }
        if (contentChanged || preparationLost) {
          this.scheduleStickyHunkLayout();
        }
      });
      controller.stickyHunkContentObserver = observer;
      observer.observe(controller.hunkRow, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        subtree: true,
      });
    },
  });
})(globalThis);
