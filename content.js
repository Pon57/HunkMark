(function initializeExtension(root) {
  "use strict";

  const Core = root.HunkMarkCore;
  const App = root.HunkMarkContent?.App;
  if (!Core || !App || !root.chrome?.storage?.local) {
    return;
  }

  const previous = root.HunkMarkContent.activeApp;
  const version = root.chrome.runtime.getManifest().version;
  if (previous?.runtimeVersion === version && previous.navigationStarted &&
      !previous.isExtensionContextInvalidated()) {
    return;
  }
  root.document.dispatchEvent(new root.Event("hunkmark:replace-runtime"));
  previous?.stop();
  root.document.getElementById(root.HunkMarkContent.constants.RECONNECT_NOTICE_ID)?.remove();
  root.document.documentElement.setAttribute("data-hunkmark-managed-styles", "1");

  const app = new App({
    chromeApi: root.chrome,
    core: Core,
    windowObject: root,
  });
  root.HunkMarkContent.activeApp = app;
  app.start();
})(globalThis);
