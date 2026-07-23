# Icon design notes

`icon-master.png` is the transparent master used for the 1.0.0 extension icons. The exported release icons live in `../icons/` and are copied into the release ZIP.

The current icon was generated with OpenAI image generation from the previous 128 px icon, then converted from a flat magenta chroma-key background to transparency and resized for each declared manifest size.

## Design brief

- Remain recognizable at 16 x 16 pixels.
- Preserve the dark rounded-square surface and green completion check.
- Use exactly three bold interior elements: a red deletion bar, a neutral context bar, and a dominant green check.
- Avoid text, a plus sign, extra thin lines, perspective, texture, and small details.
- Keep a subtle light outer keyline so the icon remains visible on dark browser chrome.
- Keep the visible artwork close to 89% of the canvas so it remains legible in compact browser-extension surfaces.

The four release icons are intentionally exported assets. Regenerate and inspect them at their exact display sizes before replacing them.

`promo-small-master.png` is the generated high-resolution source for the current 440 x 280 Chrome Web Store promotional tile.

## Store screenshot capture

`store-screenshot-capture.html` is a reproducible GitHub pull-request sample for the Chrome Web Store screenshots. It loads the production `core.js`, content scripts, and `content.css`, then uses a local `chrome.storage` substitute only so the submitted extension code can run outside an installed-extension context.

- `?state=progress` demonstrates hunk completion, automatic collapse, a partially reviewed hunk, and the progress panel.
- `?state=lines` demonstrates line-level review and the partial-hunk state.

The exported 1280 x 800 images are `../store-assets/screenshot-main.png` and `../store-assets/screenshot-filtered.png`.
