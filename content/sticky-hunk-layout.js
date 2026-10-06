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
      this.clearStickyHunkClipAnimation(controller);
      const hadRanges = this.hunkStickyStateByFile.get(controller.stickyHunkFileElement ?? controller.fileElement)
        ?.controllersWithRanges.delete(controller);
      const prepared = controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared");
      if (!prepared && !hadRanges) {
        return;
      }
      if (prepared) {
        controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
      }
      clearStyles(controller.hunkRow, TIMELINE_STYLES);
    },

    stickyHunkFileDocumentTop(state) {
      const rect = state.fileElement.getBoundingClientRect?.();
      const top = Number(rect?.top);
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
        const focusedOutsideWindow = focused &&
          (focused.stickyHunkOrderIndex < first || focused.stickyHunkOrderIndex > last);
        if (focusedOutsideWindow) {
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
        if (focusedOutsideWindow) {
          this.syncStickyHunkTimelineRanges(
            focused, naturalTops.get(focused), naturalTops.get(focusedNext), state.fileOriginDocumentTop,
          );
        }
        return { activeIndex, first, last, focused };
      } finally {
        if (measuring) {
          state.fileElement.classList.remove("hunkmark-sticky-file-measuring");
        }
      }
    },

    syncStickyHunkTimelineRanges(controller, naturalTop, nextTop, fileDocumentTop) {
      const state = this.hunkStickyStateByFile.get(controller.fileElement);
      const inset = Math.max(0, controller.stickyHunkContentInset ?? 0);
      const bottomInset = Math.max(0, controller.stickyHunkBottomInset ?? 0);
      const start = Math.max(0, naturalTop - fileDocumentTop);
      const distance = nextTop === undefined ? 0 :
        controller.stickyHunkCompactHeight ?? this.constants.STICKY_HUNK_HEIGHT_PX;
      const pushEnd = nextTop === undefined ? 1 : Math.max(0, nextTop - fileDocumentTop);
      // The host can rewrite inline styles while retaining the row and its
      // geometry. Per-property guards restore missing ranges without rewrites.
      this.syncStickyHunkContentStyles(controller);
      this.syncStickyHunkTailRoom(controller, naturalTop, nextTop !== undefined);
      setPixelStyles(controller.hunkRow, [
        ["--hunkmark-sticky-hunk-auxiliary-start", start],
        ["--hunkmark-sticky-hunk-auxiliary-end", start + (inset > 0 ? inset : AUXILIARY_FADE_DISTANCE_PX)],
        ["--hunkmark-sticky-hunk-push-distance", distance],
        ["--hunkmark-sticky-hunk-push-start", Math.max(0, pushEnd - distance)],
        ["--hunkmark-sticky-hunk-push-end", pushEnd],
      ]);
      const tailRoom = controller.hunkRow.classList.contains("hunkmark-sticky-hunk-tail-constrained")
        ? controller.stickyHunkTailRoom ?? 0 : bottomInset;
      const compensation = Math.max(0, bottomInset - tailRoom);
      const compensationStart = start + inset + Math.min(bottomInset, tailRoom);
      setPixelStyles(controller.hunkRow, [
        ["--hunkmark-sticky-hunk-tail-compensation", compensation],
        ["--hunkmark-sticky-hunk-tail-compensate-start", compensationStart],
        ["--hunkmark-sticky-hunk-tail-compensate-end", compensationStart + Math.max(compensation, 1)],
      ]);
      this.syncStickyHunkClipAnimation(controller, naturalTop, state?.stickyTop ?? 0);
      state?.controllersWithRanges.add(controller);
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

    syncStickyHunkPreparedWindow(state, controllers, { first, last, focused }) {
      // Keep a viewport of margin, the preceding pinned row and the next
      // push-off boundary. Offscreen rows have no referenced animations.
      const preparedControllers = new Set();
      for (let index = first; index <= last; index += 1) {
        preparedControllers.add(controllers[index]);
      }
      if (focused) {
        preparedControllers.add(focused);
      }
      preparedControllers.forEach((controller) => {
        if (!controller.hunkRow.classList.contains("hunkmark-sticky-hunk-row")) {
          controller.hunkRow.classList.add("hunkmark-sticky-hunk-row");
        }
        if (!controller.hunkRow.classList.contains("hunkmark-sticky-hunk-prepared")) {
          controller.hunkRow.classList.add("hunkmark-sticky-hunk-prepared");
        }
      });
      state.preparedControllers.forEach((controller) => {
        if (!preparedControllers.has(controller)) {
          this.clearStickyHunkClipAnimation(controller);
          controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
        }
      });
      state.preparedControllers = preparedControllers;
    },

    updateStickyHunkInteractionState(
      state, controllers, layout = this.prepareStickyHunkState(state, controllers),
    ) {
      this.syncStickyHunkPreparedWindow(state, controllers, layout);
      const { activeIndex, focused } = layout;

      // Within the prepared window scroll-linked animations clip and push;
      // active state only selects the current interaction controls.
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
      if (activeController && !activeController.hunkRow.classList.contains("hunkmark-sticky-hunk-active")) {
        activeController.hunkRow.classList.add("hunkmark-sticky-hunk-active");
      }
    },

    updateStickyHunkState(state) {
      const controllers = this.orderedStickyHunkControllers(state);
      const layout = this.prepareStickyHunkState(state, controllers);
      this.updateStickyHunkInteractionState(state, controllers, layout);
    },

    stickyHunkStateCanPrepareDuringRefresh(
      state,
      { allowPendingPersistence = false } = {},
    ) {
      // Reconciliation can suspend controls after their DOM/order is complete.
      // Before that boundary, only independently usable files may be prepared.
      return !state.orderDirty && Array.from(state.controllers).every(
        (controller) => this.reviewControllerIsCurrent(controller) &&
          (this.refreshStickyLayoutReady ||
            (!this.reviewControllerIsSuspended(controller) &&
              (allowPendingPersistence || !controller.input.disabled))),
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

    updateStickyHunkInteractionsForControllers(
      controllers,
      { allowPendingPersistence = false } = {},
    ) {
      const states = new Set();
      for (const controller of controllers) {
        const state = this.hunkStickyStateByFile.get(controller.fileElement);
        if (
          state?.visible && this.reviewControllerIsCurrent(controller) &&
          (!(this.refreshRunning || this.refreshQueued) ||
            this.stickyHunkStateCanPrepareDuringRefresh(state, {
              allowPendingPersistence,
            }))
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
        this.updateStickyHunkState(state);
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
