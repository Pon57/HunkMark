"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    sharedHunkCompletionStorageValue(
      collapsed,
      updatedAt = Date.now(),
      previous = null,
    ) {
      return this.sharedHunkCompletionValuePreservingClear(
        {
          collapsed: Boolean(collapsed),
          updatedAt,
          viewed: true,
        },
        previous,
      );
    },

    sharedHunkCompletionValuePreservingClear(value, previous = null) {
      const clearedAt = Math.max(
        this.sharedHunkCompletionClearTimestamp(value),
        this.sharedHunkCompletionClearTimestamp(previous),
      );
      return clearedAt > 0 ? { ...value, clearedAt } : value;
    },

    latestSharedHunkCompletionTimestamp(values) {
      return Array.from(values).reduce(
        (latest, value) =>
          Math.max(
            latest,
            this.reviewEntryTimestamp(value),
            this.sharedHunkCompletionClearTimestamp(value),
          ),
        0,
      );
    },

    async sharedHunkCompletionMutationWithStoredState(values, now) {
      const sharedKeys = Object.entries(values)
        .filter(
          ([key, value]) =>
            typeof value?.viewed === "boolean" &&
            key.startsWith(`${this.Core.REVIEW_STORAGE_NAMESPACE}:mark:`),
        )
        .map(([key]) => key);
      if (sharedKeys.length === 0) {
        return { now, values };
      }
      const stored = await this.getLocalStorage(sharedKeys);
      const latestStoredTimestamp = this.latestSharedHunkCompletionTimestamp(
        sharedKeys.map((key) => stored[key]),
      );
      const latestRequestedTimestamp =
        this.latestSharedHunkCompletionTimestamp(
          sharedKeys.map((key) => values[key]),
        );
      const logicalNow = Math.max(
        now,
        latestRequestedTimestamp,
        latestStoredTimestamp + 1,
      );
      const preserved = Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          if (!value || typeof value !== "object") {
            return [key, value];
          }
          return [
            key,
            {
              ...value,
              ...(value.updatedAt === now ? { updatedAt: logicalNow } : {}),
              ...(value.viewedAt === now ? { viewedAt: logicalNow } : {}),
            },
          ];
        }),
      );
      sharedKeys.forEach((key) => {
        const value = {
          ...preserved[key],
          updatedAt: logicalNow,
          ...(preserved[key].viewed === false &&
            preserved[key].partial !== true
            ? { clearedAt: logicalNow }
            : {}),
        };
        preserved[key] = this.sharedHunkCompletionValuePreservingClear(
          value,
          stored[key],
        );
      });
      return { now: logicalNow, values: preserved };
    },

    sharedHunkCompletionClearValue(updatedAt = Date.now()) {
      return { updatedAt, viewed: false };
    },

    sharedHunkCompletionPartialValue(
      updatedAt = Date.now(),
      previous = null,
    ) {
      const clearedAt = this.sharedHunkCompletionClearTimestamp(previous);
      return {
        ...(clearedAt > 0 ? { clearedAt } : {}),
        partial: true,
        updatedAt,
        viewed: false,
      };
    },

    sharedHunkCompletionClearTimestamp(value) {
      if (Number.isFinite(value?.clearedAt)) {
        return value.clearedAt;
      }
      if (value?.viewed !== false) {
        return 0;
      }
      if (value.partial === true) {
        return 0;
      }
      return this.reviewEntryTimestamp(value);
    },

    reviewTimestampAfterSharedState(controllers, now = Date.now()) {
      const values = Array.from(controllers).flatMap((controller) =>
        this.sharedHunkCompletionSourceKeys(controller).map((key) =>
          this.sharedHunkCompletionByKey.get(key),
        ),
      );
      const latestSharedTimestamp =
        this.latestSharedHunkCompletionTimestamp(values);
      return Math.max(now, latestSharedTimestamp + 1);
    },

    lineReviewState(hasValue, timestamp, contextMatches, sharedValue) {
      const clearTimestamp =
        this.sharedHunkCompletionClearTimestamp(sharedValue);
      const suppressed = Boolean(
        hasValue &&
          clearTimestamp > 0 &&
          timestamp <= clearTimestamp,
      );
      return {
        invalidated: hasValue && !suppressed && !contextMatches,
        marked: !suppressed && contextMatches,
        suppressed,
      };
    },

    storedLineReviewState(line, lineValue, sharedValue) {
      return this.lineReviewState(
        lineValue !== undefined,
        this.reviewEntryTimestamp(lineValue),
        this.storedLineReviewMatches(line, lineValue),
        sharedValue,
      );
    },

    cachedLineReviewState(line, sharedValue, key = line.key) {
      const hasValue = Boolean(key && this.reviewStorageKeys.has(key));
      return this.lineReviewState(
        hasValue,
        this.reviewTimestampByKey.get(key) ?? 0,
        this.cachedLineReviewMatchesForKey(line, key),
        sharedValue,
      );
    },

    collapseSurvivesSharedClear(timestamp, sharedValue) {
      const clearTimestamp =
        this.sharedHunkCompletionClearTimestamp(sharedValue);
      return Boolean(
        timestamp > 0 &&
          (clearTimestamp === 0 || timestamp > clearTimestamp),
      );
    },

    storedCollapseSurvivesSharedClear(collapsedValue, sharedValue) {
      return this.collapseSurvivesSharedClear(
        this.reviewEntryTimestamp(collapsedValue),
        sharedValue,
      );
    },

    cachedCollapseSurvivesSharedClear(collapsedKey, sharedValue) {
      return this.collapseSurvivesSharedClear(
        this.reviewTimestampByKey.get(collapsedKey) ?? 0,
        sharedValue,
      );
    },

    addSharedHunkCompletionClearValues(controller, values, updatedAt) {
      this.sharedHunkCompletionSourceKeys(controller).forEach((key) => {
        values[key] = this.sharedHunkCompletionClearValue(updatedAt);
      });
    },

    addSharedHunkCompletionValues(controller, values, updatedAt) {
      this.sharedHunkCompletionSourceKeys(controller).forEach((key) => {
        values[key] = this.sharedHunkCompletionStorageValue(
          controller.collapsed,
          updatedAt,
          this.sharedHunkCompletionByKey.get(key),
        );
      });
    },

    mergeSharedHunkCompletionSources(sources) {
      const lineKeysByCompletionKey = new Map();
      (sources ?? []).forEach((source) => {
        if (!source?.key) {
          return;
        }
        const lineKeys = lineKeysByCompletionKey.get(source.key) ?? new Set();
        (source.lineKeys ?? []).forEach((key) => lineKeys.add(key));
        lineKeysByCompletionKey.set(source.key, lineKeys);
      });
      return Object.freeze(
        Array.from(lineKeysByCompletionKey, ([key, lineKeys]) =>
          Object.freeze({
            key,
            lineKeys: Object.freeze(Array.from(lineKeys)),
          }),
        ),
      );
    },

    sharedHunkCompletionSourceKeys(controller, lines = null) {
      const affectedLineKeys = lines
        ? new Set(lines.map((line) => line.key))
        : null;
      return controller.sharedCompletionSources
        .filter(
          (source) =>
            !affectedLineKeys ||
            source.lineKeys.some((key) => affectedLineKeys.has(key)),
        )
        .map((source) => source.key);
    },

    updateSharedHunkCompletionMutation(
      controller,
      { lines, removals, updatedAt, values },
    ) {
      if (controller.marked) {
        this.addSharedHunkCompletionValues(controller, values, updatedAt);
        return;
      }
      this.sharedHunkCompletionSourceKeys(controller, lines)
        .forEach((key) => {
          values[key] = this.sharedHunkCompletionPartialValue(
            updatedAt,
            this.sharedHunkCompletionByKey.get(key),
          );
          removals.delete(key);
        });
    },

    sharedHunkCompletionSourceInvalidation(
      controller,
      sources,
      stored,
      observedAt,
    ) {
      const current = stored[controller.sharedCompletionKey];
      const currentTimestamp = this.reviewEntryTimestamp(current);
      let updatedAt = 0;
      let sourceUpdatedAt = 0;
      const lineClearedAtByKey = new Map();
      sources.forEach((source) => {
        const value = stored[source.key];
        if (value?.viewed === true) {
          return;
        }
        let timestamp = this.reviewEntryTimestamp(value);
        if (value === undefined) {
          if (current?.viewed !== true) {
            return;
          }
        } else if (
          current?.viewed === true &&
          timestamp > 0 &&
          timestamp < currentTimestamp
        ) {
          return;
        }
        timestamp ||= observedAt;
        sourceUpdatedAt = Math.max(sourceUpdatedAt, timestamp);
        if (timestamp >= currentTimestamp) {
          updatedAt = Math.max(updatedAt, timestamp);
        }
        const clearedAt = this.sharedHunkCompletionClearTimestamp(value);
        if (clearedAt > 0) {
          source.lineKeys.forEach((key) => {
            lineClearedAtByKey.set(
              key,
              Math.max(clearedAt, lineClearedAtByKey.get(key) ?? 0),
            );
          });
        }
      });
      if (sourceUpdatedAt === 0) {
        return null;
      }
      return {
        current,
        lineClearedAtByKey,
        sourceUpdatedAt,
        updatedAt,
      };
    },

    applySharedHunkCompletionSourceInvalidation(
      controller,
      invalidation,
      stored,
    ) {
      const current = stored[controller.sharedCompletionKey];
      const currentClearAt = this.sharedHunkCompletionClearTimestamp(current);
      controller.lines.forEach((line) => {
        const lineClearAt = Math.max(
          currentClearAt,
          invalidation.lineClearedAtByKey.get(line.key) ?? 0,
        );
        const sharedValue =
          lineClearAt > 0
            ? this.sharedHunkCompletionClearValue(lineClearAt)
            : current;
        line.marked = this.storedLineReviewState(
          line,
          stored[line.key],
          sharedValue,
        ).marked;
      });
      this.updateAggregateFromLines(controller);
      controller.sharedCompletion = false;
      const collapsedValue = stored[controller.collapsedKey];
      controller.collapsed = Boolean(
        collapsedValue &&
          this.reviewEntryTimestamp(collapsedValue) >
            invalidation.sourceUpdatedAt,
      );
      this.applyControllerAppearance(controller);
      this.updateProgress();
    },

    propagateSharedHunkCompletionSourceChanges(
      controller,
      changes,
      observedAt = Date.now(),
    ) {
      const changedSources = controller.sharedCompletionSources.filter(
        (source) =>
          source.key !== controller.sharedCompletionKey &&
          Object.prototype.hasOwnProperty.call(changes, source.key) &&
          changes[source.key].newValue?.viewed !== true,
      );
      if (!controller.sharedCompletionKey || changedSources.length === 0) {
        return null;
      }
      const sources = controller.sharedCompletionSources.filter(
        (source) => source.key !== controller.sharedCompletionKey,
      );
      return this.withReviewStorageLock(async () => {
        if (!this.reviewControllerIsCurrent(controller)) {
          return;
        }
        const sourceKeys = sources.map((source) => source.key);
        const keys = [
          controller.sharedCompletionKey,
          controller.collapsedKey,
          ...sourceKeys,
          ...sources.flatMap((source) => source.lineKeys),
          ...controller.lines.map((line) => line.key),
        ];
        const stored = await this.getLocalStorage(keys);
        const invalidation = this.sharedHunkCompletionSourceInvalidation(
          controller,
          sources,
          stored,
          observedAt,
        );
        if (!invalidation) {
          return;
        }
        this.applySharedHunkCompletionSourceInvalidation(
          controller,
          invalidation,
          stored,
        );

        const { current, updatedAt } = invalidation;
        const values = {};
        if (
          current?.viewed === true ||
          (updatedAt > 0 && this.reviewEntryTimestamp(current) < updatedAt)
        ) {
          values[controller.sharedCompletionKey] =
            this.sharedHunkCompletionPartialValue(updatedAt, current);
        }
        const removals = Array.from(
          invalidation.lineClearedAtByKey,
          ([key, clearedAt]) =>
            stored[key] !== undefined &&
            this.reviewEntryTimestamp(stored[key]) <= clearedAt
              ? key
              : null,
        ).filter(Boolean);
        if (
          stored[controller.collapsedKey] &&
          this.reviewEntryTimestamp(stored[controller.collapsedKey]) <=
            invalidation.sourceUpdatedAt
        ) {
          removals.push(controller.collapsedKey);
        }
        if (Object.keys(values).length === 0 && removals.length === 0) {
          return;
        }
        try {
          await this.mutateReviewStorageUnlocked({
            values,
            removals,
            scope: this.currentReviewScope,
            now: Math.max(updatedAt, invalidation.sourceUpdatedAt),
          });
        } catch (error) {
          if (this.reviewControllerIsCurrent(controller)) {
            this.applySharedHunkCompletionSourceInvalidation(
              controller,
              invalidation,
              stored,
            );
          }
          throw error;
        }
      });
    },

    controllerPreservesSharedCompletionSources(controller, previous) {
      return Boolean(
        previous &&
          previous.key === controller.key &&
          this.Core.hunkHeadersSemanticallyCompatible(
            previous.headerText,
            controller.headerText,
          ) &&
          previous.lines.length === controller.lines.length &&
          controller.lines.every(
            (line, index) =>
              line.key === previous.lines[index].key &&
              line.contextFingerprint ===
                previous.lines[index].contextFingerprint,
          ),
      );
    },

    contextExpansionSharedCompletionSources(controller, assessment) {
      const sources = [...controller.sharedCompletionSources];
      const previousPreservesSources = Boolean(
        assessment?.previous.length === 1 &&
          this.controllerPreservesSharedCompletionSources(
            controller,
            assessment.previous[0],
          ),
      );
      if (assessment?.opensHunk || previousPreservesSources) {
        assessment.previous.forEach((candidate) => {
          sources.push(...candidate.sharedCompletionSources);
        });
      }
      if (!assessment?.opensHunk) {
        return this.mergeSharedHunkCompletionSources(sources);
      }
      const changedAnchors = new Set(
        controller.lines.map((line) => `changed:${line.key}`),
      );
      assessment.reviewIntents.forEach((intent) => {
        (intent.capture.cachedHunkGroups ?? [])
          .filter((group) =>
            group.contextAnchors?.some((anchor) =>
              changedAnchors.has(anchor),
            ),
          )
          .forEach((group) => {
            sources.push(...(group.sharedCompletionSources ?? []));
          });
      });
      return this.mergeSharedHunkCompletionSources(sources);
    },

    applySharedHunkCompletionState(
      controller,
      value,
      { forceExpanded = false, restoreLocal = false } = {},
    ) {
      const completed = Boolean(value?.viewed === true);
      controller.sharedCompletion = completed;
      if (!completed) {
        if (restoreLocal) {
          let invalidatedLineReview = false;
          controller.lines.forEach((line) => {
            const key = this.cachedLineReviewKey(line);
            const state = this.cachedLineReviewState(
              line,
              value,
              key,
            );
            invalidatedLineReview ||= state.invalidated;
            line.marked = state.marked;
          });
          this.updateAggregateFromLines(controller);
          controller.collapsed = Boolean(
            !invalidatedLineReview &&
              this.cachedCollapseSurvivesSharedClear(
                controller.collapsedKey,
                value,
              ),
          );
        }
        return false;
      }
      controller.lines.forEach((line) => {
        line.marked = true;
      });
      controller.marked = true;
      controller.indeterminate = false;
      controller.collapsed = forceExpanded
        ? false
        : Boolean(value.collapsed);
      return true;
    },
  });
}
