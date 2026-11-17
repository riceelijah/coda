# Vendored libraries

| File | Library | Version | Source | Licence |
|---|---|---|---|---|
| `vexflow.js` | VexFlow | 4.2.3 | https://cdn.jsdelivr.net/npm/vexflow@4.2.3/build/cjs/vexflow.js | MIT (embeds the Bravura font, SIL OFL 1.1) |
| `fflate.js` | fflate | 0.8.2 | https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js | MIT |
| `wasm-media-encoders.min.js` | wasm-media-encoders | 0.7.0 | https://cdn.jsdelivr.net/npm/wasm-media-encoders@0.7.0/dist/umd/WasmMediaEncoder.min.js | MIT |
| `mp3.wasm` | LAME, compiled by wasm-media-encoders | 0.7.0 | https://cdn.jsdelivr.net/npm/wasm-media-encoders@0.7.0/wasm/mp3.wasm | LGPL (LAME); source: https://lame.sourceforge.io/ and https://github.com/arseneyr/wasm-media-encoders |

`mp3.wasm` and its loader are fetched only when someone exports an MP3. LAME is LGPL: it is a
separate, unmodified file that can be replaced with another build of the same version.

Do not edit these files. To upgrade, replace the file, update this table, and re-run `test.html`.
