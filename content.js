(function initializeExtension(root) {
  "use strict";

  const Core = root.HunkMarkCore;
  const App = root.HunkMarkContent?.App;
  if (!Core || !App || !root.chrome?.storage?.local) {
    return;
  }

  const app = new App({
    chromeApi: root.chrome,
    core: Core,
    windowObject: root,
  });
  root.HunkMarkContent.activeApp = app;
  app.start();
})(globalThis);
