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
  const pixels = (value) => `${Math.round(value * 100) / 100}px`;
  const cancelClipAnimations = (controller) => {
    controller.stickyHunkClipState?.animations.forEach((animation) => animation.cancel());
    controller.stickyHunkClipState = null;
  };

  Object.assign(App.prototype, {
    clearStickyHunkClipAnimation(controller) {
      cancelClipAnimations(controller);
      controller.stickyHunkClipContentObserver?.disconnect();
      controller.stickyHunkClipContentObserver = null;
    },

    observeStickyHunkClipContent(controller) {
      if (controller.stickyHunkClipContentObserver) return;
      const observer = new this.window.MutationObserver((mutations) => {
        if (this.stopped || controller.stickyHunkClipContentObserver !== observer ||
            !controller.hunkRow.isConnected) return;
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
          this.hunkStickyStateByFile.get(controller.fileElement)
            ?.contentLayoutDirtyControllers.add(controller);
          this.scheduleStickyHunkLayout();
        }
      });
      controller.stickyHunkClipContentObserver = observer;
      observer.observe(controller.hunkRow, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        subtree: true,
      });
    },

    syncStickyHunkClipAnimation(controller, naturalTop, stickyTop) {
      const row = controller.hunkRow;
      if (!row.isConnected) {
        this.clearStickyHunkClipAnimation(controller);
        return;
      }
      this.observeStickyHunkClipContent(controller);
      const inset = Math.max(0, controller.stickyHunkContentInset ?? 0);
      const bottomInset = Math.max(0, controller.stickyHunkBottomInset ?? 0);
      const distance = inset + bottomInset;
      const targets = [row, ...Array.from(row.children).filter((element) =>
        element.tagName === "TD" || element.tagName === "TH",
      )];
      if (distance === 0 || !Number.isFinite(naturalTop) || !Number.isFinite(stickyTop) ||
          typeof this.window.ScrollTimeline !== "function" ||
          targets.some((target) => typeof target.animate !== "function")) {
        cancelClipAnimations(controller);
        return;
      }
      this.hunkStickyClipTimeline ??= new this.window.ScrollTimeline({
        source: this.document.scrollingElement ?? this.document.documentElement,
        axis: "block",
      });
      const rangeStart = pixels(naturalTop - stickyTop);
      const rangeEnd = pixels(naturalTop - stickyTop + distance);
      const state = controller.stickyHunkClipState ?? { animations: new Map() };
      const framesChanged = state.inset !== inset || state.bottomInset !== bottomInset;
      const keyframes = framesChanged || targets.some((target) => !state.animations.has(target))
        ? [
            { clipPath: "inset(0px 0px 0px 0px)", offset: 0 },
            { clipPath: `inset(${pixels(inset)} 0px 0px 0px)`, offset: inset / distance },
            { clipPath: `inset(${pixels(inset)} 0px ${pixels(bottomInset)} 0px)`, offset: 1 },
          ]
        : null;
      state.animations.forEach((animation, target) => {
        if (!targets.includes(target)) {
          animation.cancel();
          state.animations.delete(target);
        }
      });
      targets.forEach((target) => {
        const animation = state.animations.get(target);
        if (!animation) {
          state.animations.set(target, target.animate(keyframes, {
            timeline: this.hunkStickyClipTimeline,
            duration: "auto",
            fill: "both",
            easing: "linear",
            rangeStart,
            rangeEnd,
          }));
          return;
        }
        if (framesChanged) animation.effect.setKeyframes(keyframes);
        if (state.rangeStart !== rangeStart) animation.rangeStart = rangeStart;
        if (state.rangeEnd !== rangeEnd) animation.rangeEnd = rangeEnd;
      });
      Object.assign(state, { inset, bottomInset, rangeStart, rangeEnd });
      controller.stickyHunkClipState = state;
    },
  });
})(globalThis);
