(function attachHunkMarkStorage(root) {
  "use strict";

  const App = root.HunkMarkContent?.App;
  if (!App) {
    return;
  }

  Object.assign(App.prototype, {
    lineReviewStorageValue(lineController, viewedAt, extra = {}) {
      if (typeof lineController?.contextFingerprint !== "string") {
        throw new TypeError("A line review context fingerprint is required");
      }
      return {
        ...extra,
        contextFingerprint: lineController.contextFingerprint,
        viewedAt,
      };
    },

    storedLineReviewMatches(lineController, value) {
      return (
        typeof lineController?.contextFingerprint === "string" &&
        typeof value?.contextFingerprint === "string" &&
        value.contextFingerprint === lineController.contextFingerprint
      );
    },

    rememberLineReviewContext(key, value) {
      if (
        typeof key !== "string" ||
        !key.startsWith(`${this.Core.STORAGE_NAMESPACE}:line:`)
      ) {
        return;
      }
      if (typeof value?.contextFingerprint === "string") {
        this.lineReviewContextByKey.set(key, value.contextFingerprint);
      } else {
        this.lineReviewContextByKey.delete(key);
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

    storedReviewContextGroups(stored) {
      const groups = new Map();

      Object.entries(stored).forEach(([key, value]) => {
        const contextId = this.Core.reviewStorageContextId(key);
        if (!contextId) {
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

    async setReviewStorage(
      values,
      scope = this.currentReviewScope,
      now = Date.now(),
    ) {
      const contextScope = this.Core.reviewContextScope(scope);
      const contextId = contextScope
        ? this.Core.reviewContextId(contextScope)
        : null;
      const previousAccess = contextId
        ? this.reviewContextAccessedAtById.get(contextId)
        : null;
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

      await this.chrome.storage.local.set(storedValues);
      Object.entries(storedValues).forEach(([key, value]) => {
        if (this.isTrackedReviewStorageKey(key)) {
          this.reviewStorageKeys.add(key);
        }
        this.rememberLineReviewContext(key, value);
      });
      if (shouldRecordAccess) {
        this.reviewContextAccessedAtById.set(contextId, now);
      }
      if (this.reviewStorageLimitExceeded()) {
        await this.ensureStoredReviewStatePruned({
          currentContext: contextScope,
          maxEntries: this.reviewStorageEntryLimit(),
          now,
        });
      }
    },

    async touchReviewContextAccess(
      scope = this.currentScope,
      now = Date.now(),
    ) {
      if (!scope) {
        return false;
      }
      const hasSavedState = Array.from(this.reviewStorageKeys).some((key) =>
        this.Core.isReviewStorageKeyForContext(key, scope),
      );
      if (!hasSavedState) {
        return false;
      }
      const contextId = this.Core.reviewContextId(scope);
      const previousAccess =
        this.reviewContextAccessedAtById.get(contextId);
      if (
        Number.isFinite(previousAccess) &&
        (now < previousAccess ||
          now - previousAccess <
            this.constants.REVIEW_ACCESS_TOUCH_INTERVAL_MS)
      ) {
        return false;
      }

      await this.chrome.storage.local.set({
        [this.Core.reviewContextMetadataKeyForId(contextId)]: {
          lastAccessedAt: now,
        },
      });
      this.reviewContextAccessedAtById.set(contextId, now);
      return true;
    },

    forgetReviewContextAccess(scope = this.currentScope) {
      if (scope) {
        this.reviewContextAccessedAtById.delete(
          this.Core.reviewContextId(scope),
        );
      }
    },

    applyReviewContextMetadataChanges(changes) {
      Object.entries(changes).forEach(([key, change]) => {
        if (!this.Core.isReviewContextMetadataKey(key)) {
          return;
        }
        const contextId = this.Core.reviewStorageContextId(key);
        const timestamp = this.reviewContextAccessTimestamp(change.newValue);
        if (contextId && timestamp > 0) {
          this.reviewContextAccessedAtById.set(contextId, timestamp);
        } else if (contextId) {
          this.reviewContextAccessedAtById.delete(contextId);
        }
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
        this.rememberLineReviewContext(key, change.newValue);
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
      if (this.storagePrunePromise) {
        await this.storagePrunePromise;
        const maxEntries =
          options.maxEntries ?? this.reviewStorageEntryLimit();
        if (this.reviewStorageLimitExceeded(maxEntries)) {
          return this.ensureStoredReviewStatePruned(options);
        }
        return;
      }

      this.storagePrunePromise = this.pruneStoredReviewState(options).finally(
        () => {
          this.storagePrunePromise = null;
        },
      );
      return this.storagePrunePromise;
    },

    async pruneStoredReviewState({
      currentContext = this.currentScope,
      maxEntries = this.constants.REVIEW_STORAGE_MAX_ENTRIES,
      now = Date.now(),
    } = {}) {
      const stored = await this.chrome.storage.local.get(null);
      this.reviewStorageKeys.clear();
      this.lineReviewContextByKey.clear();
      Object.entries(stored).forEach(([key, value]) => {
        if (this.isTrackedReviewStorageKey(key)) {
          this.reviewStorageKeys.add(key);
        }
        this.rememberLineReviewContext(key, value);
      });
      const groups = this.storedReviewContextGroups(stored);
      const currentContextId = currentContext
        ? this.Core.reviewContextId(currentContext)
        : null;
      const removals = new Set(
        Object.keys(stored).filter((key) =>
          this.Core.isObsoleteReviewStorageKey(key),
        ),
      );
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
        await this.chrome.storage.local.remove(Array.from(removals));
      }
      if (Object.keys(metadataValues).length > 0) {
        await this.chrome.storage.local.set(metadataValues);
      }

      removals.forEach((key) => {
        this.reviewStorageKeys.delete(key);
        this.rememberLineReviewContext(key, undefined);
      });
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
})(globalThis);
