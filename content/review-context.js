"use strict";

if (globalThis.HunkMarkContent?.extendApp) {
  globalThis.HunkMarkContent.extendApp({
    reviewContextAlias(contextFingerprint, candidates) {
      return (
        candidates.find(
          (candidate) =>
            this.Core.isReviewIdentifier(candidate) &&
            candidate !== contextFingerprint,
        ) ?? null
      );
    },

    reviewContextsMatch(
      contextFingerprint,
      aliasContextFingerprint,
      storedContextFingerprint,
      storedAliasContextFingerprint,
    ) {
      if (
        !this.Core.isReviewIdentifier(contextFingerprint) ||
        !this.Core.isReviewIdentifier(storedContextFingerprint)
      ) {
        return false;
      }
      if (
        storedContextFingerprint === contextFingerprint ||
        storedAliasContextFingerprint === contextFingerprint
      ) {
        return true;
      }
      const alias = this.reviewContextAlias(contextFingerprint, [
        aliasContextFingerprint,
      ]);
      return Boolean(
        alias &&
          (storedContextFingerprint === alias ||
            storedAliasContextFingerprint === alias),
      );
    },

    lineReviewStorageValue(lineController, viewedAt, extra = {}) {
      if (
        !this.Core.isReviewIdentifier(lineController?.contextFingerprint)
      ) {
        throw new TypeError("A line review context fingerprint is required");
      }
      const baselineContextFingerprint =
        this.storedLineReviewBaselineContext(extra) ??
        this.hostContextExpansionBaselineContext(lineController);
      const value = {
        ...extra,
        contextFingerprint: lineController.contextFingerprint,
        viewedAt,
      };
      if (
        baselineContextFingerprint &&
        baselineContextFingerprint !== lineController.contextFingerprint
      ) {
        value.baselineContextFingerprint = baselineContextFingerprint;
      } else {
        delete value.baselineContextFingerprint;
      }
      return value;
    },

    storedLineReviewHasContext(value) {
      return this.Core.isReviewIdentifier(value?.contextFingerprint);
    },

    storedLineReviewBaselineContext(value) {
      return this.Core.isReviewIdentifier(value?.baselineContextFingerprint)
        ? value.baselineContextFingerprint
        : null;
    },

    adoptStoredLineReviewBaselineContext(lineController, value) {
      const lineContext = lineController?.contextFingerprint;
      const storedBaseline = this.reviewContextAlias(lineContext, [
        this.storedLineReviewBaselineContext(value),
      ]);
      if (
        !this.Core.isReviewIdentifier(lineContext) ||
        value?.contextFingerprint !== lineContext ||
        !storedBaseline ||
        lineController.hostContextExpansionBaselineContextFingerprint ===
          storedBaseline
      ) {
        return false;
      }

      // A persisted alias is trusted only in the direction where its primary
      // fingerprint identifies this exact DOM. The reverse direction keeps
      // the contracted fingerprint as the baseline, preventing alias drift
      // across different expansion paths.
      lineController.hostContextExpansionBaselineContextFingerprint =
        storedBaseline;
      return true;
    },

    storedLineReviewMatches(lineController, value) {
      const lineContext = lineController?.contextFingerprint;
      const lineAlias = this.reviewContextAlias(lineContext, [
        lineController?.hostContextExpansionBaselineContextFingerprint,
        lineController?.baselineContextFingerprint,
      ]);
      return this.reviewContextsMatch(
        lineContext,
        lineAlias,
        value?.contextFingerprint,
        this.storedLineReviewBaselineContext(value),
      );
    },

    cachedLineReviewMatches(lineController) {
      if (!this.reviewStorageKeys.has(lineController.key)) {
        return false;
      }
      const storedContext = this.lineReviewContextByKey.get(
        lineController.key,
      );
      const storedBaseline = this.lineReviewBaselineContextByKey.get(
        lineController.key,
      );
      return this.reviewContextsMatch(
        lineController?.contextFingerprint,
        lineController?.hostContextExpansionBaselineContextFingerprint,
        this.Core.isReviewIdentifier(storedContext)
          ? storedContext
          : storedBaseline,
        storedBaseline,
      );
    },

    hostContextExpansionBaselineContext(line) {
      const lineContext = line?.contextFingerprint;
      const attachedBaseline = this.reviewContextAlias(lineContext, [
        line?.hostContextExpansionBaselineContextFingerprint,
      ]);
      if (attachedBaseline) {
        return attachedBaseline;
      }

      // The storage cache can retain a reviewed value for another semantic
      // context after the current DOM correctly failed closed. Reuse its
      // baseline only when the stored primary fingerprint identifies this
      // exact DOM. When the current DOM is itself the stored baseline, its own
      // fingerprint must remain the source for a later expansion; carrying the
      // previous expanded primary instead would make the baseline drift across
      // different expansion paths and stop a later contracted reload matching.
      if (this.lineReviewContextByKey.get(line?.key) !== lineContext) {
        return null;
      }
      return this.reviewContextAlias(lineContext, [
        this.lineReviewBaselineContextByKey.get(line?.key),
      ]);
    },
  });
}
