"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    async reconcileNewReviewControllers({
      expansionAssessmentByController,
      newControllers,
    }) {
      if (newControllers.length === 0) {
        return true;
      }
      const enableControllerReviewControls = (controller) => {
        if (!this.reviewControllerIsCurrent(controller)) {
          return;
        }
        controller.input.disabled = false;
        controller.lines.forEach((line) => {
          if (line.control) {
            line.control.disabled = false;
          }
        });
        this.applyControllerAppearance(controller);
      };
      const failClosedControllerReviewControls = (controller) => {
        if (!this.reviewControllerIsCurrent(controller)) {
          return;
        }
        controller.collapsed = false;
        controller.marked = false;
        controller.indeterminate = false;
        controller.input.disabled = true;
        controller.lines.forEach((line) => {
          line.marked = false;
          if (line.control) {
            line.control.disabled = true;
          }
        });
        this.applyControllerAppearance(controller);
      };
      const suppressionIntentGenerationByKey = new Map(
        newControllers.map((controller) => [
          controller.officialSuppressionKey,
          this.officialViewedIntentGenerationByKey.get(
            controller.officialSuppressionKey,
          ),
        ]),
      );
      const keys = [
        ...new Set(
          newControllers.flatMap((controller) => [
            ...controller.reviewKeys,
            controller.officialSuppressionKey,
          ]),
        ),
      ];
      let migrationError = null;
      await this.withReviewStorageLock(async () => {
        const stored = await this.getLocalStorage(keys);
        const migrations = {};
        const migrationRemovals = new Set();
        const migrationTime = Date.now();

        newControllers.forEach((controller) => {
          const assessment = expansionAssessmentByController.get(controller);
          const previous = assessment.previous;
          const previousLineMarks = new Map(
            previous.flatMap((candidate) =>
              candidate.lines.map((line) => [
                line.key,
                {
                  baselineContextFingerprint:
                    this.hostContextExpansionBaselineContext(line),
                  contextFingerprint: line.contextFingerprint,
                  marked: line.marked,
                },
              ]),
            ),
          );
          const hunkStored =
            controller.lines.length === 0 &&
            Boolean(stored[controller.key]);
          const trustedReviewExpansionIntents = assessment.reviewIntents;
          const trustedReviewExpansion =
            trustedReviewExpansionIntents.length > 0;
          const hostExpansionOpensHunk = assessment.opensHunk;
          const suppressionKey = controller.officialSuppressionKey;
          if (
            this.officialViewedIntentGenerationByKey.get(suppressionKey) ===
            suppressionIntentGenerationByKey.get(suppressionKey)
          ) {
            const generation =
              this.createOfficialViewedIntentGeneration();
            this.registerOfficialViewedIntent(
              [suppressionKey],
              generation,
            );
            this.applyOfficialViewedIntent(
              [suppressionKey],
              Boolean(stored[suppressionKey]),
              generation,
            );
          }
          const previousControllersStayedCollapsed = Boolean(
            previous.length > 0 &&
              previous.every((candidate) => candidate.collapsed),
          );
          controller.collapsed = Boolean(
            !hostExpansionOpensHunk &&
              (stored[controller.collapsedKey] ||
                previousControllersStayedCollapsed),
          );
          controller.marked = hunkStored;
          let invalidatedLineReview = false;
          let preservedLineReviewForOtherContext = false;
          controller.lines.forEach((line) => {
            const storedLineReview = stored[line.key];
            this.adoptStoredLineReviewBaselineContext(
              line,
              storedLineReview,
            );
            const previousLine = previousLineMarks.get(line.key);
            const previousBaseline = this.reviewContextAlias(
              line.contextFingerprint,
              [previousLine?.baselineContextFingerprint],
            );
            if (
              previousLine?.contextFingerprint === line.contextFingerprint &&
              previousBaseline
            ) {
              // GitHub can rebuild an unchanged expanded hunk after another
              // tab writes the contracted fingerprint. Carry forward only
              // an already validated alias for the exact same semantic DOM.
              line.hostContextExpansionBaselineContextFingerprint =
                previousBaseline;
            }
            const storedMatches = this.storedLineReviewMatches(
              line,
              storedLineReview,
            );
            const capturedLines = trustedReviewExpansionIntents.map(
              (intent) => intent.capture.linesByKey.get(line.key),
            );
            const validatedBaselineContextFingerprint =
              trustedReviewExpansion
                ? this.reviewContextAlias(
                    line.contextFingerprint,
                    capturedLines.map(
                      (candidate) =>
                        candidate?.baselineContextFingerprint ??
                        candidate?.contextFingerprint,
                    ),
                  )
                : null;
            if (validatedBaselineContextFingerprint) {
              line.hostContextExpansionBaselineContextFingerprint =
                validatedBaselineContextFingerprint;
            }
            const trustedExpansionMatches =
              trustedReviewExpansion &&
              ((previousLine?.marked === true &&
                this.storedLineReviewMatches(
                  previousLine,
                  storedLineReview,
                )) ||
                capturedLines.some(
                  (candidate) =>
                    candidate &&
                    this.storedLineReviewMatches(
                      candidate,
                      storedLineReview,
                    ),
                ));
            const storedBaselineContextFingerprint =
              this.storedLineReviewBaselineContext(storedLineReview);
            const needsValidatedBaseline = Boolean(
              trustedReviewExpansion &&
                validatedBaselineContextFingerprint &&
                storedLineReview?.contextFingerprint ===
                  line.contextFingerprint &&
                !this.reviewContextAlias(line.contextFingerprint, [
                  storedBaselineContextFingerprint,
                ]),
            );
            // Review writes and refresh migration share the storage lock.
            // A matching value from this read is authoritative even when a
            // contracted tab committed it after activation and its storage
            // event reached the replacement controller before the baseline
            // alias was attached. Conversely, a missing value means an
            // optimistic mark did not commit and must not be resurrected
            // from a reused GitHub line element.
            line.marked = storedMatches || trustedExpansionMatches;
            if (
              storedLineReview !== undefined &&
              !storedMatches &&
              !trustedExpansionMatches
            ) {
              invalidatedLineReview = true;
              if (this.storedLineReviewHasContext(storedLineReview)) {
                preservedLineReviewForOtherContext = true;
              } else {
                migrationRemovals.add(line.key);
              }
            }
            if (
              line.marked &&
              (!storedMatches || needsValidatedBaseline)
            ) {
              // GitHub contracts native context again on reload. Preserve
              // the original trusted fingerprint as one bounded alias. A
              // line first reviewed during a staged render already has the
              // expanded primary fingerprint, but still needs this alias
              // once the source-control transition validates the expansion.
              migrations[line.key] = this.lineReviewStorageValue(
                line,
                migrationTime,
                {
                  baselineContextFingerprint:
                    validatedBaselineContextFingerprint,
                },
              );
            }
          });
          this.updateAggregateFromLines(controller);
          if (invalidatedLineReview) {
            controller.collapsed = false;
            if (!preservedLineReviewForOtherContext) {
              migrationRemovals.add(controller.collapsedKey);
            }
          }
          if (
            hostExpansionOpensHunk &&
            !preservedLineReviewForOtherContext
          ) {
            migrationRemovals.add(controller.collapsedKey);
            previous.forEach((candidate) =>
              migrationRemovals.add(candidate.collapsedKey),
            );
          }
        });

        Object.keys(migrations).forEach((key) =>
          migrationRemovals.delete(key),
        );
        await this.mutateReviewStorageUnlocked({
          values: migrations,
          removals: Array.from(migrationRemovals),
          scope: this.currentReviewScope,
          now: migrationTime,
        });
      }).catch((error) => {
        migrationError = error;
      });
      if (migrationError) {
        const reconciled =
          await this.reconcileReviewControllersAfterFailure(
            newControllers,
            migrationError,
            "HunkMark could not preserve review state after GitHub updated the diff.",
          );
        if (this.stopped) {
          return false;
        }
        if (reconciled) {
          newControllers.forEach(enableControllerReviewControls);
        } else {
          newControllers.forEach(failClosedControllerReviewControls);
        }
      } else {
        newControllers.forEach(enableControllerReviewControls);
      }
      return true;
    },
  });
}
