"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    handleHostContextExpansionClick(event) {
      if (
        event.isTrusted !== true ||
        event.defaultPrevented === true ||
        (event.button !== undefined && event.button !== 0)
      ) {
        return;
      }
      const target =
        event.target instanceof this.window.Element ? event.target : null;
      const control = target?.closest(
        this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
      );
      if (!control || control.closest("[data-hunkmark-ui]")) {
        return;
      }

      const source = this.describeHostContextExpansionControl(control);
      const controllers = this.hostContextExpansionControllersForControl(
        source,
      );
      const controller = controllers[0];
      const expandsWholeFile = source.expandsWholeFile;
      let filePath = controller?.filePath ?? null;
      let fileElements = [
        ...new Set(controllers.map((candidate) => candidate.fileElement)),
      ];
      let fileLineKeys;
      let fileContextAnchors;
      let lineReviewSnapshot;
      let cachedHunkGroups = null;
      let origin = "live";
      if (controller) {
        const currentControllers = Array.from(this.controllersByRow.values());
        if (
          !this.hostContextExpansionControllersMatchDisplayedFile(filePath)
        ) {
          return;
        }
        const fileSnapshot = this.captureFileReviewSnapshot(
          currentControllers,
          filePath,
        );
        fileLineKeys = fileSnapshot.lineKeys;
        fileContextAnchors = fileSnapshot.contextAnchors;
        lineReviewSnapshot = new Map(
          fileSnapshot.hunks
            .flatMap((hunk) => hunk.lines)
            .map((line) => [line.key, line]),
        );
      } else {
        if (!expandsWholeFile) {
          return;
        }
        // Current React diffs leave Expand all in a collapsed file header
        // after every hunk row and controller has been unmounted. Only reuse
        // the last complete, scope-keyed line snapshot for that exact file.
        const fileElement = source.fileElement;
        if (
          !fileElement ||
          fileElement.matches(this.constants.ROW_CANDIDATE_SELECTOR) ||
          fileElement.querySelector(this.constants.ROW_CANDIDATE_SELECTOR) ||
          fileElement.matches(this.constants.UNRESOLVED_DIFF_SELECTOR) ||
          fileElement.querySelector(
            this.constants.UNRESOLVED_DIFF_SELECTOR,
          )
        ) {
          return;
        }
        const cachedFilePath = this.knownFilePath(fileElement);
        const currentFilePath = this.resolveFilePath(fileElement, 0);
        const controlFilePath = source.filePath;
        if (
          (cachedFilePath &&
            currentFilePath &&
            cachedFilePath !== currentFilePath) ||
          (currentFilePath &&
            controlFilePath &&
            currentFilePath !== controlFilePath)
        ) {
          return;
        }
        filePath = controlFilePath ?? currentFilePath ?? cachedFilePath;
        if (!filePath || filePath.startsWith("unknown-file:")) {
          return;
        }
        const cachedSnapshot = filePath
          ? this.hostContextExpansionCachedFileSnapshot(filePath)
          : null;
        if (!cachedSnapshot) {
          return;
        }
        fileElements = [fileElement];
        cachedHunkGroups = cachedSnapshot.cachedHunkGroups;
        fileContextAnchors = cachedSnapshot.fileContextAnchors;
        fileLineKeys = cachedSnapshot.fileLineKeys;
        lineReviewSnapshot = cachedSnapshot.lineReviewSnapshot;
        origin = "cached";
      }

      this.hostContextExpansionIntentsForFile(filePath).forEach((intent) => {
        if (
          origin === "cached" &&
          expandsWholeFile &&
          (intent.origin === "cached" ||
            intent.fileHiddenWhilePending)
        ) {
          // A hidden file can expose Expand all again after GitHub contracts
          // non-diff lines. The new file-wide activation supersedes every
          // older pending transition for that same hidden DOM.
          this.clearHostContextExpansionIntent(intent);
        }
      });
      const intent = {
        affectedReviewKeys: new Set(),
        capture: Object.freeze({
          cachedHunkGroups,
          contextAnchors: fileContextAnchors,
          lineKeys: fileLineKeys,
          linesByKey: lineReviewSnapshot,
        }),
        createdAt: Date.now(),
        evidence: "matched",
        fileElements,
        fileHiddenWhilePending: false,
        filePath,
        origin,
        phase: "awaiting",
        reviewScope: this.currentReviewScope,
        source: Object.freeze({
          ...source,
          boundaryLineKeys: Object.freeze(
            controllers
              .map((candidate) => candidate.lines[0]?.key)
              .filter(Boolean),
          ),
          row: controller?.hunkRow ?? null,
        }),
        timers: { expiry: null, settlement: null },
      };
      this.hostContextExpansionIntents.add(intent);
      this.scheduleHostContextExpansionExpiry(intent);
    },

    currentHostContextExpansionIntents(previousControllers, discovered) {
      return this.activeHostContextExpansionIntents().filter((intent) => {
        const previousSnapshot = this.captureFileReviewSnapshot(
          previousControllers,
          intent.filePath,
        );
        const discoveredSnapshot = this.captureFileReviewSnapshot(
          discovered,
          intent.filePath,
        );
        const previousLineKeys = previousSnapshot.lineKeys;
        const discoveredLineKeys = discoveredSnapshot.lineKeys;
        const cachedHiddenState = intent.origin === "cached";
        const hiddenWhilePending = intent.fileHiddenWhilePending;
        const mayHaveNoRenderedLines =
          cachedHiddenState || hiddenWhilePending;
        const matchesCapturedLines = (lineKeys) =>
          this.sameHostContextExpansionSequence(
            intent.capture.lineKeys,
            lineKeys,
          ) ||
          (mayHaveNoRenderedLines && lineKeys.length === 0);
        const contextEvidencePreserved =
          this.hostContextExpansionPreservesContextAnchors(
            intent.capture.contextAnchors,
            discoveredSnapshot.contextAnchors,
          );
        const unchanged =
          matchesCapturedLines(previousLineKeys) &&
          matchesCapturedLines(discoveredLineKeys);
        // A collapsed React file has no rendered lines or anchors, so defer
        // that decision until GitHub reveals a complete changed-line set.
        // Once any changed lines are present, a missing/reordered captured
        // anchor revokes the intent even after an earlier render stage was
        // authorized. Otherwise the already-observed intent would let a later
        // unrelated semantic replacement inherit reviewed state.
        const contextEvidenceVerdict = contextEvidencePreserved
          ? "matched"
          : discoveredLineKeys.length > 0
            ? "rejected"
            : "pending";
        const cachedHunksVerdict =
          intent.origin === "cached"
            ? discoveredLineKeys.length > 0
              ? this.hostContextExpansionCachedHunkGroupsVerdict(
                  intent.capture.cachedHunkGroups,
                  discovered,
                  intent.filePath,
                )
              : "pending"
            : "matched";
        intent.evidence =
          contextEvidenceVerdict === "pending" ||
          cachedHunksVerdict === "pending"
            ? "pending"
            : "matched";
        const rejected =
          contextEvidenceVerdict === "rejected" ||
          cachedHunksVerdict === "rejected";
        if (!unchanged || rejected) {
          this.clearHostContextExpansionIntent(intent);
        }
        return unchanged && !rejected;
      });
    },

    hostContextExpansionControllerForLineKey(intent, lineKey) {
      if (!intent || !lineKey) {
        return null;
      }
      for (const controller of this.controllersByRow.values()) {
        if (
          controller.filePath === intent.filePath &&
          this.reviewControllerIsCurrent(controller) &&
          controller.lines.some(
            (candidate) => candidate.key === lineKey,
          )
        ) {
          return controller;
        }
      }
      return null;
    },

    hostContextExpansionCollapsedLayoutAnchor(
      observedIntents,
      previousByHunk,
    ) {
      const candidates = Array.from(observedIntents).reverse();
      for (const intent of candidates) {
        const opensCollapsedRows = Array.from(previousByHunk).some(
          ([hunk, previous]) =>
            hunk.filePath === intent.filePath &&
            previous.some((controller) => controller.collapsed) &&
            this.hostContextExpansionIntentAppliesToController(
              intent,
              hunk,
              previous,
            ),
        );
        const row = intent.source.row;
        if (
          !opensCollapsedRows ||
          !row?.isConnected ||
          row.classList.contains("hunkmark-sticky-hunk-active")
        ) {
          continue;
        }
        const rect = row.getBoundingClientRect?.();
        if (!rect || !Number.isFinite(rect.top) || rect.height <= 0) {
          continue;
        }
        const viewportHeight = Number(this.window.innerHeight);
        const bottom = Number.isFinite(rect.bottom)
          ? rect.bottom
          : rect.top + rect.height;
        if (
          Number.isFinite(viewportHeight) &&
          viewportHeight > 0 &&
          (bottom <= 0 || rect.top >= viewportHeight)
        ) {
          continue;
        }
        return { intent, row, top: rect.top };
      }
      return null;
    },

    restoreHostContextExpansionCollapsedLayout(anchor) {
      if (
        !anchor?.row?.isConnected ||
        anchor.restored === true ||
        !this.hostContextExpansionIntents.has(anchor.intent)
      ) {
        return false;
      }
      anchor.restored = true;
      const rect = anchor.row.getBoundingClientRect?.();
      if (!rect || !Number.isFinite(rect.top) || rect.height <= 0) {
        return false;
      }
      const delta = rect.top - anchor.top;
      if (Math.abs(delta) < 0.5) {
        return true;
      }
      if (typeof this.window.scrollBy === "function") {
        this.window.scrollBy({ behavior: "auto", left: 0, top: delta });
        return true;
      }
      return false;
    },

    hostContextExpansionSettlementReady(intent) {
      if (intent?.phase !== "observed") {
        return false;
      }
      const fileControllers = Array.from(
        this.controllersByRow.values(),
      ).filter(
        (controller) =>
          controller.filePath === intent.filePath &&
          this.reviewControllerIsCurrent(controller),
      );
      const fileElements = [
        ...new Set(fileControllers.map((controller) => controller.fileElement)),
      ].filter((fileElement) => fileElement?.isConnected);
      if (
        fileElements.length === 0 ||
        fileElements.some((fileElement) =>
          fileElement.matches(this.constants.ACTIVE_DIFF_LOADING_SELECTOR) ||
          fileElement.querySelector(
            this.constants.ACTIVE_DIFF_LOADING_SELECTOR,
          ),
        )
      ) {
        return false;
      }

      if (
        this.hostContextExpansionSourceControlStillPresent(
          intent,
          fileElements,
        )
      ) {
        return false;
      }

      if (intent.source.expandsWholeFile) {
        return fileElements.every(
          (fileElement) =>
            !fileElement.querySelector(
              this.constants.HUNK_EXPANSION_CONTROL_SELECTOR,
            ),
        );
      }

      const settlementLineKey =
        intent.source.boundaryLineKeys[0] ??
        intent.capture.lineKeys[0] ??
        null;
      return (
        !settlementLineKey ||
        Boolean(
          this.hostContextExpansionControllerForLineKey(
            intent,
            settlementLineKey,
          ),
        )
      );
    },

    cancelHostContextExpansionSettlement(intent) {
      if (intent && intent.timers.settlement !== null) {
        this.window.clearTimeout(intent.timers.settlement);
        intent.timers.settlement = null;
      }
    },

    cancelHostContextExpansionExpiry(intent) {
      if (intent && intent.timers.expiry !== null) {
        this.window.clearTimeout(intent.timers.expiry);
        intent.timers.expiry = null;
      }
    },

    scheduleHostContextExpansionExpiry(intent) {
      if (
        !intent || !this.hostContextExpansionIntents.has(intent)
      ) {
        return false;
      }
      this.cancelHostContextExpansionExpiry(intent);
      const remainingLifetime =
        this.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS -
        Math.max(0, Date.now() - intent.createdAt);
      if (remainingLifetime <= 0) {
        this.clearHostContextExpansionIntent(intent);
        return false;
      }
      intent.timers.expiry = this.window.setTimeout(() => {
        intent.timers.expiry = null;
        if (this.hostContextExpansionIntents.has(intent)) {
          this.clearHostContextExpansionIntent(intent);
        }
      }, remainingLifetime);
      return true;
    },

    scheduleHostContextExpansionSettlement(intent) {
      if (!this.hostContextExpansionIntents.has(intent)) {
        return;
      }
      this.cancelHostContextExpansionSettlement(intent);
      intent.timers.settlement = this.window.setTimeout(() => {
        intent.timers.settlement = null;
        if (!this.hostContextExpansionIntents.has(intent)) {
          return;
        }
        if (this.refreshRunning || this.refreshQueued) {
          this.scheduleHostContextExpansionSettlement(intent);
          return;
        }
        this.clearHostContextExpansionIntent(intent);
      }, this.constants.HOST_CONTEXT_EXPANSION_SETTLE_MS);
    },

    clearHostContextExpansionIntent(intent) {
      if (!intent) {
        return;
      }
      this.hostContextExpansionIntents.delete(intent);
      this.cancelHostContextExpansionSettlement(intent);
      this.cancelHostContextExpansionExpiry(intent);
    },

    clearAllHostContextExpansionIntents() {
      Array.from(this.hostContextExpansionIntents).forEach((intent) =>
        this.clearHostContextExpansionIntent(intent),
      );
    },
  });
}
