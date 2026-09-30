(function attachHunkMarkStickyHunkLayout(root) {
  "use strict";

  const namespace = root.HunkMarkContent;
  const App = namespace?.App;
  const Sticky = namespace?.stickyHunk;
  if (!App || !Sticky) {
    return;
  }
  const {
    AUXILIARY_FADE_DISTANCE_PX,
    TIMELINE_STYLES,
    clearStyles,
    setPixelStyle,
    setPixelStyles,
  } = Sticky;

  Object.assign(App.prototype, {
    clearStickyHunkTimeline(controller) {
      controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
      clearStyles(controller.hunkRow, TIMELINE_STYLES);
    },

    stickyHunkFileDocumentTop(state) {
      const top = Number(state.fileElement.getBoundingClientRect?.().top);
      return Number.isFinite(top)
        ? top + (Number(this.window.scrollY) || 0)
        : Number(state.fileOriginDocumentTop) || 0;
    },

    applyStickyHunkFileOrigin(
      state,
      controllers,
      documentTop,
      { translateCachedOrigins = false } = {},
    ) {
      const previousTop = state.fileOriginDocumentTop;
      if (translateCachedOrigins && Number.isFinite(previousTop)) {
        const delta = documentTop - previousTop;
        if (Math.abs(delta) >= 0.01) {
          controllers.forEach((controller) => {
            if (Number.isFinite(controller.stickyHunkOriginDocumentTop)) {
              controller.stickyHunkOriginDocumentTop += delta;
            }
          });
        }
      }
      state.fileOriginDocumentTop = documentTop;
      state.fileOriginDirty = false;
      setPixelStyle(
        state.fileElement,
        "--hunkmark-sticky-hunk-file-start",
        documentTop - (state.stickyTop ?? 0),
      );
    },

    updateStickyHunkFileOrigin(state, controllers) {
      this.applyStickyHunkFileOrigin(
        state,
        controllers,
        this.stickyHunkFileDocumentTop(state),
        { translateCachedOrigins: true },
      );
    },

    prepareStickyHunkState(state, controllers) {
      const layoutPrepared =
        !state.orderChanged &&
        state.preparedOriginLayoutGeneration ===
          state.originLayoutGeneration &&
        state.preparedContentLayoutGeneration ===
          state.contentLayoutGeneration &&
        state.contentLayoutDirtyControllers.size === 0;
      if (layoutPrepared) {
        if (state.fileOriginDirty) {
          this.updateStickyHunkFileOrigin(state, controllers);
        }
        return;
      }

      const contentMeasurements = new Map();
      const naturalTops = [];
      const fileDocumentTop = this.stickyHunkFileDocumentTop(state);
      // All reads precede writes. Removing only the active row no longer
      // suffices: CSS can pin any prepared row without a JS state update.
      state.fileElement.classList.add("hunkmark-sticky-file-measuring");
      try {
        controllers.forEach((controller) => {
          this.stickyHunkContentMetrics(
            state,
            controller,
            contentMeasurements,
          );
          naturalTops.push(
            this.stickyHunkNaturalDocumentTop(controller, {
              originLayoutGeneration: state.originLayoutGeneration,
              refreshLayout: true,
            }),
          );
        });
        this.applyStickyHunkStateMeasurements(state, contentMeasurements);
        this.applyStickyHunkFileOrigin(
          state,
          controllers,
          fileDocumentTop,
        );
        controllers.forEach((controller, index) => {
          const inset = Math.max(0, controller.stickyHunkContentInset ?? 0);
          const bottomInset = Math.max(
            0,
            controller.stickyHunkBottomInset ?? 0,
          );
          const start = Math.max(
            0,
            naturalTops[index] - fileDocumentTop,
          );
          const tailStart = Math.max(
            0,
            naturalTops[index] - fileDocumentTop + inset,
          );
          const nextTop = naturalTops[index + 1];
          const distance = nextTop === undefined
            ? 0
            : controller.stickyHunkCompactHeight ??
              this.constants.STICKY_HUNK_HEIGHT_PX;
          const pushEnd = nextTop === undefined
            ? 1
            : Math.max(0, nextTop - fileDocumentTop);
          setPixelStyles(controller.hunkRow, [
            ["--hunkmark-sticky-hunk-compress-start", start],
            [
              "--hunkmark-sticky-hunk-compress-end",
              start + Math.max(inset, 1),
            ],
            ["--hunkmark-sticky-hunk-tail-start", tailStart],
            [
              "--hunkmark-sticky-hunk-tail-end",
              tailStart + Math.max(bottomInset, 1),
            ],
            ["--hunkmark-sticky-hunk-auxiliary-start", start],
            [
              "--hunkmark-sticky-hunk-auxiliary-end",
              start + (inset > 0 ? inset : AUXILIARY_FADE_DISTANCE_PX),
            ],
            ["--hunkmark-sticky-hunk-push-distance", distance],
            [
              "--hunkmark-sticky-hunk-push-start",
              Math.max(0, pushEnd - distance),
            ],
            ["--hunkmark-sticky-hunk-push-end", pushEnd],
          ]);
        });
        state.preparedOriginLayoutGeneration =
          state.originLayoutGeneration;
        state.preparedContentLayoutGeneration =
          state.contentLayoutGeneration;
      } finally {
        state.fileElement.classList.remove("hunkmark-sticky-file-measuring");
      }
    },

    stickyHunkControllerIndexAt(
      controllers,
      documentTop,
      { includeContentInset = false } = {},
    ) {
      let foundIndex = -1;
      let low = 0;
      let high = controllers.length - 1;
      while (low <= high) {
        const index = Math.floor((low + high) / 2);
        const controller = controllers[index];
        if (
          controller.stickyHunkOriginDocumentTop +
            (includeContentInset ? controller.stickyHunkContentInset ?? 0 : 0) <=
            documentTop
        ) {
          foundIndex = index;
          low = index + 1;
        } else {
          high = index - 1;
        }
      }
      return foundIndex;
    },

    syncStickyHunkPreparedWindow(state, controllers) {
      const scrollY = Number(this.window.scrollY) || 0;
      const viewportHeight = Math.max(0, Number(this.window.innerHeight) || 0);
      const overscan = Math.max(512, viewportHeight);
      // Keep a viewport of margin on either side, plus the preceding pinned
      // hunk and the following push-off boundary. Offscreen rows retain their
      // measured ranges but have no referenced scroll animations.
      const first = Math.max(0, this.stickyHunkControllerIndexAt(
        controllers,
        scrollY - overscan,
      ));
      const last = Math.min(controllers.length - 1,
        this.stickyHunkControllerIndexAt(
          controllers,
          scrollY + viewportHeight + overscan,
        ) + 1,
      );
      const preparedControllers = new Set();
      for (let index = first; index <= last; index += 1) {
        const controller = controllers[index];
        preparedControllers.add(controller);
        if (!state.preparedControllers.has(controller)) {
          controller.hunkRow.classList.add("hunkmark-sticky-hunk-prepared");
        }
      }
      state.preparedControllers.forEach((controller) => {
        if (!preparedControllers.has(controller)) {
          controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
        }
      });
      state.preparedControllers = preparedControllers;
    },

    updateStickyHunkInteractionState(state, controllers) {
      const stickyTop = state.stickyTop ?? 0;
      const scrollY = Number(this.window.scrollY) || 0;
      this.syncStickyHunkPreparedWindow(state, controllers);
      const activeIndex = this.stickyHunkControllerIndexAt(
        controllers,
        scrollY + stickyTop,
        { includeContentInset: true },
      );

      // Within the prepared window CSS owns positioning, clipping and pushing;
      // active state only selects the current interaction controls.
      const activeController = controllers[activeIndex] ?? null;
      const previousActiveController = state.activeController;
      if (previousActiveController !== activeController) {
        const returnButtonHadFocus =
          previousActiveController?.returnButton ===
          this.document.activeElement;
        previousActiveController?.hunkRow.classList.remove(
          "hunkmark-sticky-hunk-active",
        );
        activeController?.hunkRow.classList.add(
          "hunkmark-sticky-hunk-active",
        );
        if (activeController?.returnButton) {
          activeController.returnButton.hidden = false;
          activeController.returnButton.tabIndex = 0;
        }
        if (returnButtonHadFocus && activeController?.returnButton) {
          activeController.returnButton.focus({ preventScroll: true });
        }
        if (previousActiveController?.returnButton) {
          previousActiveController.returnButton.hidden = true;
          previousActiveController.returnButton.tabIndex = -1;
        }
        state.activeController = activeController;
      }
      state.orderChanged = false;
    },

    updateStickyHunkState(state) {
      const controllers = this.orderedStickyHunkControllers(state);
      this.prepareStickyHunkState(state, controllers);
      this.updateStickyHunkInteractionState(state, controllers);
    },

    stickyHunkStateCanPrepareDuringRefresh(state) {
      // Reconciliation can suspend controls after their DOM/order is complete.
      // Before that boundary, only independently usable files may be prepared.
      return !state.orderDirty && Array.from(state.controllers).every(
        (controller) => this.reviewControllerIsCurrent(controller) &&
          (this.refreshStickyLayoutReady ||
            (!this.reviewControllerIsSuspended(controller) &&
              !controller.input.disabled)),
      );
    },

    updateStickyHunkInteractions() {
      const states = this.hunkStickyFileVisibilityObserver
        ? this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      for (const state of states) {
        if (
          state.orderDirty ||
          state.orderChanged ||
          state.preparedOriginLayoutGeneration !==
            state.originLayoutGeneration ||
          state.preparedContentLayoutGeneration !==
            state.contentLayoutGeneration ||
          state.contentLayoutDirtyControllers.size > 0
        ) {
          if (this.stickyHunkStateCanPrepareDuringRefresh(state)) {
            this.updateStickyHunkState(state);
          }
          continue;
        }
        const controllers = state.orderedControllers;
        if (state.fileOriginDirty) {
          this.updateStickyHunkFileOrigin(state, controllers);
        }
        this.updateStickyHunkInteractionState(state, controllers);
      }
    },

    updateStickyHunkLayouts({
      allowDuringRefresh = false,
      includeFileElements = null,
    } = {}) {
      if (
        !allowDuringRefresh &&
        (this.refreshRunning || this.refreshQueued)
      ) {
        this.updateStickyHunkInteractions();
        return;
      }
      const states = this.hunkStickyFileVisibilityObserver
        ? includeFileElements
          ? new Set(this.hunkStickyVisibleStates)
          : this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      if (this.hunkStickyFileVisibilityObserver && includeFileElements) {
        includeFileElements.forEach((fileElement) => {
          const state = this.hunkStickyStateByFile.get(fileElement);
          if (state && (state.visible || !state.visibilityObserved)) {
            if (!state.visible) {
              this.setStickyHunkStateVisibility(state, true);
            }
            states.add(state);
          }
        });
      }
      for (const state of states) {
        this.updateStickyHunkState(state);
      }
    },
  });
})(globalThis);
