"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    compareDragLines(left, right) {
      if (left.element === right.element) {
        return 0;
      }
      return left.element.compareDocumentPosition(right.element) &
        this.window.Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    },

    dragLinesAreInDocumentOrder(lines) {
      for (let index = 1; index < lines.length; index += 1) {
        if (this.compareDragLines(lines[index - 1], lines[index]) > 0) {
          return false;
        }
      }
      return true;
    },

    dragControllerIsRangeVisible(controller) {
      return (
        !controller.collapsed &&
        controller.hunkRow.isConnected &&
        !controller.hunkRow.closest(
          '[hidden], [aria-hidden="true"], details:not([open])',
        )
      );
    },

    orderedLinesForDrag(lineController) {
      let orderedLines = Array.from(this.controllersByRow.values())
        .filter(
          (controller) =>
            controller === lineController.controller ||
            this.dragControllerIsRangeVisible(controller),
        )
        .flatMap((controller) => controller.lines)
        .filter((candidate) => candidate.element.isConnected);
      if (!this.dragLinesAreInDocumentOrder(orderedLines)) {
        orderedLines.sort((left, right) =>
          this.compareDragLines(left, right),
        );
      }
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
      return orderedLines;
    },

    prepareLineDragRange() {
      const state = this.dragState;
      if (!state || state.rangePrepared) {
        return;
      }
      const orderedLines = this.orderedLinesForDrag(state.anchorLine);
      const indexByLine = new Map(
        orderedLines.map((candidate, index) => [candidate, index]),
      );
      const anchorIndex = indexByLine.get(state.anchorLine) ?? -1;
      Object.assign(state, {
        anchorIndex,
        endpointIndex: anchorIndex,
        indexByLine,
        orderedLines,
        rangePrepared: true,
      });
    },

    startLineDrag(lineController, viewed, pointerId) {
      if (
        !this.reviewControllerIsCurrent(lineController.controller) ||
        this.reviewControllerIsSuspended(lineController.controller) ||
        lineController.control?.disabled
      ) {
        return false;
      }
      if (this.dragState) {
        void this.finishLineDrag(true);
      }

      this.dragState = {
        anchorIndex: 0,
        anchorLine: lineController,
        controllers: new Set(),
        endpointIndex: 0,
        indexByLine: new Map([[lineController, 0]]),
        originalControllers: new Map(),
        originalMarks: new Map(),
        orderedLines: [lineController],
        pointerId,
        rangePrepared: false,
        targetViewed: viewed,
        touched: new Set(),
      };
      const control = lineController.control;
      if (control) {
        control.classList.add("hunkmark-line-dragging");
        control.setPointerCapture?.(pointerId);
      }
      this.updateLineDragRange(lineController);
    },

    touchLineRange(lineController) {
      if (!this.dragState) {
        return;
      }
      let endIndex = this.dragState.indexByLine.get(lineController) ?? -1;
      if (endIndex >= 0 && endIndex === this.dragState.endpointIndex) {
        return;
      }
      this.prepareLineDragRange();
      endIndex = this.dragState.indexByLine.get(lineController) ?? -1;
      if (endIndex >= 0 && endIndex === this.dragState.endpointIndex) {
        return;
      }
      this.dragState.endpointIndex = endIndex;
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
            sharedCompletion: candidate.controller.sharedCompletion,
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
      this.updateProgressForControllers(changedControllers);
    },

    restoreDraggedLines(state) {
      state.originalMarks.forEach((marked, lineController) => {
        lineController.marked = marked;
      });
      state.originalControllers.forEach((original, controller) => {
        controller.collapsed = original.collapsed;
        controller.sharedCompletion = original.sharedCompletion;
        this.updateAggregateFromLines(controller);
        this.applyControllerAppearance(controller);
      });
      this.updateProgressForControllers(state.controllers);
    },

    buildLineDragReviewMutation(state) {
      const viewedAt = this.reviewTimestampAfterSharedState(
        state.controllers,
      );
      const values = {};
      const removals = new Set();

      state.touched.forEach((lineController) => {
        if (lineController.marked) {
          values[lineController.key] = this.lineReviewStorageValue(
            lineController,
            viewedAt,
            { dragged: true },
          );
          if (this.cachedLegacyLineReviewMatches(lineController)) {
            removals.add(lineController.legacyKey);
          }
        } else {
          removals.add(lineController.key);
          if (this.cachedLegacyLineReviewMatches(lineController)) {
            removals.add(lineController.legacyKey);
          }
        }
      });
      state.controllers.forEach((controller) => {
        const original = state.originalControllers.get(controller);
        const collapseTransition = this.applyViewedCollapseTransition(
          controller,
          original?.marked ?? controller.marked,
        );
        controller.collapsePending = Boolean(collapseTransition);
        controller.sharedCompletion = Boolean(
          controller.marked && controller.sharedCompletionKey,
        );
        this.applyControllerAppearance(controller);
        removals.add(controller.key);
        if (original?.sharedCompletion && !controller.marked) {
          controller.lines.forEach((line) => {
            if (line.marked) {
              values[line.key] = this.lineReviewStorageValue(
                line,
                viewedAt,
                { dragged: true },
              );
            }
          });
        }
        this.updateSharedHunkCompletionMutation(controller, {
          lines: Array.from(state.touched).filter(
            (line) => line.controller === controller,
          ),
          removals,
          updatedAt: viewedAt,
          values,
        });
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

      return {
        values,
        removals: Array.from(removals),
        scope: this.currentReviewScope,
        now: viewedAt,
      };
    },

    async finishLineDrag(persist) {
      const state = this.dragState;
      if (!state) {
        return;
      }
      this.dragState = null;
      const anchorControl = state.anchorLine.control;
      if (anchorControl) {
        anchorControl.classList.remove("hunkmark-line-dragging");
        if (anchorControl.hasPointerCapture?.(state.pointerId)) {
          anchorControl.releasePointerCapture(state.pointerId);
        }
      }
      state.touched.forEach((lineController) => {
        lineController.element.classList.remove("hunkmark-line-drag-touched");
      });
      if (persist) {
        this.beginReviewAppearancePersistence(state.controllers);
      }
      const officialViewedPendingKeys = persist
        ? this.beginOfficialViewedReviewPersistence(state.controllers)
        : [];
      const navigationGeneration = this.hunkStickyNavigationGeneration;
      const returnTarget = persist
        ? Array.from(state.controllers).find((controller) => {
            const original = state.originalControllers.get(controller);
            return (
              this.autoCollapseViewed &&
              original?.marked === false &&
              controller.marked &&
              controller.hunkRow.classList.contains(
                "hunkmark-sticky-hunk-active",
              )
            );
          }) ?? null
        : null;
      const focusReturnTarget =
        Boolean(returnTarget) &&
        this.stickyHunkOriginFocusTarget(returnTarget);
      let returnScrollPosition = null;
      let reviewStateKnown = true;

      try {
        if (persist) {
          const reviewMutation =
            this.buildLineDragReviewMutation(state);
          if (returnTarget) {
            returnScrollPosition = this.stickyHunkScrollPosition();
          }
          await this.mutateReviewStorageAndReleaseOfficialViewed(
            state.controllers,
            reviewMutation,
          );
          state.controllers.forEach((controller) =>
            this.applyControllerAppearance(controller),
          );
          this.updateProgressForControllers(state.controllers);
        } else {
          this.restoreDraggedLines(state);
        }
      } catch (error) {
        if (persist) {
          reviewStateKnown =
            await this.reconcileReviewControllersAfterFailure(
              state.controllers,
              error,
              "HunkMark could not save dragged line marks.",
            );
        } else if (!this.stopForInvalidatedContext(error)) {
          this.restoreDraggedLines(state);
          console.warn("HunkMark could not save dragged line marks.", error);
        }
      } finally {
        if (persist) {
          this.endReviewAppearancePersistence(state.controllers);
        }
        this.endOfficialViewedReviewPersistence(
          officialViewedPendingKeys,
        );
        if (!this.stopped) {
          state.controllers.forEach((controller) => {
            controller.collapsePending = false;
            this.applyControllerAppearance(controller);
          });
          if (persist && reviewStateKnown) {
            this.syncOfficialViewedForControllers(state.controllers);
          }
          if (
            returnTarget &&
            persist &&
            reviewStateKnown &&
            returnTarget.marked &&
            returnTarget.collapsed
          ) {
            this.scheduleStickyHunkReturn(returnTarget.key, {
              expectedScrollPosition: returnScrollPosition,
              focusTarget: focusReturnTarget,
              navigationGeneration,
            });
          }
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
      const state = this.dragState;
      if (!state) {
        return null;
      }
      if (!state.rangePrepared) {
        const anchorRect = state.anchorLine.element.getBoundingClientRect();
        if (clientY >= anchorRect.top && clientY <= anchorRect.bottom) {
          return state.anchorLine;
        }
      }
      this.prepareLineDragRange();
      if (!this.dragState || this.dragState.anchorIndex < 0) {
        return null;
      }

      const { anchorIndex, orderedLines } = this.dragState;
      const anchor = orderedLines[anchorIndex];
      const anchorRect = anchor.element.getBoundingClientRect();
      let endIndex = anchorIndex;

      if (clientY < anchorRect.top) {
        let low = 0;
        let high = anchorIndex - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const rect =
            orderedLines[middle].element.getBoundingClientRect();
          if (clientY <= rect.bottom) {
            endIndex = middle;
            high = middle - 1;
          } else {
            low = middle + 1;
          }
        }
      } else if (clientY > anchorRect.bottom) {
        let low = anchorIndex + 1;
        let high = orderedLines.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const rect =
            orderedLines[middle].element.getBoundingClientRect();
          if (clientY >= rect.top) {
            endIndex = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
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
}
