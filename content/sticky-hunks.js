(function attachHunkMarkStickyHunks(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  const Sticky = namespace?.stickyHunk;
  if (!App || !Sticky) {
    return;
  }
  const {
    ROW_CLASSES,
    ROW_STYLES,
    clearClasses,
    clearStyles,
    firstPositiveNumber,
    setPixelStyle,
  } = Sticky;

  Object.assign(App.prototype, {
    stickyFileHeader(fileElement) {
      if (!fileElement) {
        return null;
      }
      const candidates = [
        fileElement.querySelector('[class*="diffHeaderWrapper"]'),
        fileElement.querySelector(".file-header"),
        fileElement.querySelector('[data-testid*="file-header"]'),
        fileElement.querySelector('[class*="diff-file-header"]'),
        fileElement.querySelector(":scope > header"),
      ].filter((element, index, elements) =>
        element && elements.indexOf(element) === index,
      );
      const positionedHeader = candidates.find((element) => {
        const position = this.window.getComputedStyle(element).position;
        return position === "sticky" || position === "fixed";
      });
      return positionedHeader ?? candidates[0] ?? null;
    },

    stickyHunkTopForHeader(header) {
      if (!header) {
        return 0;
      }
      const style = this.window.getComputedStyle(header);
      if (style.position !== "sticky" && style.position !== "fixed") {
        return 0;
      }
      const top = Number.parseFloat(style.top);
      const height = firstPositiveNumber(
        header.getBoundingClientRect?.().height,
        header.offsetHeight,
        Number.parseFloat(style.height),
      );
      return Math.ceil(Math.max(Number.isFinite(top) ? top : 0, 0) + height);
    },

    ensureHunkStickyHeaderObserver() {
      if (
        this.hunkStickyHeaderObserver ||
        typeof this.window.ResizeObserver !== "function"
      ) {
        return;
      }
      this.hunkStickyHeaderObserver = new this.window.ResizeObserver(
        (entries) => {
          entries.forEach((entry) => {
            const fileElement = this.hunkStickyFileByHeader.get(entry.target);
            const state = fileElement
              ? this.hunkStickyStateByFile.get(fileElement)
              : null;
            if (state?.header === entry.target && state.visible) {
              this.updateStickyHunkTop(state);
            }
          });
        },
      );
    },

    ensureHunkStickyRowObserver() {
      if (
        this.hunkStickyRowObserver ||
        typeof this.window.ResizeObserver !== "function"
      ) {
        return;
      }
      this.hunkStickyRowObserver = new this.window.ResizeObserver(
        (entries) => {
          let visibleStateChanged = false;
          entries.forEach((entry) => {
            const controller = this.hunkStickyControllerByRow.get(
              entry.target,
            );
            if (
              !controller ||
              controller.destroyed ||
              controller.hunkRow !== entry.target ||
              !controller.hunkRow.isConnected
            ) {
              return;
            }
            const state = this.hunkStickyStateByFile.get(
              controller.fileElement,
            );
            if (!state?.visible) {
              return;
            }
            if (
              controller.stickyHunkContentLayoutGeneration ===
              state.contentLayoutGeneration
            ) {
              state.contentLayoutDirtyControllers.add(controller);
            }
            this.markStickyHunkOriginsDirty(state);
            visibleStateChanged = true;
          });
          if (visibleStateChanged) {
            this.scheduleStickyHunkLayout();
          }
        },
      );
    },

    observeStickyHunkRow(controller) {
      if (controller.stickyHunkRowObserved) {
        return;
      }
      this.ensureHunkStickyRowObserver();
      if (this.hunkStickyRowObserver) {
        this.hunkStickyControllerByRow.set(controller.hunkRow, controller);
        this.hunkStickyRowObserver.observe(controller.hunkRow);
        controller.stickyHunkRowObserved = true;
      }
    },

    unobserveStickyHunkRow(controller) {
      if (!controller.stickyHunkRowObserved) {
        return;
      }
      this.hunkStickyRowObserver?.unobserve?.(controller.hunkRow);
      controller.stickyHunkRowObserved = false;
    },

    ensureHunkStickyFileLayoutObserver() {
      if (
        this.hunkStickyFileLayoutObserver ||
        typeof this.window.ResizeObserver !== "function"
      ) {
        return;
      }
      this.hunkStickyFileLayoutObserver = new this.window.ResizeObserver(
        (entries) => {
          const resizedFileElements = new Set();
          let bodyResized = false;
          entries.forEach((entry) => {
            if (entry.target === this.document.body) {
              bodyResized = true;
            } else if (this.hunkStickyStateByFile.has(entry.target)) {
              // Nested content can move enclosing hunks while its ancestors'
              // own box sizes stay fixed.
              for (let fileElement = entry.target; fileElement; fileElement = fileElement.parentElement) {
                if (this.hunkStickyStateByFile.has(fileElement)) {
                  resizedFileElements.add(fileElement);
                }
              }
            }
          });
          if (!bodyResized && resizedFileElements.size === 0) {
            return;
          }
          const states = this.hunkStickyFileVisibilityObserver
            ? this.hunkStickyVisibleStates
            : this.hunkStickyStateByFile.values();
          let visibleStateChanged = false;
          for (const state of states) {
            if (resizedFileElements.has(state.fileElement)) {
              this.markStickyHunkOriginsDirty(state);
            } else {
              // A resized file or body can translate every following file.
              // Their internal hunk geometry remains file-relative.
              this.markStickyHunkFileOriginDirty(state);
            }
            visibleStateChanged = true;
          }
          if (visibleStateChanged) {
            this.scheduleStickyHunkLayout();
          }
        },
      );
    },

    ensureHunkStickyFileVisibilityObserver() {
      if (
        this.hunkStickyFileVisibilityObserver ||
        typeof this.window.IntersectionObserver !== "function"
      ) {
        return;
      }
      this.hunkStickyFileVisibilityObserver =
        new this.window.IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            const state = this.hunkStickyStateByFile.get(entry.target);
            if (state) {
              state.visibilityObserved = true;
              this.setStickyHunkStateVisibility(state, entry.isIntersecting);
            }
          });
          this.scheduleStickyHunkLayout();
        });
    },

    setStickyHunkStateVisibility(state, visible) {
      const nextVisible = Boolean(visible);
      if (state.visible === nextVisible) {
        return;
      }
      state.visible = nextVisible;
      if (state.visible) {
        // The file may have been rebuilt or moved while outside the viewport.
        this.syncStickyHunkHeader(state);
        state.controllers.forEach((controller) =>
          this.observeStickyHunkRow(controller),
        );
        this.markStickyHunkContentDirty(state);
        this.markStickyHunkOriginsDirty(state);
        this.hunkStickyVisibleStates.add(state);
        return;
      }
      state.controllers.forEach((controller) =>
        this.unobserveStickyHunkRow(controller),
      );
      this.detachStickyHunkHeader(state);
      this.hunkStickyVisibleStates.delete(state);
      state.controllersWithRanges.forEach((controller) =>
        this.clearStickyHunkTimeline(controller),
      );
      state.controllersWithRanges.clear();
      state.preparedControllers.clear();
      state.activeController?.hunkRow.classList.remove(
        "hunkmark-sticky-hunk-active",
      );
      if (state.activeController?.returnButton) {
        state.activeController.returnButton.hidden = true;
        state.activeController.returnButton.tabIndex = -1;
      }
      state.activeController = null;
      this.markStickyHunkOriginsDirty(state);
    },

    markStickyHunkOriginsDirty(state) {
      this.markStickyHunkFileOriginDirty(state);
      state.originLayoutGeneration = Number.isInteger(
        state.originLayoutGeneration,
      )
        ? state.originLayoutGeneration + 1
        : 0;
    },

    markStickyHunkFileOriginDirty(state) {
      state.fileOriginDirty = true;
    },

    invalidateVisibleStickyHunkOrigins({ translationOnly = false } = {}) {
      const states = this.hunkStickyFileVisibilityObserver
        ? this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      let visibleStateChanged = false;
      for (const state of states) {
        if (translationOnly) {
          this.markStickyHunkFileOriginDirty(state);
        } else {
          this.markStickyHunkOriginsDirty(state);
        }
        visibleStateChanged = true;
      }
      if (visibleStateChanged) {
        this.scheduleStickyHunkLayout();
      }
    },

    invalidateStickyHunkOrigins(fileElement) {
      const state = this.hunkStickyStateByFile.get(fileElement);
      if (!state) {
        return;
      }
      this.markStickyHunkOriginsDirty(state);
      this.scheduleStickyHunkLayout();
    },

    invalidateStickyHunkOriginsForMutations(mutations) {
      const states = new Set();
      mutations.forEach((mutation) => {
        const target =
          mutation.target?.nodeType === this.window.Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target?.parentElement;
        let candidate = target;
        while (candidate) {
          const state = this.hunkStickyStateByFile.get(candidate);
          if (state) {
            states.add(state);
          }
          candidate = candidate.parentElement;
        }
      });
      if (states.size === 0) {
        return;
      }
      states.forEach((state) => this.markStickyHunkOriginsDirty(state));
      this.scheduleStickyHunkLayout();
    },

    invalidateVisibleStickyHunkLayouts({ refreshHeaders = false } = {}) {
      const states = this.hunkStickyFileVisibilityObserver
        ? this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      for (const state of states) {
        if (refreshHeaders) {
          this.syncStickyHunkHeader(state);
        }
        this.markStickyHunkContentDirty(state);
        this.markStickyHunkOriginsDirty(state);
      }
      this.scheduleStickyHunkLayout();
    },

    updateStickyHunkTop(state) {
      const stickyTop = this.stickyHunkTopForHeader(state.header);
      if (state.stickyTop !== stickyTop) {
        state.stickyTop = stickyTop;
        this.markStickyHunkFileOriginDirty(state);
      }
      setPixelStyle(
        state.fileElement,
        "--hunkmark-sticky-hunk-top",
        state.stickyTop,
      );
      this.scheduleStickyHunkLayout();
    },

    createStickyHunkState(fileElement) {
      return {
        activeController: null,
        contentLayoutGeneration: 0,
        contentLayoutDirtyControllers: new Set(),
        controllers: new Set(),
        controllersWithRanges: new Set(),
        fileElement,
        fileOriginDirty: true,
        fileOriginDocumentTop: null,
        header: null,
        headerAttributeObserver: null,
        orderChanged: true,
        orderDirty: true,
        orderedControllers: [],
        originLayoutGeneration: 0,
        preparedOriginLayoutGeneration: null,
        preparedContentLayoutGeneration: null,
        preparedControllers: new Set(),
        stickyTop: 0,
        visibilityObserved: false,
        visible: typeof this.window.IntersectionObserver !== "function",
      };
    },

    markStickyHunkContentDirty(state) {
      state.contentLayoutGeneration += 1;
      // The generation mismatch marks all rows dirty without retaining each
      // controller after a global layout invalidation.
      state.contentLayoutDirtyControllers = new Set();
    },

    detachStickyHunkHeader(state) {
      state.headerAttributeObserver?.disconnect();
      state.headerAttributeObserver = null;
      if (!state.header) {
        return;
      }
      state.header.classList.remove("hunkmark-sticky-file-header");
      this.hunkStickyHeaderObserver?.unobserve?.(state.header);
      this.hunkStickyFileByHeader.delete(state.header);
      state.header = null;
    },

    observeStickyHunkHeaderAttributes(state, header) {
      if (typeof this.window.MutationObserver !== "function") {
        return;
      }
      state.headerAttributeObserver = new this.window.MutationObserver(
        (mutations) => {
          if (
            state.header === header &&
            state.visible &&
            mutations.some((mutation) => mutation.target === header)
          ) {
            this.syncStickyHunkHeader(state);
          }
        },
      );
      state.headerAttributeObserver.observe(header, {
        attributeFilter: ["class", "style"],
        attributes: true,
      });
    },

    syncStickyHunkHeader(state) {
      const header = this.stickyFileHeader(state.fileElement);
      if (state.header !== header) {
        this.detachStickyHunkHeader(state);
        state.header = header;
        if (header) {
          header.classList.add("hunkmark-sticky-file-header");
          this.ensureHunkStickyHeaderObserver();
          this.hunkStickyFileByHeader.set(header, state.fileElement);
          this.hunkStickyHeaderObserver?.observe(header);
          this.observeStickyHunkHeaderAttributes(state, header);
        }
      } else if (
        header &&
        !header.classList.contains("hunkmark-sticky-file-header")
      ) {
        header.classList.add("hunkmark-sticky-file-header");
      }
      if (state.visible) {
        this.updateStickyHunkTop(state);
      }
    },

    scheduleStickyHunkLayout() {
      if (
        this.stopped ||
        ((this.refreshRunning || this.refreshQueued) &&
          !Array.from(this.hunkStickyVisibleStates).some((state) =>
            this.stickyHunkStateCanPrepareDuringRefresh(state),
          )) ||
        this.hunkStickyStateByFile.size === 0 ||
        (this.hunkStickyFileVisibilityObserver &&
          this.hunkStickyVisibleStates.size === 0) ||
        this.hunkStickyLayoutFrameId !== null
      ) {
        return;
      }
      this.hunkStickyLayoutFrameId = this.window.requestAnimationFrame(() => {
        this.hunkStickyLayoutFrameId = null;
        if (
          (this.refreshRunning || this.refreshQueued) &&
          !Array.from(this.hunkStickyVisibleStates).some((state) =>
            this.stickyHunkStateCanPrepareDuringRefresh(state),
          )
        ) {
          return;
        }
        this.updateStickyHunkLayouts();
      });
    },

    attachStickyHunkRow(controller) {
      if (
        controller.stickyHunkFileElement &&
        controller.stickyHunkFileElement !== controller.fileElement
      ) {
        this.detachStickyHunkRow(controller);
      }
      const rowWasAttached =
        controller.hunkRow.classList.contains("hunkmark-sticky-hunk-row") &&
        this.hunkStickyControllerByRow.get(controller.hunkRow) === controller;
      if (!rowWasAttached) {
        this.clearStickyHunkTimeline(controller);
        if (controller.hunkRow.classList.contains("hunkmark-sticky-hunk-active")) {
          controller.hunkRow.classList.remove("hunkmark-sticky-hunk-active");
        }
      }
      controller.hunkRow.classList.add("hunkmark-sticky-hunk-row");
      this.hunkStickyControllerByRow.set(controller.hunkRow, controller);

      let state = this.hunkStickyStateByFile.get(controller.fileElement);
      if (!state) {
        state = this.createStickyHunkState(controller.fileElement);
        this.hunkStickyStateByFile.set(controller.fileElement, state);
        if (state.visible) {
          this.hunkStickyVisibleStates.add(state);
        }
        this.ensureHunkStickyFileLayoutObserver();
        if (this.document.body) {
          this.hunkStickyFileLayoutObserver?.observe(this.document.body);
        }
        this.hunkStickyFileLayoutObserver?.observe(controller.fileElement);
        this.ensureHunkStickyFileVisibilityObserver();
        this.hunkStickyFileVisibilityObserver?.observe(controller.fileElement);
        if (state.visible) {
          this.syncStickyHunkHeader(state);
        }
      } else if (state.header && !state.header.isConnected) {
        this.detachStickyHunkHeader(state);
        if (state.visible) {
          this.syncStickyHunkHeader(state);
        }
      }
      if (!rowWasAttached) {
        state.preparedControllers.delete(controller);
        if (state.activeController === controller) {
          state.activeController = null;
          if (controller.returnButton) {
            controller.returnButton.hidden = true;
            controller.returnButton.tabIndex = -1;
          }
        }
      }
      const controllerAdded = !state.controllers.has(controller);
      if (controllerAdded) {
        state.controllers.add(controller);
        state.orderDirty = true;
        state.orderChanged = true;
      }
      if (state.visible) {
        this.observeStickyHunkRow(controller);
      }
      const auxiliaryElementsChanged =
        this.syncStickyHunkAuxiliaryElements(controller);
      if (
        (!rowWasAttached || auxiliaryElementsChanged) &&
        controller.stickyHunkContentLayoutGeneration ===
          state.contentLayoutGeneration
      ) {
        state.contentLayoutDirtyControllers.add(controller);
      }
      const layoutChanged =
        !rowWasAttached || controllerAdded || auxiliaryElementsChanged;
      if (layoutChanged) {
        this.markStickyHunkOriginsDirty(state);
      }
      controller.stickyHunkFileElement = controller.fileElement;
      controller.stickyHunkClickHandler ??= (event) =>
        this.handleStickyHunkClick(controller, event);
      controller.hunkRow.addEventListener(
        "click",
        controller.stickyHunkClickHandler,
        true,
      );
      controller.stickyHunkFocusHandler ??= (event) =>
        this.revealFocusedStickyHunk(controller, event.target);
      controller.hunkRow.addEventListener(
        "focusin",
        controller.stickyHunkFocusHandler,
      );
      controller.stickyHunkFocusOutHandler ??= () => this.scheduleStickyHunkLayout();
      controller.hunkRow.addEventListener("focusout", controller.stickyHunkFocusOutHandler);
      if (layoutChanged) {
        this.scheduleStickyHunkLayout();
      }
    },

    detachStickyHunkRow(controller) {
      this.unobserveStickyHunkRow(controller);
      this.hunkStickyControllerByRow.delete(controller.hunkRow);
      clearClasses(controller.hunkRow, ROW_CLASSES);
      clearStyles(controller.hunkRow, ROW_STYLES);
      controller.stickyHunkTimelineSignature = null;
      controller.hunkRow?.removeEventListener(
        "click",
        controller.stickyHunkClickHandler,
        true,
      );
      controller.hunkRow?.removeEventListener(
        "focusin",
        controller.stickyHunkFocusHandler,
      );
      controller.hunkRow?.removeEventListener("focusout", controller.stickyHunkFocusOutHandler);
      (controller.stickyHunkAuxiliaryElements ?? []).forEach((element) => {
        element.classList.remove("hunkmark-sticky-hunk-auxiliary");
      });
      Object.assign(controller, {
        stickyHunkAuxiliaryElements: [],
        stickyHunkBottomInset: 0,
        stickyHunkCompactHeight: null,
        stickyHunkContentInset: 0,
        stickyHunkHasAuxiliaryElements: false,
        stickyHunkOriginDocumentTop: null,
        stickyHunkOriginFileDocumentTop: null,
        stickyHunkOriginLayoutGeneration: null,
        stickyHunkOrderIndex: null,
      });
      if (controller.returnButton) {
        controller.returnButton.hidden = true;
        controller.returnButton.tabIndex = -1;
      }
      const fileElement = controller.stickyHunkFileElement;
      controller.stickyHunkFileElement = null;
      if (!fileElement) {
        return;
      }
      const state = this.hunkStickyStateByFile.get(fileElement);
      if (state?.activeController === controller) {
        state.activeController = null;
      }
      state?.controllers.delete(controller);
      state?.preparedControllers.delete(controller);
      state?.controllersWithRanges.delete(controller);
      if (state) {
        state.contentLayoutDirtyControllers.delete(controller);
        state.orderDirty = true;
        state.orderChanged = true;
      }
      if (!state || state.controllers.size > 0) {
        this.scheduleStickyHunkLayout();
        return;
      }
      this.detachStickyHunkHeader(state);
      fileElement.style.removeProperty("--hunkmark-sticky-hunk-top");
      fileElement.style.removeProperty("--hunkmark-sticky-hunk-file-start");
      this.hunkStickyFileLayoutObserver?.unobserve?.(fileElement);
      this.hunkStickyFileVisibilityObserver?.unobserve?.(fileElement);
      this.hunkStickyVisibleStates.delete(state);
      this.hunkStickyStateByFile.delete(fileElement);
      if (this.hunkStickyStateByFile.size === 0 && this.document.body) {
        this.hunkStickyFileLayoutObserver?.unobserve?.(this.document.body);
      }
    },

    cleanupStickyHunks() {
      this.hunkStickyStateByFile.forEach((state) => {
        state.controllers.forEach((controller) => {
          controller.stickyHunkRowObserved = false;
          this.clearStickyHunkTimeline(controller);
        });
        this.detachStickyHunkHeader(state);
        state.fileElement.style.removeProperty("--hunkmark-sticky-hunk-top");
        state.fileElement.style.removeProperty(
          "--hunkmark-sticky-hunk-file-start",
        );
      });
      this.hunkStickyStateByFile.clear();
      this.hunkStickyVisibleStates.clear();
      this.hunkStickyFileVisibilityObserver?.disconnect();
      this.hunkStickyFileVisibilityObserver = null;
      this.hunkStickyFileLayoutObserver?.disconnect();
      this.hunkStickyFileLayoutObserver = null;
      this.hunkStickyRowObserver?.disconnect();
      this.hunkStickyRowObserver = null;
      this.hunkStickyControllerByRow = new WeakMap();
      this.hunkStickyFileByHeader = new WeakMap();
      this.hunkStickyHeaderObserver?.disconnect();
      this.hunkStickyHeaderObserver = null;
      if (this.hunkStickyLayoutFrameId !== null) {
        this.window.cancelAnimationFrame(this.hunkStickyLayoutFrameId);
        this.hunkStickyLayoutFrameId = null;
      }
      if (this.hunkStickyScrollFrameId !== null) {
        this.window.cancelAnimationFrame(this.hunkStickyScrollFrameId);
        this.hunkStickyScrollFrameId = null;
      }
    },
  });
})(globalThis);
