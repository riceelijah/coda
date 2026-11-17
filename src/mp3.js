// MP3 export (DESIGN §19). The encoder is LAME compiled to WebAssembly (wasm-media-encoders,
// vendored); it loads the first time someone exports an MP3, not with the page.
let lib = null;
function load() {
  return (lib ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/wasm-media-encoders.min.js", import.meta.url).href;
    s.onload = () => window.WasmMediaEncoder ? ok(window.WasmMediaEncoder) : s.onerror();
    s.onerror = () => { lib = null; s.remove(); fail(new Error("Couldn't load the MP3 encoder")); };
    document.head.appendChild(s);
  }));
}

// An AudioBuffer (1 or 2 channels) -> MP3 Blob. VBR quality 2 (about 190 kbit/s).
export async function mp3Blob(buf, onProgress = () => {}) {
  const W = await load();
  const enc = await W.createEncoder("audio/mpeg", new URL("../vendor/mp3.wasm", import.meta.url).href);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  enc.configure({ sampleRate: buf.sampleRate, channels: 2, vbrQuality: 2 });
  const parts = [], step = 1152 * 100;
  for (let i = 0; i < L.length; i += step) {
    parts.push(enc.encode([L.subarray(i, i + step), R.subarray(i, i + step)]).slice()); // the encoder reuses its output
    onProgress(i / L.length);
    await new Promise((r) => setTimeout(r)); // let the page update
  }
  parts.push(enc.finalize().slice());
  return new Blob(parts, { type: "audio/mpeg" });
}
