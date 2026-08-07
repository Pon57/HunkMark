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
    PUSH_CLASSES,
    PUSH_STYLES,
    TIMELINE_CLASSES,
    TIMELINE_STYLES,
    clearClasses,
    clearStyles,
    setAnimationPhase,
    setPixelStyles,
  } = Sticky;

  Object.assign(App.prototype, {
    clearStickyHunkTimeline(controller) {
      if (!controller) {
        return;
      }
      clearClasses(controller.hunkRow, TIMELINE_CLASSES);
      clearStyles(controller.hunkRow, TIMELINE_STYLES);
    },

    syncStickyHunkTimeline(state, controller, naturalDocumentTop = null) {
      const changed = state.timelineController !== controller;
      if (changed) {
        this.clearStickyHunkTimeline(state.timelineController);
        state.timelineController = controller;
        if (controller) {
          state.timelinePhase = state.timelinePhase === "a" ? "b" : "a";
        }
      }
      if (!controller) {
        return;
      }

      const row = controller.hunkRow;
      if (changed) {
        setAnimationPhase(
          row,
          "hunkmark-sticky-hunk-compressing",
          "hunkmark-sticky-hunk-phase",
          state.timelinePhase,
        );
      }
      const resolvedNaturalDocumentTop = Number.isFinite(naturalDocumentTop)
        ? naturalDocumentTop
        : this.stickyHunkNaturalDocumentTop(controller);
      const inset = Math.max(0, controller.stickyHunkContentInset ?? 0);
      const bottomInset = Math.max(
        0,
        controller.stickyHunkBottomInset ?? 0,
      );
      const naturalTimelineStart =
        resolvedNaturalDocumentTop - (state.stickyTop ?? 0);
      const topStart = Math.max(0, naturalTimelineStart);
      const topEnd = topStart + Math.max(inset, 1);
      const tailStart = Math.max(0, naturalTimelineStart + inset);
      const auxiliaryStart = Math.max(0, naturalTimelineStart);
      setPixelStyles(row, [
        ["--hunkmark-sticky-hunk-compress-start", topStart],
        ["--hunkmark-sticky-hunk-compress-end", topEnd],
        ["--hunkmark-sticky-hunk-tail-start", tailStart],
        ["--hunkmark-sticky-hunk-tail-end", tailStart + Math.max(bottomInset, 1)],
        ["--hunkmark-sticky-hunk-auxiliary-start", auxiliaryStart],
        [
          "--hunkmark-sticky-hunk-auxiliary-end",
          auxiliaryStart +
            (inset > 0 ? inset : AUXILIARY_FADE_DISTANCE_PX),
        ],
      ]);
    },

    clearStickyHunkPushTimeline(controller) {
      if (!controller) {
        return;
      }
      clearClasses(controller.hunkRow, PUSH_CLASSES);
      clearStyles(controller.hunkRow, PUSH_STYLES);
    },

    syncStickyHunkPushTimeline(
      state,
      activeController,
      incomingController,
      incomingNaturalDocumentTop = null,
    ) {
      const pushController =
        activeController && incomingController ? activeController : null;
      const pushIncomingController = pushController
        ? incomingController
        : null;
      const changed =
        state.pushController !== pushController ||
        state.pushIncomingController !== pushIncomingController;
      if (changed) {
        this.clearStickyHunkPushTimeline(state.pushController);
        state.pushController = pushController;
        state.pushIncomingController = pushIncomingController;
        if (pushController) {
          state.pushPhase = state.pushPhase === "a" ? "b" : "a";
        }
      }
      if (!pushController) {
        return;
      }

      const row = pushController.hunkRow;
      const distance = Math.max(
        1,
        pushController.stickyHunkCompactHeight ??
          this.constants.STICKY_HUNK_HEIGHT_PX,
      );
      const resolvedIncomingDocumentTop = Number.isFinite(
        incomingNaturalDocumentTop,
      )
        ? incomingNaturalDocumentTop
        : this.stickyHunkNaturalDocumentTop(pushIncomingController);
      const end = Math.max(
        0,
        resolvedIncomingDocumentTop - (state.stickyTop ?? 0),
      );
      if (changed) {
        setAnimationPhase(
          row,
          "hunkmark-sticky-hunk-pushing",
          "hunkmark-sticky-hunk-push-phase",
          state.pushPhase,
        );
      }
      setPixelStyles(row, [
        ["--hunkmark-sticky-hunk-push-distance", distance],
        ["--hunkmark-sticky-hunk-push-start", Math.max(0, end - distance)],
        ["--hunkmark-sticky-hunk-push-end", end],
      ]);
    },

    updateStickyHunkState(state) {
      const controllers = this.orderedStickyHunkControllers(state);
      const orderChanged = state.orderChanged;
      const originLayoutGeneration = state.originLayoutGeneration;
      const stickyTop = state.stickyTop ?? 0;
      const contentMeasurements = new Map();
      const contentMetricsFor = (controller) =>
        this.stickyHunkContentMetrics(
          state,
          controller,
          contentMeasurements,
        );
      const naturalTops = new Map();
      const naturalTopFor = (controller) => {
        if (!naturalTops.has(controller)) {
          const refreshLayout =
            controller.stickyHunkOriginLayoutGeneration !==
            originLayoutGeneration;
          naturalTops.set(
            controller,
            this.stickyHunkNaturalViewportTop(controller, {
              originLayoutGeneration,
              refreshLayout,
            }),
          );
        }
        return naturalTops.get(controller);
      };
      let activeIndex = -1;
      let low = 0;
      let high = controllers.length - 1;
      while (low <= high) {
        const index = Math.floor((low + high) / 2);
        const controller = controllers[index];
        const inset = contentMetricsFor(controller).inset;
        if (naturalTopFor(controller) + inset <= stickyTop) {
          activeIndex = index;
          low = index + 1;
        } else {
          high = index - 1;
        }
      }

      const activeController = controllers[activeIndex] ?? null;
      const approachingController = controllers[activeIndex + 1] ?? null;
      const approachingInset = Math.max(
        0,
        approachingController
          ? contentMetricsFor(approachingController).inset
          : 0,
      );
      const preStickyController =
        approachingController &&
        approachingInset > 0 &&
        naturalTopFor(approachingController) <= stickyTop
          ? approachingController
          : null;
      const activeMetrics = activeController
        ? contentMetricsFor(activeController)
        : { bottomInset: 0, inset: 0 };
      const activeInset = Math.max(0, activeMetrics.inset);
      const postStickyController =
        activeController &&
        activeInset === 0 &&
        activeController.stickyHunkHasAuxiliaryElements &&
        naturalTopFor(activeController) >=
          stickyTop - AUXILIARY_FADE_DISTANCE_PX
          ? activeController
          : null;
      const compressingController =
        preStickyController ?? postStickyController;
      const scrollY = Number(this.window.scrollY) || 0;
      const documentTopFor = (controller) =>
        controller ? naturalTopFor(controller) + scrollY : null;
      const approachingDocumentTop = documentTopFor(approachingController);
      const compressingDocumentTop = documentTopFor(compressingController);
      const tailController =
        activeController && activeMetrics.bottomInset > 0
          ? activeController
          : null;
      const tailDocumentTop = documentTopFor(tailController);
      this.applyStickyHunkStateMeasurements(state, contentMeasurements);

      if (state.candidateController !== approachingController) {
        state.candidateController?.hunkRow.classList.remove(
          "hunkmark-sticky-hunk-candidate",
        );
        approachingController?.hunkRow.classList.add(
          "hunkmark-sticky-hunk-candidate",
        );
        state.candidateController = approachingController;
      }

      if (state.activeController !== activeController || orderChanged) {
        const previousActiveController = state.activeController;
        const returnButtonHadFocus =
          previousActiveController?.returnButton ===
          this.document.activeElement;
        const movedForward = Boolean(
          previousActiveController &&
          activeController &&
          previousActiveController !== activeController &&
          previousActiveController.hunkRow.isConnected &&
          activeController.hunkRow.isConnected &&
          (previousActiveController.hunkRow.compareDocumentPosition(
            activeController.hunkRow,
          ) & this.window.Node.DOCUMENT_POSITION_FOLLOWING),
        );
        // Only the immediately outgoing row can overlap the incoming row.
        state.pastController?.hunkRow.classList.remove(
          "hunkmark-sticky-hunk-past",
        );
        state.pastController = null;
        if (state.activeController !== activeController) {
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
        }
        if (movedForward) {
          previousActiveController.hunkRow.classList.add(
            "hunkmark-sticky-hunk-past",
          );
          state.pastController = previousActiveController;
        }
        state.activeController = activeController;
      }
      state.orderChanged = false;

      this.syncStickyHunkPushTimeline(
        state,
        activeController,
        approachingController,
        approachingDocumentTop,
      );
      this.syncStickyHunkTimeline(
        state,
        compressingController ?? tailController,
        compressingController
          ? compressingDocumentTop
          : tailDocumentTop,
      );
    },

    updateStickyHunkLayouts() {
      const states = this.hunkStickyFileVisibilityObserver
        ? this.hunkStickyVisibleStates
        : this.hunkStickyStateByFile.values();
      for (const state of states) {
        this.updateStickyHunkState(state);
      }
    },
  });
})(globalThis);
