// Coda playback: sampled General MIDI sounds fetched on demand, with a triangle-wave fallback.
// See docs/DESIGN.md §7 and §13.3.
import { attrsAt, barCapacity, eventTicks, midi, PPQ, allLayers } from "./model.js";
import { GM } from "./gm.js";
import { getSound } from "./usersounds.js";

let ctx = null;
let current = null;

// Flatten the score into notes and bar start times, starting at bar `from`.
export function schedule(score, from = 0) {
  const barStart = [];
  let t = 0;
  for (let b = from; b < score.measures.length; b++) {
    barStart.push({ bar: b, tick: t });
    t += barCapacity(attrsAt(score, b).time);
  }
  const total = t;
  const notes = [];
  score.staves.forEach((st, si) => allLayers(st).forEach((bars) => {
    const open = new Map(); // midi -> note awaiting a tie continuation, per layer
    barStart.forEach(({ bar, tick }) => {
      let at = tick;
      for (const ev of bars[bar]) {
        const len = eventTicks(ev);
        const nextOpen = new Map();
        for (const p of ev.pitches) {
          const m = midi(p);
          let n = open.get(m);
          if (n && n.end === at) n.end = at + len;
          else { n = { start: at, end: at + len, midi: m, program: st.program ?? 0, staff: si, ...(st.sound ? { sound: st.sound } : {}) }; notes.push(n); }
          if (ev.tie) nextOpen.set(m, n);
          else if (ev.marks?.includes("staccato")) n.end = at + len / 2; // sounds half its length
        }
        open.clear();
        nextOpen.forEach((v, k) => open.set(k, v));
        at += len;
      }
    });
  }));
  return { notes, barStart, total };
}

export function isPlaying() { return !!current; }

// ---------- sounds on demand (DESIGN §13.3) ----------

// FluidR3_GM rendered by gleitz/midi-js-soundfonts (MIT; CC BY 3.0). Pinned commit first.
export const BASES = [
  "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM",
  "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM",
];
const CACHE = "coda-sounds-v1";
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
export const noteName = (m) => FLATS[m % 12] + (Math.floor(m / 12) - 1);
// One recording per 3 semitones, repitched (at most ±1 semitone).
export const rootFor = (m) => Math.min(108, Math.max(21, Math.round(m / 3) * 3));
const keyOf = (program, m) => `${program}:${rootFor(m)}`;
// Instruments whose notes are held (looped past the recording's length) rather than left to ring out.
export const sustained = (p) => (p >= 16 && p <= 23) || (p >= 40 && p <= 44) || (p >= 48 && p <= 54) || (p >= 56 && p <= 95);

// The sample keys ("program:root") a score's notes need.
export function needed(score) {
  return new Set(schedule(score).notes.map((n) => keyOf(n.program, n.midi)));
}

// Bytes of one recording: the browser cache, then each base in turn. Failures are not cached.
export async function fetchSample(program, root, { fetchFn = fetch, cacheName = CACHE } = {}) {
  const path = `/${GM[program].slug}-mp3/${noteName(root)}.mp3`;
  let cache = null;
  try {
    cache = await caches.open(cacheName);
    const hit = await cache.match(BASES[0] + path);
    if (hit) return await hit.arrayBuffer();
  } catch { cache = null; /* no Cache API (private mode, http): fetch every time */ }
  for (const base of BASES) {
    try {
      const res = await fetchFn(base + path);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      try { await cache?.put(BASES[0] + path, new Response(buf.slice(0), { headers: { "content-type": "audio/mpeg" } })); } catch { /* full */ }
      return buf;
    } catch { /* offline or blocked: try the next base */ }
  }
  throw new Error("Sound unavailable");
}

const buffers = new Map(); // key -> AudioBuffer, decoded once per session
const bytes = new Map(); // key -> Promise<ArrayBuffer>, shared by prefetch and load
const loading = new Map(); // key -> Promise<void>

function getBytes(key) {
  if (!bytes.has(key)) {
    const [p, root] = key.split(":").map(Number);
    bytes.set(key, fetchSample(p, root).catch((e) => { bytes.delete(key); throw e; }));
  }
  return bytes.get(key);
}

// A recording that downloaded but won't decode must not stay cached, or it would never be retried.
function uncache(key) {
  const [p, root] = key.split(":").map(Number);
  caches.open(CACHE).then((c) => c.delete(`${BASES[0]}/${GM[p].slug}-mp3/${noteName(root)}.mp3`)).catch(() => {});
}

function load(key) {
  if (buffers.has(key)) return Promise.resolve();
  if (!loading.has(key)) {
    loading.set(key, getBytes(key)
      .then((b) => audio().decodeAudioData(b).catch((e) => { uncache(key); throw e; }))
      .then((buf) => { buffers.set(key, buf); })
      .finally(() => { bytes.delete(key); loading.delete(key); }));
  }
  return loading.get(key);
}

// Start downloading what a score needs (after a file opens or an instrument changes).
// Only fetches into the browser cache; decoding waits until sound is first played.
export function prefetch(score) {
  for (const k of needed(score)) if (!buffers.has(k)) getBytes(k).catch(() => {});
}

function audio() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

// Output chain: a fresh gain (disconnected to silence it) into one compressor per context,
// so big chords and many parts don't clip.
const comps = new WeakMap();
export function output(c) {
  if (!comps.has(c)) { const comp = c.createDynamicsCompressor(); comp.connect(c.destination); comps.set(c, comp); }
  const g = c.createGain();
  g.gain.value = 0.8;
  g.connect(comps.get(c));
  return g;
}

// One sampled note into `dest` on context `c`.
export function sampledVoice(c, dest, buf, m, root, start, len, hold) {
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (m - root) / 12);
  // ponytail: fixed 0.8–2.4 s loop with no crossfade; may click on some sounds. Per-instrument loop points if it bothers anyone.
  if (hold && buf.duration > 2.4) { src.loop = true; src.loopStart = 0.8; src.loopEnd = 2.4; }
  const g = c.createGain(), rel = hold ? 0.12 : 0.3;
  g.gain.setValueAtTime(0.4, start);
  g.gain.setValueAtTime(0.4, start + len);
  g.gain.linearRampToValueAtTime(0, start + len + rel);
  src.connect(g).connect(dest);
  src.start(start);
  src.stop(start + len + rel + 0.02);
}

// ---------- your own sounds (DESIGN §18) ----------

const users = new Map(); // id -> {buf, root, low, high}, or null when missing or undecodable
const userLoading = new Map();
function loadUser(id) {
  if (users.has(id)) return Promise.resolve();
  if (!userLoading.has(id)) {
    userLoading.set(id, getSound(id)
      .then(async (s) => { users.set(id, s && { root: s.root, low: s.low, high: s.high, buf: await audio().decodeAudioData(s.bytes) }); })
      .catch(() => users.set(id, null))
      .finally(() => userLoading.delete(id)));
  }
  return userLoading.get(id);
}
// Forget a sound after it is added, replaced or deleted.
export function forgetUserSound(id) { users.delete(id); }
// The user sound for this note, if it's loaded and the note is in its range.
function userFor(sound, m) {
  const u = sound && users.get(sound);
  return u && m >= u.low && m <= u.high ? u : null;
}

// A note with whatever is available now: your sound, the sample if loaded, else the triangle voice.
function note(c, dest, m, program, start, len, sound) {
  const u = userFor(sound, m);
  if (u) { sampledVoice(c, dest, u.buf, m, u.root, start, len, false); return; }
  const buf = buffers.get(keyOf(program, m));
  if (buf) sampledVoice(c, dest, buf, m, rootFor(m), start, len, sustained(program));
  else voice(c, dest, m, start, len);
}

// One triangle-wave note into `dest`.
function voice(c, dest, m, start, len) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "triangle";
  osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.15, start + 0.01);
  g.gain.setValueAtTime(0.15, start + len - 0.05);
  g.gain.linearRampToValueAtTime(0, start + len);
  osc.connect(g).connect(dest);
  osc.start(start);
  osc.stop(start + len + 0.02);
}

// Sound a chord briefly while editing (DESIGN §11.2). Silent during playback.
// Uses the sample if it's loaded; otherwise the tone now, and the sample is fetched for next time.
export function audition(midis, program = 0, sound) {
  if (current || !midis.length) return;
  try {
    audio();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime + 0.02, out = output(ctx);
    setTimeout(() => out.disconnect(), 2000);
    for (const m of midis) {
      note(ctx, out, m, program, t, 0.35, sound);
      if (!userFor(sound, m)) load(keyOf(program, m)).catch(() => {});
    }
    if (sound) loadUser(sound);
  } catch { /* audio unavailable: editing still works */ }
}

// Load what `notes` need: your sounds, then GM samples (giving up after `waitMs`).
// Returns a status line about notes that won't sound as chosen, or "" when all is well.
async function prepare(notes, waitMs, onStatus = () => {}) {
  const ids = [...new Set(notes.filter((n) => n.sound).map((n) => n.sound))];
  if (ids.length) await Promise.all(ids.map(loadUser));
  // notes your sound can't play (missing, or outside its range) use the part's instrument instead
  const fell = notes.filter((n) => n.sound && !userFor(n.sound, n.midi)).length;
  const keys = [...new Set(notes.filter((n) => !userFor(n.sound, n.midi)).map((n) => keyOf(n.program, n.midi)))].filter((k) => !buffers.has(k));
  const msgs = fell ? [`${fell} note${fell > 1 ? "s" : ""} outside your sound's range (or a missing sound) play the part's instrument.`] : [];
  if (keys.length) {
    onStatus("Loading sounds…");
    const all = Promise.allSettled(keys.map(load));
    await (waitMs === Infinity ? all : Promise.race([all, new Promise((r) => setTimeout(r, waitMs))]));
    if (keys.some((k) => !buffers.has(k))) msgs.push("Some instrument sounds couldn't be loaded, so those notes play a plain tone.");
    else if (!msgs.length) onStatus("");
  }
  return msgs.join(" ");
}

// Every note into context `c` from time t0. Play and the audio export share this.
// ponytail: schedules every note up front; fine for a few thousand notes. Switch to a
// look-ahead scheduler if long scores stutter.
function scheduleNotes(c, dest, notes, t0, secPerTick) {
  for (const n of notes) {
    const len = Math.max(0.06, (n.end - n.start) * secPerTick);
    note(c, dest, n.midi, n.program, t0 + n.start * secPerTick, len, n.sound);
  }
}

// The whole score rendered offline (DESIGN §19): {buffer, status}. Waits for every sound.
export async function renderAudio(score, onStatus = () => {}, rate = 44100) {
  const { notes, total } = schedule(score);
  audio(); // decoding uses the live context
  const status = await prepare(notes, Infinity, onStatus);
  const secPerTick = 60 / (score.tempo || 100) / PPQ;
  const c = new OfflineAudioContext(2, Math.ceil((total * secPerTick + 2.5) * rate), rate);
  scheduleNotes(c, output(c), notes, 0.05, secPerTick);
  onStatus("Rendering audio…");
  return { buffer: await c.startRendering(), status };
}

// 16-bit PCM WAV bytes of an AudioBuffer.
export function wavBytes(buf) {
  const ch = buf.numberOfChannels, n = buf.length, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVEfmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  for (let i = 0, o = 44; i < n; i++) for (let k = 0; k < ch; k++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, data[k][i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}

// A compressed recording of `buf`, made by playing it (silently) in real time through
// MediaRecorder, the only encoder browsers have built in. null type = not supported here.
export const recordType = () => typeof MediaRecorder === "undefined" ? null
  : ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || null;
export function recordCompressed(buf, onProgress = () => {}) {
  const type = recordType();
  const c = audio(), dest = c.createMediaStreamDestination(), src = c.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: type });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  return new Promise((resolve, reject) => {
    rec.onstop = () => { clearInterval(tm); resolve(new Blob(parts, { type: type.split(";")[0] })); };
    rec.onerror = (e) => { clearInterval(tm); reject(e.error || new Error("Recording failed")); };
    src.onended = () => setTimeout(() => rec.stop(), 200);
    const t0 = c.currentTime;
    const tm = setInterval(() => onProgress(Math.min(1, (c.currentTime - t0) / buf.duration)), 500);
    c.resume().then(() => { rec.start(); src.start(); });
  });
}

// Start playback. `onBar(barIndex|null)` is called as each bar starts, and with null at the end.
// `onStatus(text)` reports loading and missing sounds.
export async function play(score, from, onBar, onStatus = () => {}) {
  stop();
  const me = { master: null, raf: 0, lastBar: -1 };
  current = me; // set before awaiting, so Stop while sounds load works
  try { await start(me, score, from, onBar, onStatus); }
  catch (e) { if (current === me) stop(); throw e; }
}

async function start(me, score, from, onBar, onStatus) {
  audio();
  if (ctx.state === "suspended") await ctx.resume();
  if (current !== me) return;
  const { notes, barStart, total } = schedule(score, from);
  const msgs = await prepare(notes, 8000, onStatus);
  if (current !== me) return;
  if (msgs) onStatus(msgs);
  const secPerTick = 60 / (score.tempo || 100) / PPQ;
  const master = output(ctx);
  me.master = master;
  const t0 = ctx.currentTime + 0.1;
  scheduleNotes(ctx, master, notes, t0, secPerTick);
  const tick = () => {
    if (current !== me) return;
    const now = (ctx.currentTime - t0) / secPerTick;
    if (now >= total) { stop(); onBar(null); return; }
    let bar = barStart[0].bar;
    for (const b of barStart) if (b.tick <= now) bar = b.bar;
    if (bar !== me.lastBar) { me.lastBar = bar; onBar(bar); }
    me.raf = requestAnimationFrame(tick);
  };
  me.raf = requestAnimationFrame(tick);
}

export function stop() {
  if (!current) return;
  cancelAnimationFrame(current.raf);
  try { current.master?.disconnect(); } catch { /* already gone */ }
  current = null;
}
