(function attachHunkMarkStickyHunkNavigation(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  if (!App || !namespace.stickyHunk) {
    return;
  }

  Object.assign(App.prototype, {
    stickyHunkOriginFocusTarget(controller) {
      const activeElement = this.document.activeElement;
      if (
        !(activeElement instanceof this.window.HTMLElement) ||
        !(controller.groupRows ?? [controller.hunkRow]).some((row) =>
          row.contains(activeElement),
        )
      ) {
        return null;
      }
      return activeElement === controller.collapseButton
        ? "collapse"
        : "input";
    },

    focusStickyHunkOrigin(controller, preferredTarget = "input") {
      const candidates =
        preferredTarget === "collapse"
          ? [controller.collapseButton, controller.input]
          : [controller.input, controller.collapseButton];
      const target = candidates.find(
        (control) =>
          control instanceof this.window.HTMLElement &&
          control.isConnected &&
          !control.disabled,
      );
      if (!target) {
        return false;
      }
      target.focus({ preventScroll: true });
      return this.document.activeElement === target;
    },

    scrollStickyHunkToOrigin(controller) {
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      const naturalTop = this.stickyHunkNaturalDocumentTop(controller, {
        refreshLayout: false,
      });
      // Land just before sticky activation. Wrapped rows begin fading at this
      // boundary; compact rows do not begin fading until after it.
      this.window.scrollTo({
        behavior: this.window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        )?.matches
          ? "auto"
          : "smooth",
        top: Math.max(0, naturalTop - (state?.stickyTop ?? 0) - 1),
      });
    },

    stickyHunkScrollPosition() {
      return {
        left: Number(this.window.scrollX) || 0,
        top: Number(this.window.scrollY) || 0,
      };
    },

    stickyHunkScrollPositionMatches(expected) {
      if (!expected) {
        return true;
      }
      const current = this.stickyHunkScrollPosition();
      return (
        Math.abs(current.left - expected.left) <= 0.5 &&
        Math.abs(current.top - expected.top) <= 0.5
      );
    },

    handleStickyHunkClick(controller, event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        !controller.hunkRow.classList.contains(
          "hunkmark-sticky-hunk-active",
        )
      ) {
        return;
      }
      const target =
        event.target instanceof this.window.Element ? event.target : null;
      const selection = this.window.getSelection();
      if (
        target?.closest(
          [
            "a",
            "button",
            "input",
            "label",
            "select",
            "textarea",
            '[role="button"]',
            '[contenteditable="true"]',
            "[data-hunkmark-ui]",
          ].join(", "),
        ) ||
        (selection && !selection.isCollapsed)
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const activeElement = this.document.activeElement;
      if (
        activeElement instanceof this.window.HTMLElement &&
        controller.hunkRow.contains(activeElement)
      ) {
        activeElement.blur();
      }
      this.scrollStickyHunkToOrigin(controller);
    },

    reviewControllerForKey(targetKey) {
      for (const controller of this.controllersByRow.values()) {
        if (
          controller.key === targetKey &&
          this.reviewControllerIsCurrent(controller)
        ) {
          return controller;
        }
      }
      return null;
    },

    cancelStickyHunkReturn() {
      this.hunkStickyNavigationGeneration += 1;
      if (this.hunkStickyScrollFrameId !== null) {
        this.window.cancelAnimationFrame(this.hunkStickyScrollFrameId);
        this.hunkStickyScrollFrameId = null;
      }
    },

    scheduleStickyHunkReturn(
      targetKey,
      {
        expectedScrollPosition = null,
        focusTarget = null,
        navigationGeneration = this.hunkStickyNavigationGeneration,
      } = {},
    ) {
      const returnIsCurrent = () =>
        navigationGeneration === this.hunkStickyNavigationGeneration &&
        this.stickyHunkScrollPositionMatches(expectedScrollPosition);
      if (!returnIsCurrent()) {
        return;
      }
      if (this.hunkStickyScrollFrameId !== null) {
        this.window.cancelAnimationFrame(this.hunkStickyScrollFrameId);
      }
      this.hunkStickyScrollFrameId = this.window.requestAnimationFrame(() => {
        if (!returnIsCurrent()) {
          this.hunkStickyScrollFrameId = null;
          return;
        }
        this.hunkStickyScrollFrameId = this.window.requestAnimationFrame(
          () => {
            this.hunkStickyScrollFrameId = null;
            if (!returnIsCurrent()) {
              return;
            }
            const target = this.reviewControllerForKey(targetKey);
            if (target) {
              if (focusTarget) {
                this.focusStickyHunkOrigin(target, focusTarget);
              }
              this.scrollStickyHunkToOrigin(target);
            }
          },
        );
      });
    },
  });
})(globalThis);
