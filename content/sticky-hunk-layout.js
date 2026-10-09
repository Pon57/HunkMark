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
      this.unobserveStickyHunkContent(controller);
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
      controller.hunkRow.style.removeProperty("--hunkmark-sticky-scroll-extent");
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

    syncStickyHunkScrollExtent() {
      const scroller = this.document.scrollingElement ?? this.document.documentElement;
      const extent = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      if (this.hunkStickyScrollExtent === extent) return;
      this.hunkStickyScrollExtent = extent;
      // Inherited properties on <html> invalidate the entire GitHub diff. Only
      // prepared headers consume this metric; keep invalidation inside them.
      for (const state of this.hunkStickyVisibleStates) {
        for (const controller of state.preparedControllers) {
          setPixelStyle(controller.hunkRow, "--hunkmark-sticky-scroll-extent", extent);
        }
      }
      if (this.document.documentElement.style.getPropertyValue("--hunkmark-sticky-scroll-extent")) {
        this.document.documentElement.style.removeProperty("--hunkmark-sticky-scroll-extent");
      }
    },

    prepareStickyHunkState(state, controllers) {
      this.syncStickyHunkScrollExtent();
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
        const focused = this.focusedStickyHunkController(state);
        const preparedControllers = new Set(controllers.slice(first, last + 1));
        if (focused) preparedControllers.add(focused);
        const naturalTops = new Map();
        for (const controller of preparedControllers) {
          naturalTops.set(controller, naturalTopFor(controller));
          contentFor(controller);
          // The following hunk determines this row's push-off, even when it
          // falls outside the prepared window or follows an isolated focus.
          const next = controllers[controller.stickyHunkOrderIndex + 1];
          if (next) naturalTops.set(next, naturalTopFor(next));
        }
        this.applyStickyHunkStateMeasurements(state, contentMeasurements);
        for (const controller of preparedControllers) {
          this.syncStickyHunkTimelineRanges(
            controller, naturalTops.get(controller),
            naturalTops.get(controllers[controller.stickyHunkOrderIndex + 1]), state.fileOriginDocumentTop,
          );
        }
        return { activeIndex, preparedControllers, focused };
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
      setPixelStyle(controller.hunkRow, "--hunkmark-sticky-scroll-extent", this.hunkStickyScrollExtent);
      setPixelStyles(controller.hunkRow, [
        ["--hunkmark-sticky-hunk-auxiliary-start", start],
        ["--hunkmark-sticky-hunk-auxiliary-end", start + (inset > 0 ? inset : AUXILIARY_FADE_DISTANCE_PX)],
        ["--hunkmark-sticky-hunk-push-distance", distance],
        ["--hunkmark-sticky-hunk-push-start", Math.max(0, pushEnd - distance)],
        ["--hunkmark-sticky-hunk-push-end", pushEnd],
      ]);
      if (nextTop === undefined) {
        if (controller.hunkRow.style.getPropertyValue("--hunkmark-sticky-hunk-return-end")) {
          controller.hunkRow.style.removeProperty("--hunkmark-sticky-hunk-return-end");
        }
      } else {
        setPixelStyle(controller.hunkRow, "--hunkmark-sticky-hunk-return-end", pushEnd);
      }
      const tailRoom = controller.hunkRow.classList.contains("hunkmark-sticky-hunk-tail-constrained")
        ? controller.stickyHunkTailRoom ?? 0 : bottomInset;
      const compensation = Math.max(0, bottomInset - tailRoom);
      setPixelStyle(controller.hunkRow, "--hunkmark-sticky-hunk-tail-compensation", compensation);
      this.observeStickyHunkContent(controller);
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

    syncStickyHunkPreparedWindow(state, { preparedControllers }) {
      // Keep a viewport of margin, the preceding pinned row and the next
      // push-off boundary. Offscreen rows have no referenced animations.
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
          this.unobserveStickyHunkContent(controller);
          controller.hunkRow.classList.remove("hunkmark-sticky-hunk-prepared");
          controller.hunkRow.style.removeProperty("--hunkmark-sticky-scroll-extent");
        }
      });
      state.preparedControllers = preparedControllers;
    },

    updateStickyHunkInteractionState(
      state, controllers, layout = this.prepareStickyHunkState(state, controllers),
    ) {
      this.syncStickyHunkPreparedWindow(state, layout);
      const { activeIndex, focused } = layout;

      // Visual state follows the scroll timeline. Keep a snapshot only for
      // activation handlers and keyboard return-focus handoffs.
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
        if (returnButtonHadFocus && activeController?.returnButton) {
          this.focusStickyHunkWithoutReveal(activeController, activeController.returnButton);
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
      // Scroll offsets and viewport sizes can flush pending animation styles,
      // just like element geometry. Capture all marker measurements before
      // preparing rows; their sticky transforms do not change document flow.
      const viewport = this.hunkStickyFileVisibilityObserver ? {
        scrollY: Number(this.window.scrollY) || 0,
        scrollX: Number(this.window.scrollX) || 0,
        height: this.window.innerHeight,
        width: this.window.innerWidth,
        documentHeight: this.document.documentElement.offsetHeight,
      } : null;
      if (
        !allowDuringRefresh &&
        (this.refreshRunning || this.refreshQueued)
      ) {
        this.updateStickyHunkInteractions();
        this.observeStickyHunkWindow(viewport);
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
      this.observeStickyHunkWindow(viewport);
    },
  });
})(globalThis);
