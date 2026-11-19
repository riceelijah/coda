// Coda playback: sampled General MIDI sounds fetched on demand, with a triangle-wave fallback.
// See docs/DESIGN.md §7 and §13.3.
import { attrsAt, barCapacity, barLen, eventTicks, midi as midiOf, keyAt, keyAlter, diatonic, fromDiatonic, PPQ, allLayers, partGroups, DYN_VEL, ACCENT_VEL, isPerc, playOrder, tempoAt, staffLines, ottAt } from "./model.js";
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
  score.measures.forEach((_, b) => { lin.push(t); t += barLen(score, b); });
  t = 0;
  for (const b of seq) {
    barStart.push({ bar: b, tick: t });
    t += barLen(score, b);
  }
  const total = t;
  // seconds at an unrolled tick, each bar at its own tempo (DESIGN §29)
  const secs = [0];
  barStart.forEach(({ bar, tick }, k) => secs.push(secs[k] + ((barStart[k + 1]?.tick ?? total) - tick) * 60 / tempoAt(score, bar) / PPQ));
  const plain = (x) => {
    let k = 0;
    while (k + 1 < barStart.length && barStart[k + 1].tick <= x) k++;
    if (!barStart.length) return x * 60 / (score.tempo || 100) / PPQ;
    return secs[k] + (x - barStart[k].tick) * 60 / tempoAt(score, barStart[k].bar) / PPQ;
  };
  // fermatas (DESIGN §34): a held note or rest takes twice as long, for every part. Seconds
  // stretch, ticks don't. fermatas: unrolled start tick -> its length (the shortest held there).
  const fermatas = new Map();
  let holds = null; // fermata spans merged where they overlap, each with its extra seconds and the total before it
  const timeOf = (x) => {
    if (!holds) {
      holds = [];
      for (const [a, l] of [...fermatas].sort((p, q) => p[0] - q[0])) {
        const h = holds[holds.length - 1];
        if (h && a <= h.z) h.z = Math.max(h.z, a + l); else holds.push({ a, z: a + l });
      }
      let sum = 0;
      for (const h of holds) { h.before = sum; h.pa = plain(h.a); h.extra = plain(h.z) - h.pa; sum += h.extra; }
    }
    let t = plain(x), k = holds.length - 1;
    while (k >= 0 && holds[k].a >= x) k--;
    if (k < 0) return t;
    const h = holds[k];
    return t + h.before + (x >= h.z ? h.extra : t - h.pa);
  };
  const held = () => { timeOf(0); return holds; };
  const notes = [];
  const linVel = dynamics(score, 0);
  const lines = score.staves.map((_, si) => staffLines(score, si)); // octave lines and pedal marks (DESIGN §37)
  score.staves.forEach((st, si) => allLayers(st).forEach((bars) => {
    const open = new Map(); // midi -> note awaiting a tie continuation, per layer
    let slide = null; // the notes a slide starts from (DESIGN §31): {from: [note per pitch], t0, end}
    barStart.forEach(({ bar, tick }, k) => {
      let at = tick;
      if (k && barStart[k - 1].bar !== bar - 1) { open.clear(); slide = null; } // after a repeat or jump: a tie or slide doesn't carry over
      const velAt = (si, a) => linVel(si, lin[bar] + a - tick);
      for (const ev of bars[bar]) {
        const len = eventTicks(ev);
        if (ev.marks?.includes("fermata")) fermatas.set(at, Math.min(fermatas.get(at) ?? Infinity, len));
        // a drum staff plays its drum numbers on the kit, program -1 (DESIGN §27)
        const perc = isPerc(st), nextOpen = new Map(), tr = st.transpose?.[0] || 0, base = { vel: velAt(si, at), program: perc ? -1 : st.program ?? 0, staff: si, ...(st.sound && !perc ? { sound: st.sound } : {}) };
        const lin0 = lin[bar] - tick, oct = perc ? 0 : ottAt(lines[si], at + lin0);
        const midi = (p) => (perc ? p.drum - tr : midiOf(p) + 12 * oct);
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
        if (ev.marks) perform(ev, made.map((n, k) => ({ n, p: ev.pitches[k] })).filter(({ n }) => n.start === on && !n.root && !n.glide), notes,
          { at, len, perc, tied: !!ev.tie || !!ev.gliss, top: ev.pitches[ev.pitches.length - 1], key: keyAt(score, si, bar), tr: tr + 12 * oct });
        // a slide takes the last half of its note, at most a beat
        slide = ev.gliss && !perc ? { from: made, t0: Math.max(at + len / 2, at + len - PPQ), end: at + len } : null;
        open.clear();
        nextOpen.forEach((v, k) => open.set(k, v));
        at += len;
      }
    });
  }));
  const pedals = lines.map(({ ped }) => { // unrolled: [down, up] per staff
    const out = [];
    for (const r of ped) {
      // one pedal's pieces join where the music goes straight on; a repeat lifts it; two pedals
      // side by side stay apart (a change)
      let last = null, wz = null;
      for (const { bar, tick } of barStart) {
        const a = Math.max(r.a, lin[bar]), z = Math.min(r.z, lin[bar] + barLen(score, bar));
        if (a >= z) continue;
        const u = [tick + a - lin[bar], tick + z - lin[bar]];
        if (last && last[1] === u[0] && wz === a) last[1] = u[1]; else out.push((last = u));
        wz = z;
      }
    }
    return out.sort((p, q) => p[0] - q[0]);
  });
  // the pedal lets every note struck under it ring until it lifts: ring is for audio, MIDI writes the pedal
  for (const n of notes) {
    const q = pedals[n.staff].find(([a, z]) => n.start >= a && n.start < z);
    if (q && q[1] > n.end) n.ring = q[1];
  }
  return { notes: notes.filter((n) => n.midi >= 0 && n.midi <= 127), barStart, total, timeOf, held, pedals }; // octave lines can take a note off the keyboard
}

// How marks sound (DESIGN §34). `fresh`: this event's newly struck notes, low to high (not tied
// into, not part of a slide). Ornaments and tremolos split the top note into short notes; a tied
// note keeps its ornament silent so the tie still holds.
const SHORT = 60; // a 32nd
function perform(ev, pairs, list, { at, len, perc, tied, top: evTop, key, tr }) {
  const has = (m) => ev.marks.includes(m), fresh = pairs.map((x) => x.n);
  for (const n of fresh) {
    if (has("accent")) n.vel = Math.min(127, n.vel + 20);
    if (has("marcato")) n.vel = Math.min(127, n.vel + 30);
    if (has("breath") || has("caesura")) n.end = Math.max(n.start + Math.min(SHORT, n.end - n.start), Math.min(n.end, at + len - Math.min(len / 4, PPQ / 2)));
  }
  if (has("arpeggio") && fresh.length > 1) {
    const span = Math.min(...fresh.map((n) => n.end - n.start)), step = Math.min(SHORT / 2, span / 2 / fresh.length);
    fresh.forEach((n, k) => { n.start += k * step; });
  }
  // the ornament is the chord's top note's; none when that note is tied into, tied on, or slides
  const top = fresh[fresh.length - 1], tp = pairs[pairs.length - 1]?.p;
  if (!top || tied || tp !== evTop) return;
  const neighbour = (d) => { // the written note a step away, in the written key, as it sounds
    const q = fromDiatonic(diatonic(tp) + d);
    return midiOf({ ...q, alter: keyAlter(key, q.step) }) + tr;
  };
  let seq = null; // [midi, ticks]...
  const m = top.midi, avail = top.end - top.start, reps = Math.floor(avail / SHORT);
  const quick = Math.min(SHORT, avail / 3); // a mordent's two quick notes leave the main note a third at least
  if (has("tremolo")) seq = reps > 1 ? Array.from({ length: reps }, () => [m, SHORT]) : null;
  else if (perc) return;
  else if (has("trill")) seq = reps > 1 ? Array.from({ length: reps }, (_, k) => [k % 2 ? neighbour(1) : m, SHORT]) : null;
  else if (has("mordent")) seq = [[m, quick], [neighbour(-1), quick]];
  else if (has("invMordent")) seq = [[m, quick], [neighbour(1), quick]];
  else if (has("turn")) seq = [[neighbour(1), avail / 4], [m, avail / 4], [neighbour(-1), avail / 4]];
  if (!seq || avail < 4) return;
  const end = top.end, fall = top.fall;
  delete top.fall; // a fall or doit belongs to the last piece, a scoop to the first
  const pieces = [];
  let t = top.start;
  seq.forEach(([mm, d], k) => {
    if (t >= end) return;
    const n = k ? { ...top, midi: mm, start: t } : top;
    if (k) delete n.scoop;
    n.midi = mm; n.end = Math.min(end, t + d);
    pieces.push(n);
    t += d;
  });
  if (t < end && !has("trill") && !has("tremolo")) { const n = { ...top, midi: m, start: t, end }; delete n.scoop; pieces.push(n); }
  if (fall) pieces[pieces.length - 1].fall = fall;
  list.push(...pieces.slice(1));
}

// Velocity at a tick (relative to bar `from`) for staff si (DESIGN §22). A part's dynamics, from
// any of its staves and layers, apply to the whole part; mf before the first one.
function dynamics(score, from) {
  const starts = [];
  let t = 0;
  score.measures.forEach((m, b) => { starts.push(t); t += barLen(score, b); });
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
    // ponytail: the kit's only retuned hit is 35, drum 36's recording a semitone down (all 47 checked;
    // 8 others are 5–6 cents off, left alone). Read originalPitch from the file if the kit changes.
    if (b) sampledVoice(c, dest, b, m, m === 35 ? 36 : m, start, b.duration, false, vel / 80); else drumHit(c, dest, m, start, vel / 80);
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
function scheduleNotes(c, dest, notes, t0, timeOf, limit = Infinity) {
  for (const n of notes) {
    if (n.root) continue; // sounded by the note its slide starts from
    const end = Math.min(limit, Math.max(n.end, n.ring || 0, ...(n.glide || []).map((s) => s.note.end))); // a range played stops at its end
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

// Metronome beats in bar b (DESIGN §39): ticks from the bar's start. Compound time beats in dotted
// quarters. A pickup counts from the bar's end, so its beats line up with bar 2's.
export function beatsOf(score, b) {
  const { time } = attrsAt(score, b), cap = barCapacity(time), len = barLen(score, b);
  const beat = time[1] === 8 && time[0] % 3 === 0 && time[0] > 3 ? 720 : 1920 / time[1];
  const off = b === 0 && len < cap ? cap - len : 0, out = [];
  for (let t = Math.ceil(off / beat) * beat; t < off + len; t += beat) out.push(t - off);
  return { beat, off, cap, ticks: out };
}
const click = (start, accent) => ({ start, end: start + 60, midi: accent ? 76 : 77, program: -1, vel: accent ? 100 : 75, staff: -1 });
// Clicks for the bars played, and a count-in before them: the missing beats of a pickup, else a bar.
export function clicks(score, barStart, total, { click: on, countIn }) {
  const out = [];
  if (on) barStart.forEach(({ bar, tick }) => { for (const t of beatsOf(score, bar).ticks) if (tick + t < total) out.push(click(tick + t, t === 0)); });
  if (countIn && barStart.length) {
    const { beat, off, cap } = beatsOf(score, barStart[0].bar), n = off || cap;
    for (let t = -n; t < 0; t += beat) out.push(click(t, t === -n));
  }
  return out;
}

// Start playback. `onPos(bar, tick in bar)` is called each frame while a bar plays, and with null
// at the end. `onStatus(text)` reports loading and missing sounds. opts (DESIGN §39): {to: last bar
// to play, loop, click, countIn}.
export async function play(score, from, onPos, onStatus = () => {}, opts = {}) {
  stop();
  const me = { master: null, raf: 0 };
  current = me; // set before awaiting, so Stop while sounds load works
  try { await start(me, score, from, onPos, onStatus, opts); }
  catch (e) { if (current === me) stop(); throw e; }
}

async function start(me, score, from, onPos, onStatus, opts) {
  audio();
  if (ctx.state === "suspended") await ctx.resume();
  if (current !== me) return;
  let { notes, barStart, total, timeOf } = schedule(score, from);
  const k = opts.to == null ? -1 : barStart.findIndex((b) => b.bar === opts.to);
  if (k >= 0) { total = barStart[k + 1]?.tick ?? total; barStart = barStart.slice(0, k + 1); notes = notes.filter((n) => n.start < total); }
  const ticks = clicks(score, barStart, total, opts), pre = ticks.filter((n) => n.start < 0), beats = ticks.filter((n) => n.start >= 0);
  const msgs = await prepare([...notes, ...ticks], 8000, onStatus);
  if (current !== me) return;
  if (msgs) onStatus(msgs);
  const master = output(ctx);
  me.master = master;
  const lead = pre.length ? -timeOf(pre[0].start) : 0, t0 = ctx.currentTime + 0.1 + lead, end = timeOf(total);
  scheduleNotes(ctx, master, pre, t0, timeOf);
  let passes = 0;
  const pass = () => { scheduleNotes(ctx, master, [...notes, ...beats], t0 + passes * end, timeOf, total); passes++; };
  pass();
  const at = barStart.map((b) => timeOf(b.tick));
  const tick = () => {
    if (current !== me) return;
    let now = ctx.currentTime - t0;
    if (opts.loop && now >= passes * end - 0.2) pass(); // the next time round, queued just ahead
    if (!opts.loop && now >= end) { stop(); onPos(null); return; }
    if (now >= 0) {
      now -= Math.floor(now / end) * end;
      let j = 0;
      while (j + 1 < at.length && at[j + 1] <= now) j++;
      let lo = barStart[j].tick, hi = barStart[j + 1]?.tick ?? total; // the tick sounding now
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (timeOf(m) <= now) lo = m; else hi = m; }
      onPos(barStart[j].bar, lo - barStart[j].tick);
    }
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
