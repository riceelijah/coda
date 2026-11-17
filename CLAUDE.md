# Coda

Open-source, browser-only music notation editor. Static site for GitHub Pages.

Before doing anything, read `docs/DESIGN.md` (what to build) and `docs/PLAN.md` (order, checks,
current status). Work one phase at a time and update the status table in PLAN.md.

Rules that are easy to break by accident:

- No build step, bundler, framework, or `package.json`. Plain ES modules, relative paths only.
- Only three dependencies, vendored in `vendor/`: VexFlow 4.2.3, fflate 0.8.2, and wasm-media-encoders
  0.7.0 (MP3 export only, loaded on demand). Ask before adding any.
  Instrument sounds are fetched at run time from cdn.jsdelivr.net (pinned commit) and gleitz.github.io.
- `src/model.js` stays pure: no DOM, no VexFlow.
- The names "Finale", "NotePad" and "MakeMusic" appear only in the README and in the one
  legacy-file message quoted in DESIGN.md §9.1. Never in UI chrome, titles, or icons.
- All score changes go through the `edit()` wrapper so undo and autosave always work.
- Text from files or localStorage (titles, names, warnings) goes into the page with `textContent`,
  never `innerHTML`.
- Importers never drop anything silently; they count it and put it in the report.
- Verify in the browser pane (serve over http; ES modules don't load from `file://`). Run `test.html`.
- Don't push, create a remote, or publish without the user saying so.
