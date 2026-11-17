// Your own instrument sounds (DESIGN §18): one audio file, the note it was recorded at, and the
// range of notes it plays. Kept in the browser's Cache API, one entry per sound, with the details
// in headers, so nothing else has to stay in step with it.
const CACHE = "coda-user-sounds-v1";
export const MAX_BYTES = 20 * 1024 * 1024;
const url = (id) => new URL("coda-user-sound/" + id, location.href).href;
const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.max(lo, Math.min(hi, n)) : d; };

function meta(id, res) {
  const h = res.headers;
  let name = "Sound";
  try { name = decodeURIComponent(h.get("x-name") || "") || name; } catch { /* bad header */ }
  const root = int(h.get("x-root"), 0, 127, 60);
  return { id, name: name.slice(0, 80), root, low: int(h.get("x-low"), 0, 127, 0), high: int(h.get("x-high"), 0, 127, 127) };
}

// Throws when the browser can't decode it, so nothing unplayable is stored.
export async function checkAudio(bytes) {
  const c = new OfflineAudioContext(1, 1, 44100);
  await c.decodeAudioData(bytes.slice(0));
}

export async function addSound(bytes, type, { name, root, low, high }, { cacheName = CACHE, id = crypto.randomUUID() } = {}) {
  const c = await caches.open(cacheName);
  await c.put(url(id), new Response(bytes, { headers: {
    "content-type": type || "application/octet-stream", "x-name": encodeURIComponent(String(name).slice(0, 80)),
    "x-root": String(root), "x-low": String(Math.min(low, high)), "x-high": String(Math.max(low, high)),
  } }));
  return id;
}

export async function listSounds({ cacheName = CACHE } = {}) {
  try {
    const c = await caches.open(cacheName);
    const out = [];
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (res) out.push(meta(decodeURIComponent(req.url.split("/").pop()), res));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; } // no Cache API (private mode, plain http)
}

// {id, name, root, low, high, bytes}, or null when it isn't there.
export async function getSound(id, { cacheName = CACHE } = {}) {
  try {
    const res = await (await caches.open(cacheName)).match(url(id));
    return res ? { ...meta(id, res), bytes: await res.arrayBuffer() } : null;
  } catch { return null; }
}

export async function removeSound(id, { cacheName = CACHE } = {}) {
  try { await (await caches.open(cacheName)).delete(url(id)); } catch { /* blocked */ }
}
