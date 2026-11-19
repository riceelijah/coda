// Coda playback: sampled General MIDI sounds fetched on demand, with a triangle-wave fallback.
// See docs/DESIGN.md §7 and §13.3.
import { attrsAt, barCapacity, eventTicks, midi as midiOf, PPQ, allLayers, partGroups, DYN_VEL, ACCENT_VEL, isPerc, playOrder, tempoAt } from "./model.js";
import { drumHit } from "./drumsynth.js";
import { GM } from "./gm.js";
import { getSound } from "./usersounds.js";

let ctx = null;
let current = null;

// Flatten the score into notes and bar start times, in playing order (repeats and jumps unrolled,
// DESIGN §28), starting where bar `from` first plays (straight on from it if it never does).
export function schedule(score, from = 0) {
  const order = playOrder(score);
  let seq = order.slice(Math.max(0, order.indexOf(from)));
  if (!order.includes(from)) seq = score.measures.map((_, b) => b).slice(from);
  const barStart = [], lin = []; // lin[b]: bar b's start in the score as written, for dynamics
  let t = 0;
  score.measures.forEach((_, b) => { lin.push(t); t += barCapacity(attrsAt(score, b).time); });
  t = 0;
  for (const b of seq) {
    barStart.push({ bar: b, tick: t });
    t += barCapacity(attrsAt(score, b).time);
  }
  const total = t;
  // seconds at an unrolled tick, each bar at its own tempo (DESIGN §29)
  const secs = [0];
  barStart.forEach(({ bar, tick }, k) => secs.push(secs[k] + ((barStart[k + 1]?.tick ?? total) - tick) * 60 / tempoAt(score, bar) / PPQ));
  const timeOf = (x) => {
    let k = 0;
    while (k + 1 < barStart.length && barStart[k + 1].tick <= x) k++;
    if (!barStart.length) return x * 60 / (score.tempo || 100) / PPQ;
    return secs[k] + (x - barStart[k].tick) * 60 / tempoAt(score, barStart[k].bar) / PPQ;
  };
  const notes = [];
  const linVel = dynamics(score, 0);
  score.staves.forEach((st, si) => allLayers(st).forEach((bars) => {
    const open = new Map(); // midi -> note awaiting a tie continuation, per layer
    let slide = null; // the notes a slide starts from (DESIGN §31): {from: [note per pitch], t0, end}
    barStart.forEach(({ bar, tick }, k) => {
      let at = tick;
      if (k && barStart[k - 1].bar !== bar - 1) { open.clear(); slide = null; } // after a repeat or jump: a tie or slide doesn't carry over
      const velAt = (si, a) => linVel(si, lin[bar] + a - tick);
      for (const ev of bars[bar]) {
        const len = eventTicks(ev);
        // a drum staff plays its drum numbers on the kit, program -1 (DESIGN §27)
        const perc = isPerc(st), nextOpen = new Map(), tr = st.transpose?.[0] || 0, base = { vel: velAt(si, at), program: perc ? -1 : st.program ?? 0, staff: si, ...(st.sound && !perc ? { sound: st.sound } : {}) };
        const midi = (p) => (perc ? p.drum - tr : midiOf(p));
        // grace notes (DESIGN §26) take a 32nd each, at most half the note, from the start of the beat
        const g = ev.grace ? Math.min(60, Math.floor(len / 2 / ev.grace.length)) : 0;
        (ev.grace || []).forEach((p, k) => notes.push({ start: at + k * g, end: at + (k + 1) * g, midi: midi(p) + tr, ...base }));
        const on = at + g * (ev.grace?.length || 0);
        const from = slide && slide.end === at && !g && !perc ? slide.from : null, made = [];
        ev.pitches.forEach((p, k) => {
          const m = midi(p) + tr; // sounding pitch (DESIGN §21)
          let n = open.get(m);
          if (n && n.end === at && !g) n.end = at + len;
          else {
            n = { start: on, end: at + len, midi: m, ...base };
            notes.push(n);
            const r = from?.[k]?.root || from?.[k];
            // a slide: the first note's voice glides here and keeps sounding; this one is for MIDI only
            if (r) { n.root = r; (r.glide ||= []).push({ t0: slide.t0, t1: at, to: m - r.midi, note: n }); }
            else if (ev.marks?.includes("scoop") && !perc) n.scoop = true;
          }
          if (!perc && ev.marks?.includes("fall")) (n.root || n).fall = -1;
          if (!perc && ev.marks?.includes("doit")) (n.root || n).fall = 1;
          made.push(n);
          if (ev.tie) nextOpen.set(m, n);
          else if (ev.marks?.includes("staccato")) n.end = (Math.max(n.start, at) + at + len) / 2; // sounds half its length (after any grace notes)
        });
        // a slide takes the last half of its note, at most a beat
        slide = ev.gliss && !perc ? { from: made, t0: Math.max(at + len / 2, at + len - PPQ), end: at + len } : null;
        open.clear();
        nextOpen.forEach((v, k) => open.set(k, v));
        at += len;
      }
    });
  }));
  return { notes, barStart, total, timeOf };
}

// Velocity at a tick (relative to bar `from`) for staff si (DESIGN §22). A part's dynamics, from
// any of its staves and layers, apply to the whole part; mf before the first one.
function dynamics(score, from) {
  const starts = [];
  let t = 0;
  score.measures.forEach((m, b) => { starts.push(t); t += barCapacity(attrsAt(score, b).time); });
  const off = starts[from] || 0, byStaff = [];
  for (const g of partGroups(score)) {
    const levels = [], accents = new Map(), ramps = [];
    for (const s of g) allLayers(score.staves[s]).forEach((bars, li) => {
      let open = null; // hairpin started in this layer: {t0, dir, k}
      bars.forEach((bar, b) => {
        let at = starts[b] - off;
        for (const ev of bar) {
          if (DYN_VEL[ev.dyn]) levels.push([at, DYN_VEL[ev.dyn]]);
          else if (ev.dyn) { accents.set(at, ACCENT_VEL[ev.dyn]); if (ev.dyn === "fp") levels.push([at + 1, DYN_VEL.p]); }
          if (ev.hpEnd && open) { ramps.push({ ...open, t1: at + eventTicks(ev) }); open = null; } // an end first: a new one may start here
          if (ev.hp) open = { t0: at, dir: ev.hp === "<" ? 1 : -1, k: `${s}:${li}` };
          at += eventTicks(ev);
        }
      });
    });
    const byTime = (a, b) => a[0] - b[0];
    levels.sort(byTime);
    const levelAt = (tick) => {
      let v = DYN_VEL.mf;
      for (const [lt, lv] of levels) { if (lt > tick) break; v = lv; }
      return v;
    };
    // hairpins (DESIGN §23): from the level where they start to the next dynamic when it comes by a
    // beat after the end and goes their way, else 16 steps. A ramp stops early at a dynamic inside
    // it or where the next hairpin starts (a swell's peak); the level reached holds afterwards.
    const dyns = [...levels], done = [];
    const at = (tick) => {
      if (accents.has(tick)) return accents.get(tick);
      const r = done.find((x) => tick >= x.t0 && tick < x.t1);
      return r ? Math.round(r.v0 + ((r.v1 - r.v0) * (tick - r.t0)) / (r.t1 - r.t0)) : levelAt(tick);
    };
    ramps.sort((a, b) => a.t0 - b.t0);
    ramps.forEach((r, i) => {
      const s0 = accents.has(r.t0) ? r.t0 + 1 : r.t0; // an accent is one note, not the level (fp: the p after it)
      const next = dyns.find(([lt]) => lt > s0 && lt <= r.t1 + PPQ);
      r.v0 = accents.has(r.t0) ? levelAt(s0) : at(r.t0);
      r.v1 = next && (next[1] - r.v0) * r.dir > 0 ? next[1] : Math.max(16, Math.min(127, r.v0 + 16 * r.dir));
      const nx = ramps.slice(i + 1).find((x) => x.k === r.k); // a swell's next half, same layer
      r.t1 = Math.min(r.t1, next && next[0] < r.t1 ? next[0] : Infinity, nx && nx.t0 > r.t0 ? nx.t0 : Infinity);
      done.push(r);
      levels.push([r.t1 - 0.5, r.v1]); // just before the end, so a dynamic there still wins
      levels.sort(byTime);
    });
    for (const s of g) byStaff[s] = at;
  }
  return (s, tick) => byStaff[s](tick);
}

export function isPlaying() { return !!current; }

// ---------- sounds on demand (DESIGN §13.3) ----------

// FluidR3_GM rendered by gleitz/midi-js-soundfonts (MIT; CC BY 3.0). Pinned commit first.
export const BASES = [
  "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@044fab8e1456bfafc5776e86dfd6bb8697149aef/FluidR3_GM",
  "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM",
];
// The GM drum kit (DESIGN §27): FluidR3's Standard kit, one hit per drum, packaged as JS with a
// base64 mp3 by surikov/webaudiofontdata (MIT; FluidR3 MIT). Pinned commit first.
export const DRUM_BASES = [
  "https://cdn.jsdelivr.net/gh/surikov/webaudiofontdata@23ca907d4370a04fd89ca483a92915e4d6159ab9/sound",
  "https://surikov.github.io/webaudiofontdata/sound",
];
const CACHE = "coda-sounds-v1";
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
export const noteName = (m) => FLATS[m % 12] + (Math.floor(m / 12) - 1);
// One recording per 3 semitones, repitched (at most ±1 semitone).
export const rootFor = (m) => Math.min(108, Math.max(21, Math.round(m / 3) * 3));
// Drums (program -1) have one recording per drum, played as recorded.
const keyOf = (program, m) => (program < 0 ? `-1:${m}` : `${program}:${rootFor(m)}`);
// Where one recording lives: hosts in order, and the path on each.
const sourceOf = (program, root) => (program < 0 ? { bases: DRUM_BASES, path: `/128${root}_0_FluidR3_GM_sf2_file.js` }
  : { bases: BASES, path: `/${GM[program].slug}-mp3/${noteName(root)}.mp3` });
// A drum file is a script holding the mp3 as base64; read it out rather than run it.
function drumMp3(text) {
  const b64 = /file:'([A-Za-z0-9+/=]+)'/.exec(text)?.[1];
  if (!b64) throw new Error("Not a drum sample");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}
// Instruments whose notes are held (looped past the recording's length) rather than left to ring out.
export const sustained = (p) => (p >= 16 && p <= 23) || (p >= 40 && p <= 44) || (p >= 48 && p <= 54) || (p >= 56 && p <= 95);

// The sample keys ("program:root") a score's notes need.
export function needed(score) {
  return new Set(schedule(score).notes.filter((n) => !n.root).map((n) => keyOf(n.program, n.midi)));
}

// Bytes of one recording: the browser cache, then each base in turn. Failures are not cached.
export async function fetchSample(program, root, { fetchFn = fetch, cacheName = CACHE } = {}) {
  const { bases, path } = sourceOf(program, root);
  let cache = null;
  try {
    cache = await caches.open(cacheName);
    const hit = await cache.match(bases[0] + path);
    if (hit) return await hit.arrayBuffer();
  } catch { cache = null; /* no Cache API (private mode, http): fetch every time */ }
  for (const base of bases) {
    try {
      const res = await fetchFn(base + path);
      if (!res.ok) continue;
      const buf = program < 0 ? drumMp3(await res.text()) : await res.arrayBuffer(); // cached as the mp3 either way
      try { await cache?.put(bases[0] + path, new Response(buf.slice(0), { headers: { "content-type": "audio/mpeg" } })); } catch { /* full */ }
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
  const { bases, path } = sourceOf(...key.split(":").map(Number));
  caches.open(CACHE).then((c) => c.delete(bases[0] + path)).catch(() => {});
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
export function sampledVoice(c, dest, buf, m, root, start, len, hold, level = 1, fx = null) {
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, (m - root) / 12);
  bend(src.playbackRate, src.playbackRate.value, start, fx);
  // ponytail: fixed 0.8–2.4 s loop with no crossfade; may click on some sounds. Per-instrument loop points if it bothers anyone.
  if (hold && buf.duration > 2.4) { src.loop = true; src.loopStart = 0.8; src.loopEnd = 2.4; }
  const g = c.createGain(), rel = hold ? 0.12 : 0.3;
  g.gain.setValueAtTime(0.4 * level, start);
  if (fx?.fade != null) { g.gain.setValueAtTime(0.4 * level, start + fx.fade); g.gain.linearRampToValueAtTime(0, start + len); } // a fall dies away
  else { g.gain.setValueAtTime(0.4 * level, start + len); g.gain.linearRampToValueAtTime(0, start + len + rel); }
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
// vel: MIDI velocity, 80 (mf) plays at the usual level.
// fx: pitch bends from bendOf (DESIGN §31), or null.
function note(c, dest, m, program, start, len, sound, vel = 80, fx = null) {
  if (program < 0) { // the sampled kit, or the built-in synth when it isn't loaded (offline)
    const b = buffers.get(keyOf(-1, m));
    if (b) sampledVoice(c, dest, b, m, m, start, b.duration, false, vel / 80); else drumHit(c, dest, m, start, vel / 80);
    return;
  }
  const u = userFor(sound, m), level = vel / 80;
  if (u) { sampledVoice(c, dest, u.buf, m, u.root, start, len, false, level, fx); return; }
  const buf = buffers.get(keyOf(program, m));
  if (buf) sampledVoice(c, dest, buf, m, rootFor(m), start, len, sustained(program), level, fx);
  else voice(c, dest, m, start, len, level, fx);
}

// One triangle-wave note into `dest`.
function voice(c, dest, m, start, len, level = 1, fx = null) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "triangle";
  osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
  bend(osc.frequency, osc.frequency.value, start, fx);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.15 * level, start + 0.01);
  g.gain.setValueAtTime(0.15 * level, start + Math.max(0.01, fx?.fade ?? len - 0.05));
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
async function prepare(all, waitMs, onStatus = () => {}) {
  const notes = all.filter((n) => !n.root); // a slide's target sounds on its first note's voice (DESIGN §31)
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
    if (keys.some((k) => !buffers.has(k))) msgs.push("Some instrument sounds couldn't be loaded, so those notes play a plain tone (drums: the built-in kit).");
    else if (!msgs.length) onStatus("");
  }
  return msgs.join(" ");
}

// Every note into context `c` from time t0. Play and the audio export share this.
// ponytail: schedules every note up front; fine for a few thousand notes. Switch to a
// look-ahead scheduler if long scores stutter.
function scheduleNotes(c, dest, notes, t0, timeOf) {
  for (const n of notes) {
    if (n.root) continue; // sounded by the note its slide starts from
    const end = Math.max(n.end, ...(n.glide || []).map((s) => s.note.end));
    const len = Math.max(0.06, timeOf(end) - timeOf(n.start));
    note(c, dest, n.midi, n.program, t0 + timeOf(n.start), len, n.sound, n.vel, bendOf(n, len, timeOf));
  }
}

// Pitch moves within one sounding note (DESIGN §31): {segs: [[t0, semis, t1, semis]…] in seconds
// from its start, in order, fade: when a fall or doit starts fading}, or null.
export function bendOf(n, len, timeOf) {
  const sec = (t) => timeOf(t) - timeOf(n.start); // tick -> seconds from the note's start, at each bar's tempo
  const segs = [];
  let at = 0, cur = 0;
  if (n.scoop) { at = Math.min(0.12, len / 3); segs.push([0, -3, at, 0]); } // up from a minor third below
  for (const s of n.glide || []) {
    const a = Math.max(at, sec(s.t0)), z = Math.max(a + 0.02, sec(s.t1));
    segs.push([a, cur, z, s.to]);
    at = z; cur = s.to;
  }
  let fade = null;
  if (n.fall) { fade = Math.max(at, len - Math.min(0.3, len / 2)); segs.push([fade, cur, len, cur + 7 * n.fall]); } // a fifth away
  return segs.length ? { segs, fade } : null;
}
// Apply bend segments to a rate or frequency param whose steady value is `base`.
function bend(param, base, start, fx) {
  for (const [a, s0, z, s1] of fx?.segs || []) {
    param.setValueAtTime(base * 2 ** (s0 / 12), start + a);
    param.exponentialRampToValueAtTime(base * 2 ** (s1 / 12), start + z);
  }
}

// The whole score rendered offline (DESIGN §19): {buffer, status}. Waits for every sound.
export async function renderAudio(score, onStatus = () => {}, rate = 44100, waitMs = Infinity) {
  const { notes, total, timeOf } = schedule(score);
  audio(); // decoding uses the live context
  const status = await prepare(notes, waitMs, onStatus);
  const c = new OfflineAudioContext(2, Math.ceil((timeOf(total) + 2.5) * rate), rate);
  scheduleNotes(c, output(c), notes, 0.05, timeOf);
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
  let stopped = false;
  recording = () => { stopped = true; try { src.stop(); } catch { /* not started */ } };
  return new Promise((resolve, reject) => {
    rec.onstop = () => {
      clearInterval(tm); recording = null;
      if (stopped) reject(new Error("Stopped")); else resolve(new Blob(parts, { type: type.split(";")[0] }));
    };
    rec.onerror = (e) => { clearInterval(tm); reject(e.error || new Error("Recording failed")); };
    src.onended = () => setTimeout(() => rec.stop(), 200);
    const t0 = c.currentTime;
    const tm = setInterval(() => onProgress(Math.min(1, (c.currentTime - t0) / buf.duration)), 500);
    c.resume().then(() => {
      if (stopped) { clearInterval(tm); recording = null; reject(new Error("Stopped")); return; }
      rec.start(); src.start();
    });
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
  const { notes, barStart, total, timeOf } = schedule(score, from);
  const msgs = await prepare(notes, 8000, onStatus);
  if (current !== me) return;
  if (msgs) onStatus(msgs);
  const master = output(ctx);
  me.master = master;
  const t0 = ctx.currentTime + 0.1;
  scheduleNotes(ctx, master, notes, t0, timeOf);
  const end = timeOf(total), at = barStart.map((b) => timeOf(b.tick));
  const tick = () => {
    if (current !== me) return;
    const now = ctx.currentTime - t0;
    if (now >= end) { stop(); onBar(null); return; }
    let bar = barStart[0].bar;
    barStart.forEach((b, k) => { if (at[k] <= now) bar = b.bar; });
    if (bar !== me.lastBar) { me.lastBar = bar; onBar(bar); }
    me.raf = requestAnimationFrame(tick);
  };
  me.raf = requestAnimationFrame(tick);
}

let recording = null; // cancels the compressed-audio recording in progress

export function stop() {
  recording?.();
  if (!current) return;
  cancelAnimationFrame(current.raf);
  try { current.master?.disconnect(); } catch { /* already gone */ }
  current = null;
}
