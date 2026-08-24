"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    rememberReviewStorageValue(key, value) {
      if (this.Core.isReviewStorageKey(key)) {
        const timestamp = this.reviewEntryTimestamp(value);
        if (timestamp > 0) {
          this.reviewTimestampByKey.set(key, timestamp);
        } else {
          this.reviewTimestampByKey.delete(key);
        }
      }
      if (
        typeof key === "string" &&
        key.startsWith(`${this.Core.REVIEW_STORAGE_NAMESPACE}:mark:`)
      ) {
        if (typeof value?.viewed === "boolean") {
          this.sharedHunkCompletionByKey.set(key, value);
        } else {
          this.sharedHunkCompletionByKey.delete(key);
        }
      }
      if (
        typeof key !== "string" ||
        !key.startsWith(`${this.Core.REVIEW_STORAGE_NAMESPACE}:line:`)
      ) {
        return;
      }
      if (this.storedLineReviewHasContext(value)) {
        this.lineReviewContextByKey.set(key, value.contextFingerprint);
        const baselineContext =
          this.storedLineReviewBaselineContext(value);
        if (baselineContext && baselineContext !== value.contextFingerprint) {
          this.lineReviewBaselineContextByKey.set(key, baselineContext);
        } else {
          this.lineReviewBaselineContextByKey.delete(key);
        }
      } else {
        this.lineReviewContextByKey.delete(key);
        this.lineReviewBaselineContextByKey.delete(key);
      }
    },

    reviewEntryTimestamp(value) {
      if (!value || typeof value !== "object") {
        return 0;
      }
      const timestamp = value.updatedAt ?? value.viewedAt;
      return Number.isFinite(timestamp) ? timestamp : 0;
    },

    reviewContextAccessTimestamp(value) {
      const timestamp = value?.lastAccessedAt;
      return Number.isFinite(timestamp) ? timestamp : 0;
    },

    rememberReviewContextAccess(key, value) {
      if (!this.Core.isReviewContextMetadataKey(key)) {
        return;
      }
      const contextId = this.Core.reviewStorageContextId(key);
      if (!contextId) {
        return;
      }
      const timestamp = this.reviewContextAccessTimestamp(value);
      if (timestamp > 0) {
        this.reviewContextAccessedAtById.set(contextId, timestamp);
      } else {
        this.reviewContextAccessedAtById.delete(contextId);
      }
    },

    storedReviewContextGroups(stored, excludedKeys = new Set()) {
      const groups = new Map();

      Object.entries(stored).forEach(([key, value]) => {
        if (excludedKeys.has(key)) {
          return;
        }
        const contextId = this.Core.reviewStorageContextId(key);
        if (!contextId) {
          return;
        }
        if (
          this.Core.isLineReviewStorageKey(key) &&
          !this.storedLineReviewHasContext(value)
        ) {
          return;
        }
        const group = groups.get(contextId) ?? {
          contextId,
          entries: [],
          metadataKey:
            this.Core.reviewContextMetadataKeyForId(contextId),
          metadataTimestamp: 0,
        };

        if (this.Core.isReviewContextMetadataKey(key)) {
          group.metadataTimestamp = this.reviewContextAccessTimestamp(value);
        } else if (this.Core.isReviewStorageKey(key)) {
          group.entries.push({
            key,
            timestamp: this.reviewEntryTimestamp(value),
          });
        }
        groups.set(contextId, group);
      });

      return groups;
    },

    // Web Locks are not reentrant. Public mutators acquire the lock; code
    // already inside that callback must use the explicit Unlocked helpers.
    reviewStorageLockName() {
      const extensionId = this.chrome?.runtime?.id;
      return typeof extensionId === "string" && extensionId.length > 0
        ? `${extensionId}:${this.constants.REVIEW_STORAGE_LOCK_NAME}`
        : this.constants.REVIEW_STORAGE_LOCK_NAME;
    },

    async withReviewStorageLock(
      callback,
      { mode = "exclusive" } = {},
    ) {
      const lockManager = this.window?.navigator?.locks;
      if (typeof lockManager?.request !== "function") {
        return callback();
      }
      return lockManager.request(
        this.reviewStorageLockName(),
        { mode },
        () => callback(),
      );
    },

    beginReviewAppearancePersistence(controllers) {
      Array.from(controllers).forEach((controller) => {
        this.reviewAppearancePersistenceCountByController.set(
          controller,
          (this.reviewAppearancePersistenceCountByController.get(controller) ??
            0) + 1,
        );
      });
    },

    endReviewAppearancePersistence(controllers) {
      Array.from(controllers).forEach((controller) => {
        const remaining =
          (this.reviewAppearancePersistenceCountByController.get(controller) ??
            0) - 1;
        if (remaining > 0) {
          this.reviewAppearancePersistenceCountByController.set(
            controller,
            remaining,
          );
        } else {
          this.reviewAppearancePersistenceCountByController.delete(controller);
        }
      });
    },

    reviewAppearancePersistencePending(controller) {
      return (
        (this.reviewAppearancePersistenceCountByController.get(controller) ??
          0) > 0
      );
    },

    async setReviewStorage(
      values,
      scope = this.currentReviewScope,
      now = Date.now(),
    ) {
      return this.mutateReviewStorage({ values, scope, now });
    },

    async mutateReviewStorage({
      values = {},
      removals = [],
      scope = this.currentReviewScope,
      now = Date.now(),
    } = {}) {
      return this.withReviewStorageLock(() =>
        this.mutateReviewStorageUnlocked({
          values,
          removals,
          scope,
          now,
        }),
      );
    },

    async mutateReviewStorageUnlocked({
      isCurrent = null,
      values = {},
      removals = [],
      scope = this.currentReviewScope,
      now = Date.now(),
    } = {}) {
      const mutationIsCurrent = isCurrent ?? (() => true);
      const cancellationPossible = isCurrent !== null;
      ({ now, values } =
        await this.sharedHunkCompletionMutationWithStoredState(values, now));
      if (!mutationIsCurrent()) {
        return false;
      }
      const storedKeys = Object.keys(values);
      const invalidLineKey = storedKeys.find(
        (key) =>
          this.Core.isLineReviewStorageKey(key) &&
          !this.storedLineReviewHasContext(values[key]),
      );
      if (invalidLineKey) {
        throw new TypeError(
          "A persisted line review context fingerprint is required",
        );
      }
      const storedKeySet = new Set(storedKeys);
      const removalKeys = [
        ...new Set(Array.isArray(removals) ? removals : [removals]),
      ].filter(
        (key) => typeof key === "string" && !storedKeySet.has(key),
      );
      const mutationKeySet = new Set([...storedKeys, ...removalKeys]);
      if (
        storedKeys.length > 0 &&
        (cancellationPossible || removalKeys.length > 0)
      ) {
        const contextScope = this.Core.reviewContextScope(scope);
        if (contextScope) {
          mutationKeySet.add(
            await this.Core.reviewContextMetadataKey(contextScope),
          );
          if (!mutationIsCurrent()) {
            return false;
          }
        }
      }
      const mutationKeys = [...mutationKeySet];
      const previousValues =
        mutationKeys.length > 0 &&
        (cancellationPossible ||
          (storedKeys.length > 0 && removalKeys.length > 0))
          ? await this.getLocalStorage(mutationKeys)
          : null;
      if (!mutationIsCurrent()) {
        return false;
      }
      let valuesStored = false;
      const rollbackCanceledMutation = async () => {
        if (previousValues) {
          await this.restoreReviewStorageSnapshotUnlocked(
            previousValues,
            mutationKeys,
          );
        }
        return false;
      };

      try {
        if (storedKeys.length > 0) {
          const stored = await this.setReviewStorageUnlocked(
            values,
            scope,
            now,
            { isCurrent: mutationIsCurrent, prune: false },
          );
          if (!stored) {
            return false;
          }
          valuesStored = true;
          if (!mutationIsCurrent()) {
            return rollbackCanceledMutation();
          }
        }
        if (removalKeys.length > 0) {
          if (!mutationIsCurrent()) {
            return rollbackCanceledMutation();
          }
          await this.removeReviewStorageUnlocked(removalKeys);
          if (!mutationIsCurrent()) {
            return rollbackCanceledMutation();
          }
        }
      } catch (error) {
        if (valuesStored && previousValues) {
          try {
            await this.restoreReviewStorageSnapshotUnlocked(
              previousValues,
              mutationKeys,
            );
          } catch (rollbackError) {
            if (this.stopForInvalidatedContext?.(rollbackError)) {
              throw rollbackError;
            }
            try {
              error.reviewStorageRollbackError = rollbackError;
            } catch {
              // The authoritative re-read in the controller still prevents a
              // stale UI rollback when an Error object is not extensible.
            }
          }
        }
        throw error;
      }
      if (
        storedKeys.length > 0 &&
        this.reviewStorageLimitExceeded()
      ) {
        try {
          await this.ensureStoredReviewStatePrunedUnlocked({
            currentContext: this.Core.reviewContextScope(scope),
            maxEntries: this.reviewStorageEntryLimit(),
            now,
          });
        } catch (error) {
          if (!this.stopForInvalidatedContext?.(error)) {
            console.warn(
              "HunkMark could not prune old review state after saving.",
              error,
            );
          }
        }
      }
      if (!mutationIsCurrent()) {
        return rollbackCanceledMutation();
      }
      return true;
    },

    async setReviewStorageValuesUnlocked(values) {
      return this.setLocalStorage(values);
    },

    async restoreReviewStorageSnapshotUnlocked(snapshot, keys) {
      const values = {};
      const removals = [];
      keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
          values[key] = snapshot[key];
        } else {
          removals.push(key);
        }
      });

      if (Object.keys(values).length > 0) {
        await this.setReviewStorageValuesUnlocked(values);
        Object.entries(values).forEach(([key, value]) => {
          if (this.isTrackedReviewStorageKey(key)) {
            this.reviewStorageKeys.add(key);
          }
          this.rememberReviewStorageValue(key, value);
          this.rememberReviewContextAccess(key, value);
        });
      }
      if (removals.length > 0) {
        await this.removeReviewStorageUnlocked(removals);
      }
    },

    async removeReviewStorage(keys) {
      return this.withReviewStorageLock(() =>
        this.removeReviewStorageUnlocked(keys),
      );
    },

    async removeReviewStorageUnlocked(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length === 0) {
        return;
      }
      await this.removeLocalStorage(list);
      list.forEach((key) => {
        this.reviewStorageKeys.delete(key);
        this.rememberReviewStorageValue(key, undefined);
        this.rememberReviewContextAccess(key, undefined);
      });
    },

    async setReviewStorageUnlocked(
      values,
      scope = this.currentReviewScope,
      now = Date.now(),
      { isCurrent = () => true, prune = true } = {},
    ) {
      const contextScope = this.Core.reviewContextScope(scope);
      const contextId = contextScope
        ? await this.Core.reviewContextId(contextScope)
        : null;
      const previousAccess = contextId
        ? this.reviewContextAccessedAtById.get(contextId)
        : null;
      if (!isCurrent()) {
        return false;
      }
      const shouldRecordAccess =
        contextId &&
        (!Number.isFinite(previousAccess) ||
          (now >= previousAccess &&
            now - previousAccess >=
              this.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS));
      const storedValues = { ...values };

      if (shouldRecordAccess) {
        storedValues[
          this.Core.reviewContextMetadataKeyForId(contextId)
        ] = {
          lastAccessedAt: now,
        };
      }

      await this.setReviewStorageValuesUnlocked(storedValues);
      Object.entries(storedValues).forEach(([key, value]) => {
        if (this.isTrackedReviewStorageKey(key)) {
          this.reviewStorageKeys.add(key);
        }
        this.rememberReviewStorageValue(key, value);
      });
      if (shouldRecordAccess) {
        this.reviewContextAccessedAtById.set(contextId, now);
      }
      if (prune && this.reviewStorageLimitExceeded()) {
        await this.ensureStoredReviewStatePrunedUnlocked({
          currentContext: contextScope,
          maxEntries: this.reviewStorageEntryLimit(),
          now,
        });
      }
      return true;
    },

    async touchReviewContextAccess(
      scope = this.currentScope,
      now = Date.now(),
    ) {
      if (!(await this.reviewContextAccessIdToTouch(scope, now))) {
        return false;
      }
      return this.withReviewStorageLock(() =>
        this.touchReviewContextAccessUnlocked(scope, now),
      );
    },

    async reviewContextAccessIdToTouch(
      scope = this.currentScope,
      now = Date.now(),
    ) {
      if (!scope) {
        return null;
      }
      const contextPrefixes =
        await this.Core.reviewStoragePrefixesForContext(scope);
      const hasSavedState = Array.from(this.reviewStorageKeys).some((key) =>
        contextPrefixes.some((prefix) => key.startsWith(prefix)),
      );
      if (!hasSavedState) {
        return null;
      }
      const contextId = await this.Core.reviewContextId(scope);
      const previousAccess =
        this.reviewContextAccessedAtById.get(contextId);
      if (
        Number.isFinite(previousAccess) &&
        (now < previousAccess ||
          now - previousAccess <
            this.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS)
      ) {
        return null;
      }
      return contextId;
    },

    async touchReviewContextAccessUnlocked(
      scope = this.currentScope,
      now = Date.now(),
    ) {
      const contextId = await this.reviewContextAccessIdToTouch(scope, now);
      if (!contextId) {
        return false;
      }

      await this.setReviewStorageValuesUnlocked({
        [this.Core.reviewContextMetadataKeyForId(contextId)]: {
          lastAccessedAt: now,
        },
      });
      this.reviewContextAccessedAtById.set(contextId, now);
      return true;
    },

    async forgetReviewContextAccess(scope = this.currentScope) {
      if (scope) {
        this.reviewContextAccessedAtById.delete(
          await this.Core.reviewContextId(scope),
        );
      }
    },

    applyReviewContextMetadataChanges(changes) {
      Object.entries(changes).forEach(([key, change]) => {
        this.rememberReviewContextAccess(key, change.newValue);
      });
    },

    isTrackedReviewStorageKey(key) {
      return (
        this.Core.isReviewStorageKey(key) ||
        this.Core.isReviewContextMetadataKey(key) ||
        this.Core.isObsoleteReviewStorageKey(key)
      );
    },

    applyReviewStorageKeyChanges(changes) {
      Object.entries(changes).forEach(([key, change]) => {
        if (!this.isTrackedReviewStorageKey(key)) {
          return;
        }
        this.rememberReviewStorageValue(key, change.newValue);
        if (change.newValue === undefined) {
          this.reviewStorageKeys.delete(key);
        } else {
          this.reviewStorageKeys.add(key);
        }
      });
    },

    reviewStorageEntryLimit() {
      return this.constants.REVIEW_STORAGE_MAX_ENTRIES;
    },

    reviewStorageLimitExceeded(maxEntries = this.reviewStorageEntryLimit()) {
      return this.reviewStorageKeys.size > maxEntries;
    },

    async ensureStoredReviewStatePruned(options = {}) {
      return this.withReviewStorageLock(() =>
        this.ensureStoredReviewStatePrunedUnlocked(options),
      );
    },

    async ensureStoredReviewStatePrunedUnlocked(options = {}) {
      if (this.reviewStoragePrunePromise) {
        await this.reviewStoragePrunePromise;
        const maxEntries =
          options.maxEntries ?? this.reviewStorageEntryLimit();
        if (this.reviewStorageLimitExceeded(maxEntries)) {
          return this.ensureStoredReviewStatePrunedUnlocked(options);
        }
        return;
      }

      this.reviewStoragePrunePromise =
        this.pruneStoredReviewStateUnlocked(options).finally(() => {
          this.reviewStoragePrunePromise = null;
        });
      return this.reviewStoragePrunePromise;
    },

    async pruneStoredReviewState(options = {}) {
      return this.withReviewStorageLock(() =>
        this.pruneStoredReviewStateUnlocked(options),
      );
    },

    async pruneStoredReviewStateUnlocked(
      {
        currentContext = this.currentScope,
        maxEntries = this.constants.REVIEW_STORAGE_MAX_ENTRIES,
        now = Date.now(),
      } = {},
    ) {
      const stored = await this.getLocalStorage(null);
      this.reviewStorageKeys.clear();
      this.sharedHunkCompletionByKey.clear();
      this.lineReviewBaselineContextByKey.clear();
      this.lineReviewContextByKey.clear();
      this.reviewTimestampByKey.clear();
      Object.entries(stored).forEach(([key, value]) => {
        if (this.isTrackedReviewStorageKey(key)) {
          this.reviewStorageKeys.add(key);
        }
        this.rememberReviewStorageValue(key, value);
      });
      const currentContextId = currentContext
        ? await this.Core.reviewContextId(currentContext)
        : null;
      // A collapsed state backed by malformed line evidence can hide
      // unreviewed code, so clear collapsed entries in the affected range.
      const invalidLineRanges = new Set(
        Object.entries(stored)
          .filter(
            ([key, value]) =>
              this.Core.isLineReviewStorageKey(key) &&
              !this.storedLineReviewHasContext(value),
          )
          .map(([key]) => {
            const contextId = this.Core.reviewStorageContextId(key);
            const rangeId = this.Core.reviewStorageRangeId(key);
            return `${contextId}\u0000${rangeId}`;
          }),
      );
      const removals = new Set(
        Object.entries(stored)
          .filter(
            ([key, value]) =>
              this.Core.isObsoleteReviewStorageKey(key) ||
              (this.Core.isLineReviewStorageKey(key) &&
                !this.storedLineReviewHasContext(value)) ||
              (key.endsWith(":collapsed") &&
                invalidLineRanges.has(
                  `${this.Core.reviewStorageContextId(key)}\u0000` +
                    this.Core.reviewStorageRangeId(key),
                )),
          )
          .map(([key]) => key),
      );
      const groups = this.storedReviewContextGroups(stored, removals);
      const metadataValues = {};
      const retainedGroups = [];

      groups.forEach((group) => {
        const newestEntryTimestamp = group.entries.reduce(
          (latest, entry) => Math.max(latest, entry.timestamp),
          0,
        );
        const isCurrent = group.contextId === currentContextId;
        const storedLastAccessedAt =
          group.metadataTimestamp > 0
            ? group.metadataTimestamp
            : newestEntryTimestamp;
        let lastAccessedAt =
          storedLastAccessedAt > 0
            ? Math.min(storedLastAccessedAt, now)
            : 0;

        if (group.entries.length === 0) {
          removals.add(group.metadataKey);
          return;
        }

        if (
          isCurrent &&
          (lastAccessedAt <= 0 ||
            now - lastAccessedAt >=
              this.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS)
        ) {
          lastAccessedAt = now;
        }

        if (
          lastAccessedAt <= 0 ||
          now - lastAccessedAt > this.constants.REVIEW_RETENTION_MS
        ) {
          group.entries.forEach((entry) => removals.add(entry.key));
          removals.add(group.metadataKey);
          return;
        }

        if (group.metadataTimestamp !== lastAccessedAt) {
          metadataValues[group.metadataKey] = { lastAccessedAt };
        }
        retainedGroups.push({ ...group, isCurrent, lastAccessedAt });
      });

      let retainedEntryCount = retainedGroups.reduce(
        (count, group) => count + group.entries.length + 1,
        0,
      );
      retainedGroups
        .slice()
        .sort(
          (left, right) =>
            Number(left.isCurrent) - Number(right.isCurrent) ||
            left.lastAccessedAt - right.lastAccessedAt ||
            left.contextId.localeCompare(right.contextId),
        )
        .forEach((group) => {
          if (retainedEntryCount <= maxEntries) {
            return;
          }
          group.entries.forEach((entry) => removals.add(entry.key));
          removals.add(group.metadataKey);
          delete metadataValues[group.metadataKey];
          retainedEntryCount -= group.entries.length + 1;
        });

      if (removals.size > 0) {
        await this.removeReviewStorageUnlocked(Array.from(removals));
      }
      if (Object.keys(metadataValues).length > 0) {
        await this.setReviewStorageValuesUnlocked(metadataValues);
      }

      Object.keys(metadataValues).forEach((key) =>
        this.reviewStorageKeys.add(key),
      );

      groups.forEach((group) => {
        if (removals.has(group.metadataKey)) {
          this.reviewContextAccessedAtById.delete(group.contextId);
          return;
        }
        const value = metadataValues[group.metadataKey];
        const timestamp = value?.lastAccessedAt ?? group.metadataTimestamp;
        if (timestamp > 0) {
          this.reviewContextAccessedAtById.set(group.contextId, timestamp);
        }
      });
    },
  });
}
