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
      const openedSharedCompletionKeys = new Set(
        newControllers.flatMap((controller) => {
          const assessment = expansionAssessmentByController.get(controller);
          controller.sharedCompletionSources =
            this.contextExpansionSharedCompletionSources(
              controller,
              assessment,
            );
          controller.reviewKeys = Object.freeze([
            ...new Set([
              ...controller.reviewKeys,
              ...this.sharedHunkCompletionSourceKeys(controller),
            ]),
          ]);
          return assessment?.opensHunk
            ? controller.sharedCompletionSources.map((source) => source.key)
            : [];
        }),
      );
      const keys = [
        ...new Set([
          ...newControllers.flatMap((controller) => [
            ...controller.reviewKeys,
            controller.officialSuppressionKey,
          ]),
          ...openedSharedCompletionKeys,
        ]),
      ];
      let migrationError = null;
      let migrationReadCompleted = false;
      await this.withReviewStorageLock(async () => {
        const stored = await this.getLocalStorage(keys);
        migrationReadCompleted = true;
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
          let sharedCompletionValue = controller.sharedCompletionKey
            ? stored[controller.sharedCompletionKey]
            : null;
          let sharedSourceInvalidatesCollapse = false;
          let sourceLineClearedAtByKey = new Map();
          if (controller.sharedCompletionKey) {
            const sourceInvalidation =
              this.sharedHunkCompletionSourceInvalidation(
                controller,
                controller.sharedCompletionSources.filter(
                  (source) =>
                    source.key !== controller.sharedCompletionKey,
                ),
                stored,
                migrationTime,
              );
            if (sourceInvalidation) {
              sourceLineClearedAtByKey =
                sourceInvalidation.lineClearedAtByKey;
              if (
                sharedCompletionValue?.viewed === true ||
                (sourceInvalidation.updatedAt > 0 &&
                  this.reviewEntryTimestamp(sharedCompletionValue) <
                    sourceInvalidation.updatedAt)
              ) {
                sharedCompletionValue =
                  this.sharedHunkCompletionPartialValue(
                    sourceInvalidation.updatedAt,
                    sourceInvalidation.current,
                  );
                migrations[controller.sharedCompletionKey] =
                  sharedCompletionValue;
              }
              const collapsedValue = stored[controller.collapsedKey];
              sharedSourceInvalidatesCollapse = Boolean(
                collapsedValue &&
                  this.reviewEntryTimestamp(collapsedValue) <=
                    sourceInvalidation.sourceUpdatedAt,
              );
              if (sharedSourceInvalidatesCollapse) {
                migrationRemovals.add(controller.collapsedKey);
              }
            }
          }
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
          const storedCollapse = this.storedCollapseSurvivesSharedClear(
            stored[controller.collapsedKey],
            sharedCompletionValue,
          );
          controller.collapsed = Boolean(
            !hostExpansionOpensHunk &&
              !sharedSourceInvalidatesCollapse &&
              (storedCollapse || previousControllersStayedCollapsed),
          );
          controller.marked = hunkStored;
          let invalidatedLineReview = false;
          let migratedLegacyLineReview = false;
          let localCompletionEvidenceTimestamp = 0;
          let preservedLineReviewForOtherContext = false;
          controller.lines.forEach((line) => {
            // Keep this compatibility read for at least one full
            // REVIEW_RETENTION_MS window after layout-specific keys ship.
            // Extension updates may skip releases, so removing it earlier
            // would strand still-retainable v3 review state.
            const {
              key: storedLineReviewKey,
              legacy: legacyStoredLineReview,
              legacyMatches,
              value: storedLineReview,
            } = this.storedLineReviewCandidate(line, stored);
            this.adoptStoredLineReviewBaselineContext(
              line,
              storedLineReview,
            );
            const lineSharedClearAt = Math.max(
              this.sharedHunkCompletionClearTimestamp(
                sharedCompletionValue,
              ),
              sourceLineClearedAtByKey.get(line.key) ?? 0,
            );
            const lineSharedCompletionValue =
              lineSharedClearAt > 0
                ? this.sharedHunkCompletionClearValue(lineSharedClearAt)
                : sharedCompletionValue;
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
            const storedState = this.storedLineReviewState(
              line,
              storedLineReview,
              lineSharedCompletionValue,
            );
            const storedMatches = storedState.marked;
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
                this.storedLineReviewState(
                  previousLine,
                  storedLineReview,
                  lineSharedCompletionValue,
                ).marked) ||
                capturedLines.some(
                  (candidate) =>
                    candidate &&
                    this.storedLineReviewState(
                      candidate,
                      storedLineReview,
                      lineSharedCompletionValue,
                    ).marked,
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
            if (line.marked) {
              localCompletionEvidenceTimestamp = Math.max(
                localCompletionEvidenceTimestamp,
                this.reviewEntryTimestamp(storedLineReview),
              );
            }
            if (legacyMatches && !storedState.suppressed) {
              migratedLegacyLineReview = true;
              migrations[line.key] = this.lineReviewStorageValue(
                line,
                this.reviewEntryTimestamp(legacyStoredLineReview) ||
                  migrationTime,
                legacyStoredLineReview,
              );
              migrationRemovals.add(line.legacyKey);
            }
            if (storedState.suppressed && sourceLineClearedAtByKey.has(line.key)) {
              migrationRemovals.add(
                legacyMatches ? line.legacyKey : line.key,
              );
            }
            if (
              storedState.invalidated &&
              !trustedExpansionMatches
            ) {
              invalidatedLineReview = true;
              if (this.storedLineReviewHasContext(storedLineReview)) {
                preservedLineReviewForOtherContext = true;
              } else {
                migrationRemovals.add(storedLineReviewKey);
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
          let sharedCompletion =
            this.applySharedHunkCompletionState(
              controller,
              sharedCompletionValue,
              { forceExpanded: hostExpansionOpensHunk },
            );
          if (
            !sharedCompletion &&
            migratedLegacyLineReview &&
            controller.marked &&
            controller.sharedCompletionKey &&
            !(
              sharedCompletionValue?.viewed === false &&
              this.reviewEntryTimestamp(sharedCompletionValue) >=
                localCompletionEvidenceTimestamp
            )
          ) {
            migrations[controller.sharedCompletionKey] =
              this.sharedHunkCompletionStorageValue(
                controller.collapsed,
                migrationTime,
                sharedCompletionValue,
              );
            controller.sharedCompletion = true;
            sharedCompletion = true;
          }
          if (invalidatedLineReview && !sharedCompletion) {
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
            previous.forEach((candidate) => {
              migrationRemovals.add(candidate.collapsedKey);
            });
          }
        });

        openedSharedCompletionKeys.forEach((key) => {
          const value = migrations[key] ?? stored[key];
          if (value?.viewed === true && value.collapsed === true) {
            migrations[key] = this.sharedHunkCompletionStorageValue(
              false,
              migrationTime,
              value,
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
        if (!migrationReadCompleted) {
          const failedIntents = new Set(
            newControllers.flatMap(
              (controller) =>
                expansionAssessmentByController.get(controller)
                  ?.reviewIntents ?? [],
            ),
          );
          failedIntents.forEach((intent) =>
            this.clearHostContextExpansionIntent(intent),
          );
          newControllers.forEach((controller) => {
            controller.lines.forEach((line) => {
              line.baselineContextFingerprint = null;
              line.hostContextExpansionBaselineContextFingerprint = null;
            });
          });
        }
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
