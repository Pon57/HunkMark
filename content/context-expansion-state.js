"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    hostContextExpansionIntentsForFile(filePath) {
      return this.activeHostContextExpansionIntents().filter(
        (intent) => intent.filePath === filePath,
      );
    },

    hostContextExpansionIntentOwnsFileElement(
      intent,
      fileElement,
      filePath = null,
    ) {
      return Boolean(
        intent &&
          fileElement instanceof this.window.Element &&
          ((filePath &&
            !filePath.startsWith("unknown-file:") &&
            intent.filePath === filePath) ||
            intent.fileElements?.some(
              (candidate) =>
                candidate === fileElement ||
                candidate?.contains(fileElement) ||
                fileElement.contains(candidate),
            )),
      );
    },

    setHostContextExpansionFileHidden(fileElement, hidden) {
      if (!(fileElement instanceof this.window.Element)) {
        return;
      }
      const filePath =
        this.knownFilePath(fileElement) ??
        this.resolveFilePath(fileElement, 0);
      this.activeHostContextExpansionIntents().forEach((intent) => {
        if (
          this.hostContextExpansionIntentOwnsFileElement(
            intent,
            fileElement,
            filePath,
          )
        ) {
          intent.fileHiddenWhilePending = hidden;
        }
      });
    },

    hostContextExpansionIntentIsActive(intent, now = Date.now()) {
      return Boolean(
        intent &&
        this.hostContextExpansionIntents.has(intent) &&
        intent.reviewScope === this.currentReviewScope &&
        now - intent.createdAt <=
          this.constants.HOST_CONTEXT_EXPANSION_MAX_LIFETIME_MS,
      );
    },


    hostContextExpansionExpandedByHost(previousControllers, hunk) {
      return (
        previousControllers.length > 1 ||
        (previousControllers.length === 1 &&
          hunk.groupRows.length > previousControllers[0].groupRows.length)
      );
    },

    rememberHostContextExpansionAffectedReviews(
      intent,
      previousControllers,
      hunk,
    ) {
      [hunk, ...previousControllers].forEach((candidate) => {
        intent.affectedReviewKeys.add(candidate.key);
        candidate.lines.forEach((line) =>
          intent.affectedReviewKeys.add(line.key),
        );
      });
      intent.phase = "candidate";
    },

    hostContextExpansionIntentAppliesToController(
      intent,
      controller,
      previousControllers,
    ) {
      if (intent.source.expandsWholeFile) {
        return true;
      }

      return [controller, ...previousControllers].some(
        (candidate) =>
          intent.affectedReviewKeys.has(candidate.key) ||
          candidate.lines.some((line) =>
            intent.affectedReviewKeys.has(line.key),
          ),
      );
    },

    hostContextExpansionAssessment(
      hunk,
      previous,
      fileIntents,
      observedIntents,
    ) {
      const activeIntents = fileIntents.filter(
        (intent) => intent.phase === "observed" || observedIntents.has(intent),
      );
      const applicableIntents = activeIntents.filter((intent) =>
        this.hostContextExpansionIntentAppliesToController(
          intent,
          hunk,
          previous,
        ),
      );
      const trustedHostExpansion = applicableIntents.length > 0;
      const stableUnrelated = Boolean(
        !trustedHostExpansion &&
          previous.length === 1 &&
          this.Core.hunkHeadersSemanticallyCompatible(
            previous[0].headerText,
            hunk.headerText,
          ) &&
          this.sameHostContextExpansionSequence(
            previous[0].lines.map((line) => line.key),
            hunk.lines.map((line) => line.key),
          ),
      );
      const expandedByHost =
        this.hostContextExpansionExpandedByHost(previous, hunk);
      return {
        fileIntents,
        hostRevealedRowsCanExpand:
          fileIntents.length === 0 || trustedHostExpansion,
        opensHunk:
          trustedHostExpansion ||
          (expandedByHost && fileIntents.length === 0),
        previous,
        reviewIntents: stableUnrelated
          ? activeIntents
          : applicableIntents,
      };
    },

    hostContextExpansionTransitionObserved(
      intent,
      previousControllers,
      hunk,
    ) {
      if (!intent) {
        return false;
      }
      if (intent.phase === "observed") {
        return false;
      }

      const revealsPreviouslyHiddenFile = Boolean(
        previousControllers.length === 0 &&
          ((intent.origin === "cached" && intent.source.expandsWholeFile) ||
            (intent.fileHiddenWhilePending &&
              (intent.source.expandsWholeFile ||
                intent.source.boundaryLineKeys.some((lineKey) =>
                  hunk.lines.some((line) => line.key === lineKey),
                )))),
      );
      if (revealsPreviouslyHiddenFile) {
        this.rememberHostContextExpansionAffectedReviews(
          intent,
          previousControllers,
          hunk,
        );
      }

      if (
        this.hostContextExpansionExpandedByHost(previousControllers, hunk)
      ) {
        let matchesIntent = intent.source.expandsWholeFile;
        if (!matchesIntent && intent.source.boundaryLineKeys.length > 0) {
          matchesIntent = intent.source.boundaryLineKeys.some((lineKey) => {
            const previousContainsBoundaryLine = previousControllers.some(
              (controller) =>
                controller.lines.some((line) => line.key === lineKey),
            );
            const discoveredContainsBoundaryLine = hunk.lines.some(
              (line) => line.key === lineKey,
            );
            return (
              previousContainsBoundaryLine && discoveredContainsBoundaryLine
            );
          });
        } else if (!matchesIntent) {
          matchesIntent = previousControllers.some(
            (controller) => controller.hunkRow === intent.source.row,
          );
        }
        if (matchesIntent) {
          this.rememberHostContextExpansionAffectedReviews(
            intent,
            previousControllers,
            hunk,
          );
        }
      }

      const fileElements = [
        ...previousControllers.map((controller) => controller.fileElement),
        hunk.fileElement,
      ];
      return Boolean(
        intent.phase === "candidate" &&
          intent.evidence === "matched" &&
          !this.hostContextExpansionSourceControlStillPresent(
            intent,
            fileElements,
          ),
      );
    },

    activeHostContextExpansionIntents(now = Date.now()) {
      const active = [];
      Array.from(this.hostContextExpansionIntents).forEach((intent) => {
        if (this.hostContextExpansionIntentIsActive(intent, now)) {
          active.push(intent);
        } else {
          this.clearHostContextExpansionIntent(intent);
        }
      });
      return active;
    },
  });
}
