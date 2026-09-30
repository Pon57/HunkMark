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
      this.hunkStickyStateByFile.get(controller.stickyHunkFileElement ?? controller.fileElement)
        ?.controllersWithRanges.delete(controller);
      const prepared = controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared");
      if (!prepared && !controller.stickyHunkTimelineSignature) {
        return;
      }
      if (prepared) {
        controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
      }
      clearStyles(controller.hunkRow, TIMELINE_STYLES);
      controller.stickyHunkTimelineSignature = null;
    },

    stickyHunkFileDocumentTop(state) {
      const top = Number(state.fileElement.getBoundingClientRect?.().top);
      return Number.isFinite(top)
        ? top + (Number(this.window.scrollY) || 0)
        : Number(state.fileOriginDocumentTop) || 0;
    },

    applyStickyHunkFileOrigin(state, documentTop) {
      state.fileOriginDocumentTop = documentTop;
      state.fileOriginDirty = false;
      setPixelStyle(
        state.fileElement,
        "--hunkmark-sticky-hunk-file-start",
        documentTop - (state.stickyTop ?? 0),
      );
    },

    updateStickyHunkFileOrigin(state) {
      this.applyStickyHunkFileOrigin(
        state,
        this.stickyHunkFileDocumentTop(state),
      );
    },

    prepareStickyHunkState(state, controllers) {
      if (state.fileOriginDirty) {
        this.updateStickyHunkFileOrigin(state);
      }
      const contentMeasurements = new Map();
      let measuring = false;
      const ensureNaturalLayout = (controller) => {
        if (!measuring && controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared")) {
          // Restore flow for all pinned rows, but only until this synchronous
          // read batch ends. Never paint a partially unpinned file.
          state.fileElement.classList.add("hunkmark-sticky-file-measuring");
          measuring = true;
        }
      };
      const naturalTopFor = (controller) => {
        const cachedTop = this.cachedStickyHunkNaturalDocumentTop(controller);
        if (
          !Number.isFinite(cachedTop) ||
          controller.stickyHunkOriginLayoutGeneration !== state.originLayoutGeneration
        ) {
          ensureNaturalLayout(controller);
          return this.stickyHunkNaturalDocumentTop(controller, {
            originLayoutGeneration: state.originLayoutGeneration,
            refreshLayout: true,
          });
        }
        return cachedTop;
      };
      const contentFor = (controller) => {
        if (
          controller.stickyHunkContentLayoutGeneration !== state.contentLayoutGeneration ||
          state.contentLayoutDirtyControllers.has(controller)
        ) {
          ensureNaturalLayout(controller);
        }
        return this.stickyHunkContentMetrics(state, controller, contentMeasurements);
      };
      const indexAt = (top, includeContentInset = false) =>
        this.stickyHunkControllerIndexAt(controllers, top, {
          includeContentInset,
          documentTopFor: naturalTopFor,
          contentInsetFor: (controller) => contentFor(controller).inset,
        });
      try {
        const scrollY = Number(this.window.scrollY) || 0;
        const viewportHeight = Math.max(0, Number(this.window.innerHeight) || 0);
        const overscan = Math.max(512, viewportHeight);
        // Remeasure binary-search probes for this generation, so a jump never
        // selects its window using stale offscreen origins.
        const activeIndex = indexAt(scrollY + (state.stickyTop ?? 0), true);
        const first = Math.max(0, Math.min(indexAt(scrollY - overscan), activeIndex));
        const last = Math.min(controllers.length - 1, Math.max(
          indexAt(scrollY + viewportHeight + overscan) + 1,
          activeIndex + 1,
        ));
        const naturalTops = new Map();
        for (let index = first; index <= last; index += 1) {
          naturalTops.set(controllers[index], naturalTopFor(controllers[index]));
          contentFor(controllers[index]);
        }
        // The following hunk determines the last prepared row's push-off.
        if (controllers[last + 1]) {
          naturalTops.set(controllers[last + 1], naturalTopFor(controllers[last + 1]));
        }
        const focused = this.focusedStickyHunkController(state);
        let focusedNext;
        if (focused) {
          naturalTops.set(focused, naturalTopFor(focused));
          contentFor(focused);
          focusedNext = controllers[focused.stickyHunkOrderIndex + 1];
          if (focusedNext) {
            naturalTops.set(focusedNext, naturalTopFor(focusedNext));
          }
        }
        this.applyStickyHunkStateMeasurements(state, contentMeasurements);
        for (let index = first; index <= last; index += 1) {
          this.syncStickyHunkTimelineRanges(
            controllers[index], naturalTops.get(controllers[index]),
            naturalTops.get(controllers[index + 1]), state.fileOriginDocumentTop,
          );
        }
        if (focused) {
          this.syncStickyHunkTimelineRanges(
            focused, naturalTops.get(focused), naturalTops.get(focusedNext), state.fileOriginDocumentTop,
          );
        }
        state.preparedOriginLayoutGeneration = state.originLayoutGeneration;
        state.preparedContentLayoutGeneration = state.contentLayoutGeneration;
        return { activeIndex, first, last };
      } finally {
        if (measuring) {
          state.fileElement.classList.remove("hunkmark-sticky-file-measuring");
        }
      }
    },

    syncStickyHunkTimelineRanges(controller, naturalTop, nextTop, fileDocumentTop) {
      const inset = Math.max(0, controller.stickyHunkContentInset ?? 0);
      const bottomInset = Math.max(0, controller.stickyHunkBottomInset ?? 0);
      const start = Math.max(0, naturalTop - fileDocumentTop);
      const tailStart = Math.max(0, naturalTop - fileDocumentTop + inset);
      const distance = nextTop === undefined ? 0 :
        controller.stickyHunkCompactHeight ?? this.constants.STICKY_HUNK_HEIGHT_PX;
      const pushEnd = nextTop === undefined ? 1 : Math.max(0, nextTop - fileDocumentTop);
      const signature = [start, tailStart, inset, bottomInset, distance, pushEnd].join(":");
      // The host can rewrite inline styles while retaining the row and its
      // geometry. Per-property guards restore missing ranges without rewrites.
      setPixelStyles(controller.hunkRow, [
        ["--hunkmark-sticky-hunk-compress-start", start],
        ["--hunkmark-sticky-hunk-compress-end", start + Math.max(inset, 1)],
        ["--hunkmark-sticky-hunk-tail-start", tailStart],
        ["--hunkmark-sticky-hunk-tail-end", tailStart + Math.max(bottomInset, 1)],
        ["--hunkmark-sticky-hunk-auxiliary-start", start],
        ["--hunkmark-sticky-hunk-auxiliary-end", start + (inset > 0 ? inset : AUXILIARY_FADE_DISTANCE_PX)],
        ["--hunkmark-sticky-hunk-push-distance", distance],
        ["--hunkmark-sticky-hunk-push-start", Math.max(0, pushEnd - distance)],
        ["--hunkmark-sticky-hunk-push-end", pushEnd],
      ]);
      controller.stickyHunkTimelineSignature = signature;
      this.hunkStickyStateByFile.get(controller.fileElement)?.controllersWithRanges.add(controller);
    },

    stickyHunkControllerIndexAt(
      controllers,
      documentTop,
      {
        includeContentInset = false,
        documentTopFor = (controller) => this.cachedStickyHunkNaturalDocumentTop(controller),
        contentInsetFor = (controller) => controller.stickyHunkContentInset ?? 0,
      } = {},
    ) {
      let foundIndex = -1;
      let low = 0;
      let high = controllers.length - 1;
      while (low <= high) {
        const index = Math.floor((low + high) / 2);
        const controller = controllers[index];
        if (
          documentTopFor(controller) +
            (includeContentInset ? contentInsetFor(controller) : 0) <=
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

    syncStickyHunkPreparedWindow(state, controllers, { first, last }) {
      // Keep a viewport of margin, the preceding pinned row and the next
      // push-off boundary. Offscreen rows have no referenced animations.
      const preparedControllers = new Set();
      for (let index = first; index <= last; index += 1) {
        const controller = controllers[index];
        preparedControllers.add(controller);
        if (!state.preparedControllers.has(controller)) {
          controller.hunkRow.classList.add("hunkmark-sticky-hunk-prepared");
        }
      }
      const focused = this.focusedStickyHunkController(state);
      if (focused) {
        preparedControllers.add(focused);
        if (!state.preparedControllers.has(focused)) {
          focused.hunkRow.classList.add("hunkmark-sticky-hunk-prepared");
        }
      }
      state.preparedControllers.forEach((controller) => {
        if (!preparedControllers.has(controller)) {
          controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
        }
      });
      state.preparedControllers = preparedControllers;
    },

    updateStickyHunkInteractionState(
      state, controllers, layout = this.prepareStickyHunkState(state, controllers),
    ) {
      this.syncStickyHunkPreparedWindow(state, controllers, layout);
      const { activeIndex } = layout;

      // Within the prepared window CSS owns positioning, clipping and pushing;
      // active state only selects the current interaction controls.
      const focused = this.focusedStickyHunkController(state);
      const focusedPinned = focused &&
        this.document.activeElement !== focused.returnButton &&
        this.cachedStickyHunkNaturalDocumentTop(focused) + (focused.stickyHunkContentInset ?? 0) <=
          (Number(this.window.scrollY) || 0) + (state.stickyTop ?? 0);
      const activeController = focusedPinned ? focused : controllers[activeIndex] ?? null;
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
          this.focusStickyHunkWithoutReveal(activeController, activeController.returnButton);
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
      const layout = this.prepareStickyHunkState(state, controllers);
      this.updateStickyHunkInteractionState(state, controllers, layout);
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

    stickyHunkControllerForInteractionTarget(node) {
      const element = node instanceof this.window.Element ? node : node?.parentElement;
      for (let current = element; current; current = current.parentElement) {
        const controller = this.hunkStickyControllerByRow.get(current);
        if (controller) {
          return controller;
        }
      }
      return this.knownLineControllerForMutationTarget(element)?.controller ?? null;
    },

    focusedStickyHunkController(state) {
      const target = this.document.activeElement;
      if (!(target instanceof this.window.Element) || !target.matches(":focus-visible")) {
        return null;
      }
      const controller = this.stickyHunkControllerForInteractionTarget(target);
      return controller && state.controllers.has(controller) && controller.hunkRow.contains(target)
        ? controller : null;
    },

    updateStickyHunkInteractionsForControllers(controllers) {
      const states = new Set();
      for (const controller of controllers) {
        const state = this.hunkStickyStateByFile.get(controller.fileElement);
        if (
          state?.visible && this.reviewControllerIsCurrent(controller) &&
          (!(this.refreshRunning || this.refreshQueued) ||
            this.stickyHunkStateCanPrepareDuringRefresh(state))
        ) {
          states.add(state);
        }
      }
      states.forEach((state) => this.updateStickyHunkState(state));
    },

    updateStickyHunkInteractions() {
      const states = this.hunkStickyFileVisibilityObserver
        ? this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      for (const state of states) {
        if (!this.stickyHunkStateCanPrepareDuringRefresh(state)) {
          continue;
        }
        if (
          state.orderDirty ||
          state.orderChanged ||
          state.preparedOriginLayoutGeneration !==
            state.originLayoutGeneration ||
          state.preparedContentLayoutGeneration !==
            state.contentLayoutGeneration ||
          state.contentLayoutDirtyControllers.size > 0
        ) {
          this.updateStickyHunkState(state);
          continue;
        }
        const controllers = state.orderedControllers;
        if (state.fileOriginDirty) {
          this.updateStickyHunkFileOrigin(state);
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
