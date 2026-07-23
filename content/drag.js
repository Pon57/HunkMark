(function attachHunkMarkDrag(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    startLineDrag(lineController, viewed, pointerId) {
      if (this.dragState) {
        void this.finishLineDrag(true);
      }

      let orderedLines = Array.from(
        this.document.querySelectorAll(".hunkmark-line-cell"),
      )
        .map((element) => this.lineControllersByElement.get(element))
        .filter(
          (candidate) =>
            candidate && candidate.element.getClientRects().length > 0,
        );
      if (
        lineController.controller.split &&
        lineController.side !== "unified"
      ) {
        orderedLines = orderedLines.filter(
          (candidate) =>
            candidate.side === lineController.side ||
            candidate.side === "unified" ||
            (this.linkSplitSides && candidate.peers.length === 0),
        );
      }
      this.dragState = {
        anchorIndex: orderedLines.indexOf(lineController),
        controllers: new Set(),
        originalControllers: new Map(),
        originalMarks: new Map(),
        orderedLines,
        pointerId,
        targetViewed: viewed,
        touched: new Set(),
      };
      this.document.body.classList.add("hunkmark-line-dragging");
      this.updateLineDragRange(lineController);
    },

    touchLineRange(lineController) {
      if (!this.dragState) {
        return;
      }
      const endIndex = this.dragState.orderedLines.indexOf(lineController);
      let rangeLines = [lineController];
      if (this.dragState.anchorIndex < 0 || endIndex < 0) {
        this.updateLineDragRange(lineController);
      } else {
        const start = Math.min(this.dragState.anchorIndex, endIndex);
        const end = Math.max(this.dragState.anchorIndex, endIndex);
        rangeLines = this.dragState.orderedLines.slice(start, end + 1);
        this.updateLineDragRange(rangeLines);
      }
    },

    updateLineDragRange(range) {
      if (!this.dragState) {
        return;
      }

      const rangeLines = Array.isArray(range) ? range : [range];
      const nextTouched = new Set();
      rangeLines.forEach((lineController) => {
        this.interactionLines(lineController).forEach((candidate) => {
          nextTouched.add(candidate);
        });
      });

      const changedControllers = new Set(this.dragState.controllers);
      this.dragState.touched.forEach((candidate) => {
        if (!nextTouched.has(candidate)) {
          candidate.marked = this.dragState.originalMarks.get(candidate);
          candidate.element.classList.remove("hunkmark-line-drag-touched");
          changedControllers.add(candidate.controller);
        }
      });

      nextTouched.forEach((candidate) => {
        if (!this.dragState.originalControllers.has(candidate.controller)) {
          this.dragState.originalControllers.set(candidate.controller, {
            collapsed: candidate.controller.collapsed,
            marked: candidate.controller.marked,
          });
        }
        if (!this.dragState.originalMarks.has(candidate)) {
          this.dragState.originalMarks.set(candidate, candidate.marked);
        }
        candidate.marked = this.dragState.targetViewed;
        candidate.element.classList.add("hunkmark-line-drag-touched");
        changedControllers.add(candidate.controller);
      });

      this.dragState.touched = nextTouched;
      this.dragState.controllers = new Set(
        Array.from(nextTouched, (candidate) => candidate.controller),
      );
      changedControllers.forEach((controller) => {
        this.updateAggregateFromLines(controller);
        this.applyControllerAppearance(controller);
      });
      this.updateProgress();
    },

    restoreDraggedLines(state) {
      state.originalMarks.forEach((marked, lineController) => {
        lineController.marked = marked;
      });
      state.originalControllers.forEach((original, controller) => {
        controller.collapsed = original.collapsed;
        this.updateAggregateFromLines(controller);
        this.applyControllerAppearance(controller);
      });
      this.updateProgress();
    },

    async persistLineDrag(state) {
      const viewedAt = Date.now();
      const values = {};
      const removals = new Set();

      state.touched.forEach((lineController) => {
        if (lineController.marked) {
          values[lineController.key] = this.lineReviewStorageValue(
            lineController,
            viewedAt,
            { dragged: true },
          );
        } else {
          removals.add(lineController.key);
        }
      });
      state.controllers.forEach((controller) => {
        const original = state.originalControllers.get(controller);
        const collapseTransition = this.applyViewedCollapseTransition(
          controller,
          original?.marked ?? controller.marked,
        );
        controller.collapsePending = Boolean(collapseTransition);
        this.applyControllerAppearance(controller);
        removals.add(controller.key);
        if (collapseTransition === "collapse") {
          values[controller.collapsedKey] = {
            autoCollapsed: true,
            collapsed: true,
            updatedAt: viewedAt,
          };
        } else if (collapseTransition === "expand") {
          removals.add(controller.collapsedKey);
        }
      });
      Object.keys(values).forEach((key) => removals.delete(key));

      if (Object.keys(values).length > 0) {
        await this.setReviewStorage(
          values,
          this.currentReviewScope,
          viewedAt,
        );
      }
      if (removals.size > 0) {
        await this.chrome.storage.local.remove(Array.from(removals));
      }
    },

    async finishLineDrag(persist) {
      const state = this.dragState;
      if (!state) {
        return;
      }
      this.dragState = null;
      this.document.body.classList.remove("hunkmark-line-dragging");
      state.touched.forEach((lineController) => {
        lineController.element.classList.remove("hunkmark-line-drag-touched");
      });

      try {
        if (persist) {
          await this.persistLineDrag(state);
          this.releaseOfficialViewedSuppression(state.controllers);
          state.controllers.forEach((controller) =>
            this.applyControllerAppearance(controller),
          );
          this.updateProgress();
          this.syncOfficialViewedForControllers(state.controllers);
        } else {
          this.restoreDraggedLines(state);
        }
      } catch (error) {
        if (!this.stopForInvalidatedContext(error)) {
          this.restoreDraggedLines(state);
          console.warn("HunkMark could not save dragged line marks.", error);
        }
      } finally {
        if (!this.stopped) {
          state.controllers.forEach((controller) => {
            controller.collapsePending = false;
            this.applyControllerAppearance(controller);
          });
          this.window.setTimeout(() => {
            state.touched.forEach((lineController) => {
              lineController.suppressPointerClick = false;
            });
          }, 0);
        }
      }
    },

    lineDragPointerMove(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
        return;
      }
      event.preventDefault();

      const lineController = this.dragEndpointAtY(event.clientY);
      if (lineController) {
        this.touchLineRange(lineController);
      }

      const edgeSize = 52;
      if (event.clientY < edgeSize) {
        this.window.scrollBy(0, -24);
      } else if (event.clientY > this.window.innerHeight - edgeSize) {
        this.window.scrollBy(0, 24);
      }
    },

    dragEndpointAtY(clientY) {
      if (!this.dragState || this.dragState.anchorIndex < 0) {
        return null;
      }

      const { anchorIndex, orderedLines } = this.dragState;
      const anchor = orderedLines[anchorIndex];
      const anchorRect = anchor.element.getBoundingClientRect();
      let endIndex = anchorIndex;

      if (clientY < anchorRect.top) {
        for (let index = anchorIndex - 1; index >= 0; index -= 1) {
          const rect = orderedLines[index].element.getBoundingClientRect();
          if (clientY > rect.bottom) {
            break;
          }
          endIndex = index;
        }
      } else if (clientY > anchorRect.bottom) {
        for (
          let index = anchorIndex + 1;
          index < orderedLines.length;
          index += 1
        ) {
          const rect = orderedLines[index].element.getBoundingClientRect();
          if (clientY < rect.top) {
            break;
          }
          endIndex = index;
        }
      }

      return orderedLines[endIndex];
    },

    lineDragPointerEnd(event) {
      if (
        this.dragState &&
        event.pointerId === this.dragState.pointerId
      ) {
        void this.finishLineDrag(event.type === "pointerup");
      }
    },
  });
})(globalThis);
