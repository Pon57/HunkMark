(function attachHunkMarkStickyHunkNavigation(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  if (!App || !namespace.stickyHunk) {
    return;
  }

  Object.assign(App.prototype, {
    reserveStickyHunkScrollRange(controller, top = this.window.scrollY) {
      let boundary = this.hunkStickyScrollBoundary;
      if (!boundary) {
        boundary = this.document.createElement("div");
        boundary.className = "hunkmark-sticky-scroll-boundary";
        boundary.setAttribute("data-hunkmark-ui", "true");
        boundary.setAttribute("aria-hidden", "true");
        this.hunkStickyScrollBoundary = boundary;
        this.boundStickyHunkScrollEnd = () => this.settleStickyHunkScrollRange();
        this.window.addEventListener("scrollend", this.boundStickyHunkScrollEnd);
      }
      const previous = this.hunkStickyScrollBoundaryTarget !== null
        ? {
            key: this.hunkStickyScrollBoundaryKey,
            target: this.hunkStickyScrollBoundaryTarget,
            top: Number.parseFloat(boundary.style.top) || 0,
          }
        : this.hunkStickyScrollReservation?.previous ?? null;
      this.hunkStickyScrollBoundaryKey = controller.key;
      this.hunkStickyScrollBoundaryTarget = null;
      this.hunkStickyScrollReservation = { previous };
      boundary.style.top = `${Math.max(Math.ceil(Math.max(0, Number(top) || 0)), Number.parseFloat(boundary.style.top) || 0)}px`;
      if (!boundary.isConnected) {
        // An absolute overflow point reserves scroll range without inserting
        // space into a diff table or moving the host's content.
        this.document.documentElement.append(boundary);
      }
      this.syncStickyHunkScrollExtent();
      return this.hunkStickyScrollReservation;
    },

    settleStickyHunkScrollRange() {
      const boundary = this.hunkStickyScrollBoundary;
      if (!boundary || this.hunkStickyScrollBoundaryTarget === null) {
        return;
      }
      const top = Number(this.window.scrollY) || 0;
      const viewportHeight = this.window.innerHeight;
      // offsetHeight excludes this absolute overflow point. Remove it once
      // ordinary content can support the user's current scroll position.
      if (top + viewportHeight <= this.document.documentElement.offsetHeight) {
        this.clearStickyHunkScrollRange();
      } else if (Number.isFinite(this.hunkStickyScrollBoundaryTarget)) {
        boundary.style.top = `${Math.ceil(Math.max(top, this.hunkStickyScrollBoundaryTarget))}px`;
        this.syncStickyHunkScrollExtent();
      }
    },

    clearStickyHunkScrollRange(controller = null) {
      if (controller) {
        if (this.hunkStickyScrollReservation?.previous?.key === controller.key) {
          this.hunkStickyScrollReservation.previous = null;
        }
        if (controller.key !== this.hunkStickyScrollBoundaryKey) return;
        if (this.hunkStickyScrollBoundaryTarget === null &&
            this.hunkStickyScrollReservation?.previous) {
          this.clearPendingStickyHunkScrollRange();
          return;
        }
      }
      this.hunkStickyScrollBoundary?.remove();
      if (!this.stopped) this.syncStickyHunkScrollExtent();
      this.hunkStickyScrollBoundary = null;
      this.hunkStickyScrollBoundaryKey = null;
      this.hunkStickyScrollBoundaryTarget = null;
      this.hunkStickyScrollReservation = null;
      this.hunkStickyPointerScrollReservation = null;
      this.window.removeEventListener("scrollend", this.boundStickyHunkScrollEnd);
      this.boundStickyHunkScrollEnd = null;
    },

    pruneStickyHunkScrollRange() {
      if (this.hunkStickyScrollBoundary &&
        !this.reviewControllerForKey(this.hunkStickyScrollBoundaryKey)) {
        if (this.hunkStickyScrollBoundaryTarget === null) {
          this.clearPendingStickyHunkScrollRange();
        } else {
          this.clearStickyHunkScrollRange();
        }
      }
    },

    revealFocusedStickyHunk(controller, target) {
      const row = controller.hunkRow;
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (
        !state ||
        controller.suppressStickyHunkFocusReveal ||
        !(target instanceof this.window.Element) ||
        !target.matches(":focus-visible") ||
        !row.classList.contains("hunkmark-sticky-hunk-prepared")
      ) {
        return;
      }
      // Pointer focus precedes click; moving the row then can lose the click.
      // Reveal obscured keyboard focus, whose sticky box may remain onscreen.
      if (target.getBoundingClientRect().top < state.stickyTop) {
        this.window.scrollTo({
          behavior: "instant",
          top: Math.max(
            0,
            this.stickyHunkNaturalDocumentTop(controller) - state.stickyTop - 1,
          ),
        });
      }
    },

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
      return this.focusStickyHunkWithoutReveal(controller, target);
    },

    focusStickyHunkWithoutReveal(controller, target) {
      // Callers own scrolling; do not let focusin start another one.
      const previousSuppression = controller.suppressStickyHunkFocusReveal;
      const returnFocus = target === controller.returnButton;
      controller.suppressStickyHunkFocusReveal = true;
      try {
        // A newly prepared Return can still be hidden until its scroll animation
        // samples. Make it focusable synchronously for this handoff only.
        if (returnFocus) target.classList.add("hunkmark-sticky-return-focusing");
        target.focus({ preventScroll: true });
      } finally {
        if (returnFocus) target.classList.remove("hunkmark-sticky-return-focusing");
        controller.suppressStickyHunkFocusReveal = previousSuppression;
      }
      return this.document.activeElement === target;
    },

    setStickyHunkReturnMode(controller, preserveStickySize) {
      const row = controller.hunkRow;
      const className = "hunkmark-sticky-hunk-compact-return";
      if (row.classList.contains(className) !== preserveStickySize) {
        row.classList.toggle(className, preserveStickySize);
      }
    },

    prepareStickyHunkReturn(controller, reservation) {
      if (!controller || !reservation) return null;
      // Collapse and align in one task, before persistence can yield a paint.
      this.scrollStickyHunkToOrigin(controller, {
        preserveStickySize: true,
        behavior: "instant",
        reservation,
      });
      this.updateStickyHunkInteractionsForControllers([controller], {
        allowPendingPersistence: true,
      });
      return this.stickyHunkScrollPosition();
    },

    scrollStickyHunkToOrigin(controller, {
      preserveStickySize = false,
      behavior = null,
      reservation = null,
    } = {}) {
      if (reservation && this.hunkStickyScrollReservation !== reservation) return;
      this.setStickyHunkReturnMode(controller, preserveStickySize);
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      const naturalTop = this.stickyHunkNaturalDocumentTop(controller, {
        refreshLayout: false,
      });
      const bottomInset = Math.max(0, controller.stickyHunkBottomInset ?? 0);
      // Collapsing keeps the compact header, including its visible keyboard focus.
      // Only explicit origin navigation restores the full natural row.
      const offset = preserveStickySize
        ? Math.max(0, controller.stickyHunkContentInset ?? 0) + bottomInset
        : -1;
      const top = Math.max(0, naturalTop - (state?.stickyTop ?? 0) + offset);
      if (reservation) {
        this.hunkStickyScrollBoundary.style.top = `${Math.ceil(Math.max(top, this.window.scrollY))}px`;
        this.syncStickyHunkScrollExtent();
        // The visual return has already happened. Cancelling a pending save
        // must retain the range supporting that position, just as for a
        // completed return. Expansion still removes its reservation.
        reservation.previous = { key: controller.key, target: top, top };
        reservation.prepaintTarget = top;
      } else {
        this.reserveStickyHunkScrollRange(controller, Math.max(top, this.window.scrollY));
        this.hunkStickyScrollBoundaryTarget = top;
      }
      behavior ??= this.window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      )?.matches ? "auto" : "smooth";
      if (Math.abs((Number(this.window.scrollY) || 0) - top) > 0.5) {
        this.window.scrollTo({ behavior, top });
      }
      // No-op scrolls need cleanup too: they may never emit scrollend.
      if (!reservation && Math.abs((Number(this.window.scrollY) || 0) - top) <= 0.5) {
        this.settleStickyHunkScrollRange();
      }
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
            '[contenteditable]:not([contenteditable="false" i])',
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

    clearPendingStickyHunkScrollRange(
      targetKey = this.hunkStickyScrollBoundaryKey,
      navigationGeneration = this.hunkStickyNavigationGeneration,
    ) {
      if (this.hunkStickyScrollBoundary &&
          this.hunkStickyScrollBoundaryTarget === null &&
          targetKey === this.hunkStickyScrollBoundaryKey &&
          navigationGeneration === this.hunkStickyNavigationGeneration) {
        const previous = this.hunkStickyScrollReservation?.previous;
        if (previous && this.reviewControllerForKey(previous.key)) {
          // A provisional operation must not discard the range supporting a
          // completed return. Restore it without reviving old async owners.
          const currentTop = Number(this.window.scrollY) || 0;
          this.hunkStickyScrollBoundaryKey = previous.key;
          this.hunkStickyScrollBoundaryTarget = previous.target;
          this.hunkStickyScrollReservation = {};
          this.hunkStickyPointerScrollReservation = null;
          this.hunkStickyScrollBoundary.style.top = `${Math.max(currentTop, previous.top)}px`;
          this.settleStickyHunkScrollRange();
        } else {
          this.clearStickyHunkScrollRange();
        }
      }
    },

    releaseStickyHunkScrollReservation(reservation) {
      if (reservation && this.hunkStickyScrollReservation === reservation &&
          this.hunkStickyPointerScrollReservation !== reservation) {
        this.clearPendingStickyHunkScrollRange();
      }
    },

    deferPendingStickyHunkScrollRangeCleanup(reservation = this.hunkStickyScrollReservation) {
      if (!reservation || this.hunkStickyScrollBoundaryTarget !== null) return;
      // Finish the pointer activation before shrinking the scroll range. A
      // newer reservation may reuse the same boundary and hunk key.
      this.window.setTimeout(() => {
        if (this.hunkStickyScrollReservation === reservation) {
          this.clearPendingStickyHunkScrollRange();
        }
      }, 0);
    },

    cancelStickyHunkReturn({ preservePendingRange = false } = {}) {
      if (!preservePendingRange) {
        this.clearPendingStickyHunkScrollRange();
        this.hunkStickyPointerScrollReservation = null;
      }
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
        preserveStickySize = false,
        reservation = null,
      } = {},
    ) {
      const returnIsCurrent = () =>
        navigationGeneration === this.hunkStickyNavigationGeneration &&
        (!reservation || this.hunkStickyScrollReservation === reservation) &&
        this.stickyHunkScrollPositionMatches(expectedScrollPosition);
      const releaseReservation = () => reservation
        ? this.releaseStickyHunkScrollReservation(reservation)
        : this.clearPendingStickyHunkScrollRange(targetKey, navigationGeneration);
      if (!returnIsCurrent()) {
        releaseReservation();
        return;
      }
      if (this.hunkStickyScrollFrameId !== null) {
        this.window.cancelAnimationFrame(this.hunkStickyScrollFrameId);
      }
      this.hunkStickyScrollFrameId = this.window.requestAnimationFrame(() => {
        if (!returnIsCurrent()) {
          this.hunkStickyScrollFrameId = null;
          releaseReservation();
          return;
        }
        this.hunkStickyScrollFrameId = this.window.requestAnimationFrame(
          () => {
            this.hunkStickyScrollFrameId = null;
            if (!returnIsCurrent()) {
              releaseReservation();
              return;
            }
            const target = this.reviewControllerForKey(targetKey);
            if (target) {
              this.setStickyHunkReturnMode(target, preserveStickySize);
              if (focusTarget) {
                this.focusStickyHunkOrigin(target, focusTarget);
              }
              if (Number.isFinite(reservation?.prepaintTarget)) {
                // Persistence completion may restore focus, but must not
                // perform another visible return after the atomic collapse.
                this.hunkStickyScrollBoundaryTarget = reservation.prepaintTarget;
                this.settleStickyHunkScrollRange();
              } else {
                this.scrollStickyHunkToOrigin(target, { preserveStickySize });
              }
            } else {
              releaseReservation();
            }
          },
        );
      });
    },
  });
})(globalThis);
