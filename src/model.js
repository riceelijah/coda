// Coda score model. PURE: no DOM, no VexFlow. See docs/DESIGN.md §3.
import { drumName, drumNear, drumStep, drumPitch, DRUMS } from "./drums.js";
//
// Edit commands mutate the score they are given and return null on success or a
// reason string on failure. Callers (app.js `edit()`) work on a snapshot and roll back
// on failure, so a failed command may leave the score half-changed.

export const PPQ = 480;
export const DURS = ["w", "h", "q", "8", "16", "32"];
export const BASE = { w: 1920, h: 960, q: 480, 8: 240, 16: 120, 32: 60 };
export const CLEFS = ["treble", "bass", "alto", "tenor"];
// Marks a note or rest can carry, in drawing and file order (DESIGN §16). Only a fermata goes on a rest.
export const MARKS = ["fermata", "staccato", "accent", "tenuto", "marcato", "scoop", "fall", "doit",
  "trill", "mordent", "invMordent", "turn", "tremolo", "arpeggio", "breath", "caesura"]; // DESIGN §34 from trill on
// One ornament per note; mordent is MusicXML's (with the stroke, down to the note below), invMordent the one without.
export const ORNAMENTS = ["trill", "mordent", "invMordent", "turn"];
export const STEP_NAMES = "CDEFGAB";
const STEP_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
// diatonic number (oct*7+step) of each clef's bottom line
export const BOTTOM_LINE = { treble: 30, bass: 18, alto: 24, tenor: 22, percussion: 30 };
// A drum staff (DESIGN §27): unpitched, positions read as treble, each pitch carries its GM drum.
export const isPerc = (st) => st?.clef === "percussion";
// A pitch as staff s takes it: on a drum staff, the nearest entry drum.
export const fitPitch = (st, p) => (isPerc(st) ? drumNear(p) : p);

// ---------- ticks ----------

export function dotFactor(dots) { return dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1; }

export function eventTicks(ev) {
  let t = BASE[ev.dur] * dotFactor(ev.dots || 0);
  if (ev.tup) t = (t * ev.tup[1]) / ev.tup[0];
  return t;
}

export function barTicks(bar) { return bar.reduce((s, e) => s + eventTicks(e), 0); }

export function barCapacity(time) { return time[0] * (1920 / time[1]); }

// True when a tuplet ratio gives whole ticks for this duration (DESIGN §3.1).
export function tupletOk(dur, dots, tup) {
  return Number.isInteger((BASE[dur] * dotFactor(dots) * tup[1]) / tup[0]);
}

// Map a tick count to {dur, dots} exactly, or null.
export function durFromTicks(ticks) {
  for (const dur of DURS) for (const dots of [0, 1, 2])
    if (BASE[dur] * dotFactor(dots) === ticks) return { dur, dots };
  return null;
}

// Nearest {dur, dots} to a tick count (for approximating imports).
export function nearestDur(ticks) {
  let best = { dur: "q", dots: 0 }, bestD = Infinity;
  for (const dur of DURS) for (const dots of [0, 1, 2]) {
    const d = Math.abs(BASE[dur] * dotFactor(dots) - ticks);
    if (d < bestD) { bestD = d; best = { dur, dots }; }
  }
  return best;
}

// Greedy split of a tick span into plain/dotted values (used for padding and MIDI).
const FILL = [1920, 1440, 960, 720, 480, 360, 240, 180, 120, 90, 60];
export function splitTicks(ticks) {
  const out = [];
  for (const v of FILL) while (ticks >= v) { out.push(durFromTicks(v)); ticks -= v; }
  return out;
}

// Group consecutive events with the same tuplet ratio into runs (DESIGN §5.5).
// A run closes when its sounding length is a whole multiple of (first value × normal).
export function tupletRuns(bar) {
  const runs = [];
  let run = null;
  bar.forEach((ev, i) => {
    const same = run && ev.tup && ev.tup[0] === run.tup[0] && ev.tup[1] === run.tup[1];
    if (!same) {
      if (run) runs.push(run);
      run = ev.tup ? { tup: ev.tup, idx: [], ticks: 0, unit: BASE[ev.dur] * ev.tup[1] } : null;
    }
    if (!run) return;
    run.idx.push(i);
    run.ticks += eventTicks(ev);
    if (run.ticks % run.unit === 0) { runs.push(run); run = null; }
  });
  if (run) runs.push(run);
  return runs;
}

// ---------- attributes ----------

export function attrsAt(score, i) {
  let key = 0, time = [4, 4], sym;
  for (let j = 0; j <= i && j < score.measures.length; j++) {
    const m = score.measures[j];
    if (m.key !== undefined) key = m.key;
    if (m.time) { time = m.time; sym = m.sym; }
  }
  return { key, time, sym };
}

// Common and cut time (DESIGN §17): `measures[b].sym`, only beside a `time` it stands for.
export const TIME_SYMS = { common: [4, 4], cut: [2, 2] };
const symOk = (sym, time) => sym === undefined || (TIME_SYMS[sym]?.[0] === time[0] && TIME_SYMS[sym]?.[1] === time[1]);
// Menu value <-> {time, sym}: "C", "C|" (also what VexFlow draws) or "n/d" (any n 1–99 over
// 1–32, so whatever a file can bring can also be typed). null when it isn't one of those.
export function parseTime(v) {
  v = String(v).trim();
  for (const [sym, t] of Object.entries(TIME_SYMS)) if (v === timeLabel({ time: t, sym })) return { time: [...t], sym };
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(v);
  return m && +m[1] >= 1 && [1, 2, 4, 8, 16, 32].includes(+m[2]) ? { time: [+m[1], +m[2]] } : null;
}
// A tuplet typed as "5:3" (or "5,3"): [actual, normal], 1–99 each and not equal, else null.
// Whether it fits a note value is tupletOk's call, as on import.
export function parseTuplet(v) {
  const m = /^\s*(\d{1,2})\s*[:,]\s*(\d{1,2})\s*$/.exec(String(v));
  const t = m && [+m[1], +m[2]];
  return t && t.every((x) => x >= 1) && t[0] !== t[1] ? t : null;
}
// A transposition typed as "-2, -1" (semitones, letter steps, written -> sounding), else null.
export function parseTranspose(v) {
  const m = /^\s*([+-]?\d{1,2})\s*,\s*([+-]?\d{1,2})\s*$/.exec(String(v));
  const t = m && [+m[1], +m[2]];
  return t && okTranspose(t) ? t : null;
}
export const timeLabel = ({ time, sym }) => (sym === "common" ? "C" : sym === "cut" ? "C|" : `${time[0]}/${time[1]}`);
// Importers: per-bar {key, time, sym} -> measures holding only the changes.
export function measuresFrom(attrs) {
  return attrs.map((a, i) => {
    const prev = attrs[i - 1], m = {};
    if (!prev || prev.key !== a.key) m.key = a.key;
    if (!prev || prev.time[0] !== a.time[0] || prev.time[1] !== a.time[1] || prev.sym !== a.sym) {
      m.time = a.time;
      if (a.sym) m.sym = a.sym;
    }
    return m;
  });
}

// ---------- pitch ----------

export function diatonic(p) { return p.oct * 7 + p.step; }
export function fromDiatonic(d) { return { step: ((d % 7) + 7) % 7, oct: Math.floor(d / 7) }; }
export function midi(p) { return 12 * (p.oct + 1) + STEP_SEMIS[p.step] + p.alter; }

export function keyAlter(key, step) {
  if (key > 0 && SHARP_ORDER.slice(0, key).includes(step)) return 1;
  if (key < 0 && FLAT_ORDER.slice(0, -key).includes(step)) return -1;
  return 0;
}

export function pitchName(p) {
  if (p.drum) return drumName(p.drum);
  return STEP_NAMES[p.step] + ({ "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" })[p.alter] + p.oct;
}

// Spell a MIDI number. Black keys are sharps for key >= 0, flats otherwise.
export function spellMidi(m, key = 0) {
  const pc = ((m % 12) + 12) % 12, oct = Math.floor(m / 12) - 1;
  const white = STEP_SEMIS.indexOf(pc);
  if (white >= 0) return { step: white, oct, alter: 0 };
  if (key >= 0) return { step: STEP_SEMIS.indexOf(pc - 1), oct, alter: 1 };
  const up = pc + 1; // e.g. pc 10 (A#) -> B flat
  return { step: STEP_SEMIS.indexOf(up % 12), oct: up === 12 ? oct + 1 : oct, alter: -1 };
}

// Click y -> {step, oct}. Pure so it can be tested (DESIGN §6.2 step 4).
export function yToPitch(yBottom, spacing, clef, y) {
  let pos = Math.round((yBottom - y) / (spacing / 2));
  pos = Math.max(-10, Math.min(18, pos));
  return fromDiatonic(BOTTOM_LINE[clef] + pos);
}

function samePitch(a, b) { return a.step === b.step && a.oct === b.oct && a.drum === b.drum; }
function sortPitches(ps) { ps.sort((a, b) => diatonic(a) - diatonic(b)); return ps; }

// ---------- navigation ----------

// Layers (DESIGN §15): staff.bars is layer 1; staff.layers holds layers 2–4 when used.
export const MAX_LAYERS = 4;
export function layerBars(st, v = 0) { return v === 0 ? st.bars : st.layers?.[v - 1]; }
export function allLayers(st) { return [st.bars, ...(st.layers || [])]; }

// Run fn with layer v in each staff's `bars`, so every edit function works on that layer
// unchanged (DESIGN §15). A missing layer is created for the call and dropped again if it
// is still empty afterwards.
export function withLayer(score, v, fn) {
  if (!v) return fn();
  for (const st of score.staves) {
    st.layers ||= [];
    while (st.layers.length < v) st.layers.push(st.bars.map(() => []));
  }
  // Swap back the same staff objects, so an edit that adds, removes or replaces staves is safe.
  const staves = score.staves.slice();
  const swap = () => { for (const st of staves) [st.bars, st.layers[v - 1]] = [st.layers[v - 1], st.bars]; };
  swap();
  try { return fn(); } finally { swap(); pruneLayers(score); }
}

// Drop trailing layers that are entirely empty, and `layers` itself when none is left.
export function pruneLayers(score) {
  for (const st of score.staves) {
    while (st.layers?.length && st.layers[st.layers.length - 1].every((b) => !b.length)) st.layers.pop();
    if (st.layers && !st.layers.length) delete st.layers;
  }
}

export function nextEventPos(score, s, b, i, v = 0) {
  const bars = layerBars(score.staves[s], v);
  if (!bars) return null;
  if (i + 1 < bars[b].length) return { bar: b, idx: i + 1 };
  for (let nb = b + 1; nb < bars.length; nb++) if (bars[nb].length) return { bar: nb, idx: 0 };
  return null;
}

export function prevEventPos(score, s, b, i, v = 0) {
  const bars = layerBars(score.staves[s], v);
  if (!bars) return null;
  if (i > 0) return { bar: b, idx: i - 1 };
  for (let pb = b - 1; pb >= 0; pb--) if (bars[pb].length) return { bar: pb, idx: bars[pb].length - 1 };
  return null;
}

function fits(score, b, bar) { return barTicks(bar) <= barLen(score, b); }

// Short bars (DESIGN §33): measures[b].len, in ticks, makes bar b shorter than its time signature
// says: a pickup (anacrusis) at the start, or the short bar that completes it at the end.
export function barLen(score, b) { // clamped: a time change elsewhere (a bar deleted) can leave len too long
  const cap = barCapacity(attrsAt(score, b).time);
  return Math.min(score.measures[b]?.len ?? cap, cap);
}
// The number printed on bar b: a pickup is bar 0.
export function barNumber(score, b) { return score.measures[0].len ? b : b + 1; }
export function setBarLen(score, b, len) {
  const m = score.measures[b];
  if (!m) return "No such bar";
  const cap = barCapacity(attrsAt(score, b).time);
  if (!len || len >= cap) { delete m.len; return null; }
  if (!Number.isInteger(len) || len < 0 || len % 60) return "That isn't a length a bar can have";
  for (const st of score.staves) for (const bars of allLayers(st)) if (barTicks(bars[b]) > len) return "The notes in this bar don't fit in that length";
  m.len = len;
  return null;
}

// ---------- edit commands ----------

export function appendEvent(score, s, b, ev) {
  return insertEvent(score, s, b, score.staves[s].bars[b].length, ev);
}

// Insert ev before index idx of a bar (DESIGN §11.5).
export function insertEvent(score, s, b, idx, ev) {
  const bar = score.staves[s].bars[b];
  if (barTicks(bar) + eventTicks(ev) > barLen(score, b)) return "Bar is full";
  if (ev.pitches) sortPitches(ev.pitches);
  bar.splice(Math.max(0, Math.min(idx, bar.length)), 0, ev);
  return null;
}

// Positions from a to z (each {bar, idx}, either order) on staff s, in score order.
export function rangePositions(score, s, a, z, v = 0) {
  const before = (p, q) => p.bar < q.bar || (p.bar === q.bar && p.idx <= q.idx);
  const [lo, hi] = before(a, z) ? [a, z] : [z, a];
  const out = [];
  for (let p = lo; p && before(p, hi); p = nextEventPos(score, s, p.bar, p.idx, v)) out.push(p);
  return out;
}

export function deleteRange(score, s, a, z) {
  for (const p of rangePositions(score, s, a, z).reverse()) deleteEvent(score, s, p.bar, p.idx);
  return null;
}

// Paste copies of events starting at (b, idx), moving on to the next bar when one fills up, as
// long as that bar is empty (added at the end if needed). The last pasted event is not tied.
// `placed` receives the {bar, idx} of each pasted event.
export function pasteEvents(score, s, b, idx, events, placed = []) {
  if (!events.length) return "Nothing to paste";
  for (const src of events) {
    const ev = JSON.parse(JSON.stringify(src));
    if (barTicks(score.staves[s].bars[b]) + eventTicks(ev) > barLen(score, b)) {
      // carry on only into an empty next bar (added at the end of the score if needed)
      b++; idx = 0;
      if (b >= score.measures.length) addMeasure(score, score.measures.length - 1);
      if (score.staves[s].bars[b].length) return "Not enough room to paste here";
      if (eventTicks(ev) > barLen(score, b)) return "A copied note is longer than a bar";
    }
    insertEvent(score, s, b, idx, ev);
    placed.push({ bar: b, idx });
    idx++;
  }
  score.staves[s].bars[b][idx - 1].tie = false;
  return null;
}

export function toggleChordPitch(score, s, b, i, pitch) {
  const ev = score.staves[s].bars[b][i];
  const at = ev.pitches.findIndex((p) => samePitch(p, pitch));
  if (at >= 0) {
    ev.pitches.splice(at, 1);
    if (!ev.pitches.length) { ev.tie = false; delete ev.lyrics; delete ev.grace; }
  } else {
    ev.pitches.push({ ...pitch });
    sortPitches(ev.pitches);
  }
  return null;
}

// The first `step` (0–6) above pitch `top`, as {step, oct} (DESIGN §11.1).
export function chordAbove(top, step) {
  let d = top.oct * 7 + step;
  while (d <= diatonic(top)) d += 7;
  return fromDiatonic(d);
}

export function deleteEvent(score, s, b, i) {
  const prev = prevEventPos(score, s, b, i);
  if (prev) score.staves[s].bars[prev.bar][prev.idx].tie = false;
  score.staves[s].bars[b].splice(i, 1);
  return null;
}

// ---------- transposing parts (DESIGN §21) ----------
// staff.transpose = [chromatic, diatonic]: written -> sounding, MusicXML's signs (B♭ clarinet
// [-2, -1]). Notes are stored as written; measures[b].key is the concert key.

// An interval's size on the line of fifths (M2 = 2, P5 = 1, octave = 0).
export const fifthsOf = (c, d) => 7 * c - 12 * d;
export function wrapKey(k) { while (k > 7) k -= 12; while (k < -7) k += 12; return k; }
// The key staff s shows at bar b.
export function keyAt(score, s, b) {
  const t = score.staves[s]?.transpose, k = attrsAt(score, b).key;
  return t ? wrapKey(k - fifthsOf(t[0], t[1])) : k;
}
export const soundingMidi = (st, p) => p.drum ?? midi(p) + (st.transpose?.[0] || 0);
// p moved by an interval, spelled by its letter; past a double accidental, respelled.
export function shiftPitch(p, c, d) {
  const np = fromDiatonic(diatonic(p) + d), m = midi(p) + c;
  const alter = m - midi({ ...np, alter: 0 });
  const out = Math.abs(alter) <= 2 ? { ...np, alter } : spellMidi(m, 0);
  return p.finger ? { ...out, finger: p.finger } : out; // fingering stays with its note (DESIGN §34)
}
const okTranspose = (t) => Array.isArray(t) && t.length === 2 && t.every(Number.isInteger) && Math.abs(t[0]) <= 36 && Math.abs(t[1]) <= 21;
// Set a part's transposition, keeping its sound: every written note in every layer moves by
// old − new. null or [0, 0] = concert pitch.
export function setStaffTranspose(score, s, t) {
  if (t && !okTranspose(t)) return "Unknown transposition";
  if (isPerc(score.staves[s])) return t && (t[0] || t[1]) ? "Drum parts don't transpose" : null;
  const nt = t && (t[0] || t[1]) ? [...t] : null;
  const group = partGroups(score).find((g) => g.includes(s));
  const dc = (score.staves[s].transpose?.[0] || 0) - (nt?.[0] || 0);
  for (const i of group) for (const bars of allLayers(score.staves[i])) for (const bar of bars) for (const ev of bar)
    if ([...ev.pitches, ...(ev.grace || [])].some((p) => midi(p) + dc < 0 || midi(p) + dc > 127)) return "Some notes would be written too high or too low";
  for (const i of group) {
    const st = score.staves[i], ot = st.transpose || [0, 0], dc = ot[0] - (nt?.[0] || 0), dd = ot[1] - (nt?.[1] || 0);
    if (dc || dd) for (const bars of allLayers(st)) for (const bar of bars) for (const ev of bar) shiftEvent(ev, dc, dd);
    if (nt) st.transpose = nt; else delete st.transpose;
  }
  return null;
}

export function transpose(score, s, b, i, steps) {
  const ev = score.staves[s].bars[b][i];
  if (!ev.pitches.length) return "Rests have no pitch";
  if (isPerc(score.staves[s])) { // ↑/↓ move to the next drum position (DESIGN §27)
    // the whole chord moves, or nothing does: a drum at the end of the kit would swallow its neighbour
    const move = (p) => drumStep(p, Math.sign(steps));
    const np = ev.pitches.map(move), ng = (ev.grace || []).map(move);
    if ([...np, ...ng].some((p) => !p)) return steps > 0 ? "No drum higher up" : "No drum lower down";
    if (np.some((p, k) => np.findIndex((q) => samePitch(p, q)) !== k)) return "Two drums in the chord would become the same drum";
    ev.pitches = sortPitches(np);
    if (ev.grace) ev.grace = ng;
    return null;
  }
  const key = keyAt(score, s, b);
  const move = (p) => { const np = fromDiatonic(diatonic(p) + steps); return { ...np, alter: keyAlter(key, np.step), ...(p.finger ? { finger: p.finger } : {}) }; };
  ev.pitches = ev.pitches.map(move);
  if (ev.grace) ev.grace = ev.grace.map(move); // grace notes move with their note
  sortPitches(ev.pitches);
  // drop duplicates created by collisions
  ev.pitches = ev.pitches.filter((p, k, a) => k === 0 || !samePitch(p, a[k - 1]));
  return null;
}

// Importers (DESIGN §27): make st a drum staff (prev: the staff above it, which loses its brace). Notes with no drum (every note when `all`)
// take the kit drum nearest their position; drums that land twice in one chord are merged. Returns
// counts for the report: {guessed, merged, clefs, transposed}.
export function toDrumStaff(st, prev, all = false) {
  const r = { guessed: 0, merged: 0, clefs: Object.keys(st.clefs || {}).length, transposed: !!st.transpose?.some(Boolean) };
  const snap = (p) => { if (!all && p.drum) return p; r.guessed++; return drumNear(p); };
  for (const e of allLayers(st).flat(2)) {
    const ps = sortPitches(e.pitches.map(snap)), n = ps.length;
    e.pitches = ps.filter((p, i) => ps.findIndex((q) => samePitch(p, q)) === i);
    r.merged += n - e.pitches.length;
    if (e.grace) e.grace = e.grace.map(snap);
  }
  st.clef = "percussion"; st.brace = false;
  delete st.clefs; delete st.program; delete st.transpose;
  if (prev) prev.brace = false;
  return r;
}
// The import report lines for toDrumStaff's counts; `guessed` names why drums came from position.
export function drumReport(report, r, guessed) {
  if (r.guessed) report.count(guessed, r.guessed);
  if (r.merged) report.count("Notes that became the same drum in a chord (merged)", r.merged);
  if (r.clefs) report.count("Clef changes on drum staves (not imported)", r.clefs);
  if (r.transposed) report.count("Transpositions on drum staves (not imported)");
}

// Drum staves (DESIGN §28): move every note of event i a line or space, keeping its drum, as a
// file's own drum map places them. Stays within the ledger range entry allows.
export function moveDrumNote(score, s, b, i, steps) {
  const ev = score.staves[s].bars[b][i];
  if (!isPerc(score.staves[s])) return "Only drum notes move without changing sound";
  if (!ev.pitches.length) return "Rests have no drum";
  const np = ev.pitches.map((p) => ({ ...fromDiatonic(diatonic(p) + steps), alter: 0, drum: p.drum }));
  if (np.some((p) => diatonic(p) < BOTTOM_LINE.percussion - 10 || diatonic(p) > BOTTOM_LINE.percussion + 18)) return "No room further that way";
  ev.pitches = sortPitches(np);
  return null;
}

// Drum staves (DESIGN §27): the top note of event i becomes drum n, at that drum's position.
export function setDrum(score, s, b, i, n) {
  const ev = score.staves[s].bars[b][i];
  if (!isPerc(score.staves[s])) return "Only drum parts have drum sounds";
  if (!ev.pitches.length) return "Rests have no drum";
  ev.pitches[ev.pitches.length - 1] = drumPitch(n);
  ev.pitches = sortPitches(ev.pitches).filter((p, k, a) => k === 0 || !samePitch(p, a[k - 1]));
  return null;
}

export function setAlter(score, s, b, i, alter) {
  const ev = score.staves[s].bars[b][i];
  if (!ev.pitches.length) return "Rests have no pitch";
  if (isPerc(score.staves[s])) return "Drum notes have no sharps or flats";
  ev.pitches.forEach((p) => (p.alter = alter));
  return null;
}

export function setDuration(score, s, b, i, dur, dots) {
  const ev = score.staves[s].bars[b][i];
  const old = { dur: ev.dur, dots: ev.dots };
  ev.dur = dur; ev.dots = dots;
  if (ev.tup && !tupletOk(dur, dots, ev.tup)) delete ev.tup;
  if (!fits(score, b, score.staves[s].bars[b])) { Object.assign(ev, old); return "Bar is full"; }
  return null;
}

// Make an event a tuplet member (tup = [actual, normal]) or plain (tup = null).
// Add `mark` to every event that can take it, or remove it from all if they all have it.
// Returns how many events changed. `ev.marks` is absent when empty, sorted in MARKS order.
export function toggleMark(events, mark) {
  const ok = events.filter((e) => e.pitches.length || mark === "fermata");
  const on = !ok.every((e) => e.marks?.includes(mark));
  for (const e of ok) setMark(e, mark, on);
  return ok.length;
}
export function setMark(ev, mark, on) {
  const m = new Set(ev.marks || []);
  if (on) m.add(mark); else m.delete(mark);
  if (on && mark === "fall") m.delete("doit"); // a note ends one way (DESIGN §31)
  if (on && mark === "doit") m.delete("fall");
  if (on && ORNAMENTS.includes(mark)) for (const o of ORNAMENTS) if (o !== mark) m.delete(o);
  if (on && mark === "breath") m.delete("caesura");
  if (on && mark === "caesura") m.delete("breath");
  if (m.size) ev.marks = MARKS.filter((x) => m.has(x)); else delete ev.marks;
}

// ---------- dynamics (DESIGN §22) ----------
// Levels last until the next one; accents (sf, sfz, fz, fp) are one loud note, fp then soft.
export const DYNS = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "fp", "sf", "sfz", "fz"];
export const DYN_VEL = { ppp: 24, pp: 36, p: 50, mp: 64, mf: 80, f: 96, ff: 110, fff: 124 };
export const ACCENT_VEL = { fp: 100, sf: 112, sfz: 112, fz: 112 };
// Set (or, when it's already that, remove) the dynamic on one event.
export function toggleDyn(ev, dyn) {
  if (ev.dyn === dyn || !dyn) delete ev.dyn; else ev.dyn = dyn;
}

// ---------- text above notes and rehearsal marks (DESIGN §30) ----------
// ev.text: a short line of text above the note or rest (dolce, pizz., a tempo word); measures[b].rehearsal:
// a boxed mark at the bar's start (A, B, 12). Words that mean a jump or sign are kept for Repeats and endings.
export const MAX_TEXT = 60, MAX_REHEARSAL = 8;
export const NAV_WORDS = /^(d\.\s?c\.?|da capo|d\.\s?s\.?|dal segno|to coda|fine)(\s|$)/i;
export const cleanText = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const okText = (t, max) => typeof t === "string" && t.length > 0 && t.length <= max && t === cleanText(t, max) && !NAV_WORDS.test(t);
// Set (or with empty text, remove) one event's text.
// Fingering (DESIGN §34): p.finger on a note of a chord, a finger 0–5 or a change such as 3-1.
export const FINGER = /^[0-5](-[0-5])?$/;
// "1 3 5": fingers for the notes from the lowest up; "-" or nothing leaves one without. Empty clears.
export function setFingers(ev, s) {
  const f = String(s).trim().split(/[\s,]+/).filter(Boolean);
  if (f.some((x) => x !== "-" && !FINGER.test(x))) return "Fingers are 0–5, a change like 3-1, one per note from the lowest";
  if (f.length > ev.pitches.length) return `This chord has ${ev.pitches.length} note${ev.pitches.length > 1 ? "s" : ""}`;
  ev.pitches.forEach((p, k) => { if (f[k] && f[k] !== "-") p.finger = f[k]; else delete p.finger; });
  return null;
}
// ---------- chord symbols (DESIGN §38) ----------
// ev.harm = {root: {step, alter}, kind: "m7", bass?: {step, alter}}, over a note or rest, written
// like the notes (a B♭ trumpet's symbols are a tone above the piano's). kind is the suffix as shown.
export const MAX_KIND = 12;
const ACC = { "": 0, "#": 1, "♯": 1, b: -1, "♭": -1, "##": 2, x: 2, "𝄪": 2, bb: -2, "𝄫": -2 };
// "Bbm7/F" -> {root: {step: 6, alter: -1}, kind: "m7", bass: {step: 3, alter: 0}}, or null
export function parseChord(s) {
  const m = /^([A-Ga-g])(##|bb|#|b|x|♯|♭|𝄪|𝄫)?(.*?)(?:\/([A-Ga-g])(##|bb|#|b|x|♯|♭|𝄪|𝄫)?)?$/u.exec(cleanText(s, 40));
  if (!m || m[3].length > MAX_KIND || /[<>]/.test(m[3])) return null;
  const note = (l, a) => ({ step: STEP_NAMES.indexOf(l.toUpperCase()), alter: ACC[a || ""] });
  return { root: note(m[1], m[2]), kind: m[3].trim(), ...(m[4] ? { bass: note(m[4], m[5]) } : {}) };
}
const ACC_SHOWN = ["𝄫", "♭", "", "♯", "𝄪"];
export const chordText = (h) => {
  const n = (p) => STEP_NAMES[p.step] + ACC_SHOWN[p.alter + 2];
  return n(h.root) + h.kind + (h.bass ? "/" + n(h.bass) : "");
};
const okChordNote = (p) => p && Number.isInteger(p.step) && p.step >= 0 && p.step <= 6 && Number.isInteger(p.alter) && Math.abs(p.alter) <= 2;
export const okChord = (h) => !!h && okChordNote(h.root) && typeof h.kind === "string" && h.kind.length <= MAX_KIND && (h.bass === undefined || okChordNote(h.bass));
// A note's pitches, grace notes and chord symbol moved by c semitones and d steps (a transposition).
export function shiftEvent(ev, c, d) {
  ev.pitches = sortPitches(ev.pitches.map((p) => shiftPitch(p, c, d)));
  if (ev.grace) ev.grace = ev.grace.map((p) => shiftPitch(p, c, d));
  if (ev.harm) {
    const mv = (p) => { const q = shiftPitch({ ...p, oct: 4 }, c, d); return { step: q.step, alter: q.alter }; };
    ev.harm = { ...ev.harm, root: mv(ev.harm.root), ...(ev.harm.bass ? { bass: mv(ev.harm.bass) } : {}) };
  }
}

// Transpose the whole score (DESIGN §38) by c semitones and d steps: every note, grace note and
// chord symbol on staves that aren't drums, and every key signature. When the opening key would
// need more than 7 sharps or flats, the interval is spelled the other way (C♯ major up a fifth
// goes to A♭, not G♯). ponytail: later keys that land past 7 wrap without respelling their notes.
export const INTERVALS = [["Unison", 0, 0], ["Minor second", 1, 1], ["Major second", 2, 1], ["Minor third", 3, 2], ["Major third", 4, 2],
  ["Perfect fourth", 5, 3], ["Augmented fourth", 6, 3], ["Diminished fifth", 6, 4], ["Perfect fifth", 7, 4], ["Minor sixth", 8, 5],
  ["Major sixth", 9, 5], ["Minor seventh", 10, 6], ["Major seventh", 11, 6], ["Octave", 12, 7]];
export function transposeScore(score, c, d) {
  if (!c && !d) return "Pick an interval";
  const k0 = score.measures[0].key || 0;
  if (Math.abs(k0 + fifthsOf(c, d)) > 7) d = [d - 1, d + 1].find((x) => Math.abs(k0 + fifthsOf(c, x)) <= 7) ?? d;
  const staves = score.staves.filter((st) => !isPerc(st)), evs = staves.flatMap((st) => allLayers(st).flatMap((bars) => bars.flat()));
  if (evs.some((ev) => [...ev.pitches, ...(ev.grace || [])].some((p) => midi(p) + c < 0 || midi(p) + c > 127))) return "Some notes would go off the keyboard";
  for (const st of staves) { // a transposing part's own key can pass 7 where the score's doesn't: spell its notes the other way
    const k = k0 + fifthsOf(c, d) - (st.transpose ? fifthsOf(st.transpose[0], st.transpose[1]) : 0);
    const ds = Math.abs(k) <= 7 ? d : [d - 1, d + 1].find((x) => Math.abs(k + fifthsOf(c, x) - fifthsOf(c, d)) <= 7) ?? d;
    for (const ev of allLayers(st).flatMap((bars) => bars.flat())) shiftEvent(ev, c, ds);
  }
  for (const m of score.measures) if (m.key !== undefined) m.key = wrapKey(m.key + fifthsOf(c, d));
  return null;
}

// Respell the selected notes enharmonically (DESIGN §38): C♯ ↔ D♭, E ↔ F♭, the spelling with
// the fewest accidentals that isn't the current one. Notes tied to them follow, so ties hold.
export function respell(score, s, poss) {
  const st = score.staves[s];
  if (isPerc(st)) return "Drum notes have no spelling";
  const flat = st.bars.flat(), done = new Set();
  const alt = (p) => [-1, 1].map((dd) => { const n = fromDiatonic(diatonic(p) + dd); return { ...n, alter: midi(p) - midi({ ...n, alter: 0 }) }; })
    .filter((q) => Math.abs(q.alter) <= 2).sort((x, y) => Math.abs(x.alter) - Math.abs(y.alter))[0];
  let any = false;
  for (const { bar, idx } of poss) {
    const ev = st.bars[bar][idx];
    for (const p of [...ev.pitches]) {
      if (done.has(p)) continue;
      const q = alt(p), same = (e) => e.pitches.find((x) => x.step === p.step && x.oct === p.oct && x.alter === p.alter);
      let a = flat.indexOf(ev), z = a;
      while (a > 0 && flat[a - 1].tie && same(flat[a - 1])) a--;
      while (flat[z].tie && z + 1 < flat.length && same(flat[z + 1])) z++;
      for (let j = a; j <= z; j++) {
        const e = flat[j], x = same(e), np = { ...x, step: q.step, oct: q.oct, alter: q.alter };
        e.pitches = sortPitches(e.pitches.map((y) => (y === x ? np : y)));
        if (e.pitches.some((y, k) => k && samePitch(y, e.pitches[k - 1]))) return "Two notes of the chord would be on the same line";
        done.add(np); any = true;
      }
    }
  }
  return any ? null : "Select notes to respell";
}

// The score as it sounds, for the concert-pitch view (DESIGN §38): a copy with every transposing
// part's notes and chord symbols at concert pitch. Only for drawing; edits go to the score.
export function concertView(score) {
  if (!score.staves.some((st) => st.transpose && !isPerc(st))) return score;
  const c = JSON.parse(JSON.stringify(score)); // ponytail: a copy per redraw; fine at NotePad sizes
  for (const st of c.staves) if (st.transpose && !isPerc(st)) {
    for (const bars of allLayers(st)) for (const bar of bars) for (const ev of bar) shiftEvent(ev, st.transpose[0], st.transpose[1]);
    delete st.transpose;
  }
  return c;
}

export function setText(ev, s) {
  const t = cleanText(s, MAX_TEXT);
  if (NAV_WORDS.test(t)) return `Use Score ▸ Repeats and endings for "${t}"`;
  if (RAMP_WORDS.test(t)) return `Use Score ▸ Tempo for "${t}", so it plays`;
  if (t) ev.text = t; else delete ev.text;
  return null;
}
export function setRehearsal(score, b, s) {
  const m = score.measures[b], t = cleanText(s, MAX_REHEARSAL);
  if (!m) return "No such bar";
  if (NAV_WORDS.test(t)) return `Use Score ▸ Repeats and endings for "${t}"`;
  if (t) m.rehearsal = t; else delete m.rehearsal;
  return null;
}
// The next rehearsal letter after the last one before bar b: A, B, … Z, AA, BB, …
export function nextRehearsal(score, b) {
  let last = null;
  for (let i = b - 1; i >= 0 && !last; i--) last = score.measures[i].rehearsal;
  const m = /^([A-Z])\1*$/.exec(last || "");
  if (!last) return "A";
  if (!m) return /^\d+$/.test(last) ? String(+last + 1) : "";
  return m[1] === "Z" ? "A".repeat(last.length + 1) : String.fromCharCode(m[1].charCodeAt(0) + 1).repeat(last.length);
}

// ---------- slurs and hairpins (DESIGN §23) ----------
// A span is a flag on its first event (slur: true, hp: "<" or ">") and one on its last (slurEnd,
// hpEnd), in the same staff and layer. One of each kind at a time per layer.
// slur2: a slur inside another (a phrase mark over slurs). Octave lines (ott: "8va", "8vb", "15ma",
// "15mb") and pedal marks (ped: true) belong to the whole staff (DESIGN §37).
export const SPAN_KINDS = [["slur", "slurEnd"], ["slur2", "slur2End"], ["hp", "hpEnd"], ["ott", "ottEnd"], ["ped", "pedEnd"]];
// Lines that may cover one note: their start is read before their end on the same event, so they
// can't share a note with the one before (the pedal lifts at the end of its last note).
export const ONE_NOTE = new Set(["ott", "ped"]);
export const OTT_SHIFT = { "8va": 1, "8vb": -1, "15ma": 2, "15mb": -2 }; // octaves the notes sound above what's written
// Octave lines and pedal marks on staff s, from any layer, in ticks from the score's start: a start
// event's onset to the end of its end event. {ott: [{a, z, oct}], ped: [{a, z}]}
export function staffLines(score, s) {
  const out = { ott: [], ped: [] };
  allLayers(score.staves[s]).forEach((bars) => {
    const open = {};
    let t = 0;
    bars.forEach((bar, b) => {
      let at = t;
      for (const ev of bar) {
        const end = at + eventTicks(ev);
        if (ev.ott) open.ott = { a: at, oct: OTT_SHIFT[ev.ott] || 0 };
        if (ev.ped) open.ped = { a: at };
        if (ev.ottEnd && open.ott) { out.ott.push({ ...open.ott, z: end }); open.ott = null; }
        if (ev.pedEnd && open.ped) { out.ped.push({ ...open.ped, z: end }); open.ped = null; }
        at = end;
      }
      t += barLen(score, b);
    });
  });
  return out;
}
// Octaves a note at tick t on staff s sounds above its written pitch.
export const ottAt = (lines, t) => lines.ott.find((r) => t >= r.a && t < r.z)?.oct || 0;
// Every note (and grace note) under an octave line, in any layer, moved by sign × the line's
// octaves: -1 turns a file's sounding notes into written ones.
export function shiftUnderLines(score, sign) {
  score.staves.forEach((st, s) => {
    const lines = staffLines(score, s);
    if (!lines.ott.length || isPerc(st)) return;
    const move = (o) => (p) => ({ ...p, oct: p.oct + sign * o });
    allLayers(st).forEach((bars) => {
      let t = 0;
      bars.forEach((bar, b) => {
        let at = t;
        for (const ev of bar) {
          const o = ottAt(lines, at);
          if (o) { ev.pitches = ev.pitches.map(move(o)); if (ev.grace) ev.grace = ev.grace.map(move(o)); }
          at += eventTicks(ev);
        }
        t += barLen(score, b);
      });
    });
  });
}
// A slur over the events (in layer order, `layer` all of the layer's events). One that overlaps a
// slur already there, inside it or around it, goes on the second level (slur2); a third is refused.
export function toggleSlur(layer, events) {
  const a = events[0], z = events[events.length - 1];
  if (a.slur2 && z.slur2End) return toggleSpan(events, "slur2");
  if (a.slur && z.slurEnd) return toggleSpan(events, "slur");
  let open = false, over = false, inside = false;
  for (const ev of layer) {
    if (ev.slurEnd && ev !== z) { if (inside && ev !== a) over = true; open = false; } // one ending on the first note is a neighbour
    if (ev === a) { inside = true; over ||= open; }
    if (inside && ev.slur && ev !== z) over = true; // one starting on the last note is a neighbour
    if (ev.slur) open = true;
    if (ev === z) break;
  }
  if (!over) return toggleSpan(events, "slur");
  // a second-level slur already over these notes (inside, around or crossing): no room for a third
  let open2 = false, busy = false;
  for (const ev of layer) {
    if (ev.slur2End && ev !== z) { if (events.includes(ev) && ev !== a) busy = true; open2 = false; }
    if (ev === a && open2) busy = true;
    if (ev.slur2 && events.includes(ev) && ev !== z) busy = true;
    if (ev.slur2) open2 = true;
    if (ev === z) { if (open2 && !ev.slur2) busy = true; break; }
  }
  if (busy) return "Two slurs at most over a note";
  return toggleSpan(events, "slur2");
}
// Over events in order (2 or more): set the span, or remove it when exactly that one is there.
export function toggleSpan(events, kind, type = true) {
  if (events.length < 2 && !ONE_NOTE.has(kind)) return "Select two or more notes";
  const end = kind + "End", a = events[0], z = events[events.length - 1];
  if (a[kind] === type && z[end]) { delete a[kind]; delete z[end]; return null; }
  if (ONE_NOTE.has(kind) && ((a[end] && !a[kind]) || (z[kind] && !z[end]))) return kind === "ped" ? "That would overlap another pedal mark" : "That would overlap another octave line";
  if (ONE_NOTE.has(kind)) { delete a[end]; delete z[kind]; } // the same line, made longer or shorter
  // spans inside are replaced; a span ending on the first note or starting on the last is a neighbour, kept
  for (const e of events.slice(1, -1)) { delete e[kind]; delete e[end]; }
  a[kind] = type; z[end] = true;
  return null;
}
// Drop ends with no start, starts with no end, and a start before the last one closed.
// Returns how many flags went.
export function clearBrokenSpans(score) {
  let n = 0;
  for (const st of score.staves) for (const bars of allLayers(st)) for (const [k, ke] of SPAN_KINDS) {
    let open = null;
    const first = ONE_NOTE.has(k);
    for (const bar of bars) for (const ev of bar) {
      if (ev[k] && first) { if (open) { delete open[k]; n++; } open = ev; }
      if (ev[ke]) { if (open) open = null; else { delete ev[ke]; n++; } }
      if (ev[k] && !first) { if (open) { delete open[k]; n++; } open = ev; }
    }
    if (open) { delete open[k]; n++; }
  }
  return n;
}

// ---------- lyrics (DESIGN §24) ----------
// ev.lyrics = [{text, hyph?, ext?} | null, …]: verse v's syllable at index v (null: none in that verse),
// hyph a hyphen to the next one, ext an extender line (DESIGN §37). No trailing nulls; absent when empty. Notes only.
export const MAX_LYRIC = 40, MAX_VERSES = 5;
// ---------- grace notes (DESIGN §26) ----------
// ev.grace = [pitch, …]: single grace notes before a note, played on the beat. One draws as a
// slashed eighth, more as beamed sixteenths.
export const MAX_GRACE = 8;
export function addGrace(ev, pitch) {
  if (!ev.pitches.length) return "Grace notes go before a note, not a rest";
  if ((ev.grace || []).length >= MAX_GRACE) return `At most ${MAX_GRACE} grace notes before a note`;
  ev.grace = [...(ev.grace || []), { step: pitch.step, oct: pitch.oct, alter: pitch.alter || 0, ...(pitch.drum ? { drum: pitch.drum } : {}) }]; // a new array: pasted copies share none
  return null;
}

// MusicXML/MuseScore <syllabic> for every lyric in the score, keyed by event: a hyphen after a
// syllable makes it begin/middle, one before it makes it middle/end.
// Values are arrays by verse (null where the event has none in that verse).
export function syllabics(score) {
  const m = new Map();
  for (const st of score.staves) for (const bars of allLayers(st)) {
    const prev = []; // per verse: did the last syllable end with a hyphen
    for (const bar of bars) for (const ev of bar) if (ev.lyrics) {
      m.set(ev, ev.lyrics.map((l, v) => {
        if (!l) return null;
        const s = l.hyph ? (prev[v] ? "middle" : "begin") : (prev[v] ? "end" : "single");
        prev[v] = !!l.hyph;
        return s;
      }));
    }
  }
  return m;
}

// Extender lines (DESIGN §37): event -> by verse {last: the last note it's held over, ticks from the
// syllable's onset to that note's}. It runs to the note before the verse's next syllable.
export function melismas(score) {
  const m = new Map();
  for (const st of score.staves) for (const bars of allLayers(st)) {
    const open = [];
    let t = 0;
    bars.forEach((bar, b) => {
      let at = t;
      for (const ev of bar) {
        if (!ev.pitches.length) open.length = 0; // a rest ends every extender
        else for (let v = 0; v < MAX_VERSES; v++) {
          if (ev.lyrics?.[v]) {
            open[v] = ev.lyrics[v].ext ? { at, ev } : null;
            if (open[v]) (m.get(ev) || m.set(ev, []).get(ev))[v] = { last: ev, ticks: 0 };
          } else if (open[v]) m.get(open[v].ev)[v] = { last: ev, ticks: at - open[v].at };
        }
        at += eventTicks(ev);
      }
      t += barLen(score, b);
    });
  }
  return m;
}
// ext: an extender line after the syllable, under the notes it's held over (DESIGN §37)
export function setLyric(ev, text, hyph = false, verse = 0, ext = false) {
  if (!Number.isInteger(verse) || verse < 0 || verse >= MAX_VERSES) return;
  if (!ev.pitches.length) { delete ev.lyrics; return; }
  const t = String(text || "").trim().slice(0, MAX_LYRIC);
  const ls = Array.from({ length: Math.max(ev.lyrics?.length || 0, verse + 1) }, (_, i) => ev.lyrics?.[i] ?? null); // no holes
  ls[verse] = t ? { text: t, ...(hyph ? { hyph: true } : {}), ...(ext ? { ext: true } : {}) } : null;
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  if (ls.length) ev.lyrics = ls; else delete ev.lyrics;
}

// Scores saved before verses (one lyric as ev.lyric/lyricHyph) are moved to ev.lyrics on load.
// Never makes a score invalid: anything odd is dropped.
export function upgradeScore(score) {
  try {
    for (const st of score.staves) for (const bars of allLayers(st)) for (const bar of bars) for (const ev of bar) {
      if (!("lyric" in ev || "lyricHyph" in ev)) continue;
      const t = ev.lyric, h = ev.lyricHyph;
      delete ev.lyric; delete ev.lyricHyph;
      if (typeof t === "string" && Array.isArray(ev.pitches)) setLyric(ev, t, h === true);
    }
  } catch { /* not a score: isValidScore says so */ }
  return score;
}

export function setTuplet(score, s, b, i, tup) {
  const ev = score.staves[s].bars[b][i];
  if (tup && !tupletOk(ev.dur, ev.dots, tup)) return `A ${tup[0]}:${tup[1]} tuplet doesn't fit that note value`;
  const old = ev.tup;
  if (tup) ev.tup = [...tup]; else delete ev.tup;
  if (!fits(score, b, score.staves[s].bars[b])) { if (old) ev.tup = old; else delete ev.tup; return "Bar is full"; }
  return null;
}

export function toggleTie(score, s, b, i) {
  const ev = score.staves[s].bars[b][i];
  if (ev.tie) { ev.tie = false; return null; }
  const n = nextEventPos(score, s, b, i);
  // tie target must be the immediately following event (same bar, or first of next non-empty bar)
  if (!n || (n.bar !== b && b + 1 !== n.bar)) return "Nothing to tie to";
  const ne = score.staves[s].bars[n.bar][n.idx];
  if (!ev.pitches.some((p) => ne.pitches.some((q) => samePitch(p, q) && p.alter === q.alter)))
    return "Nothing to tie to";
  ev.tie = true;
  return null;
}

// Slides (DESIGN §31): ev.gliss = true, a straight line to the next note in the layer that plays
// as one smooth glide. The next note must follow at once and differ; not on tied notes or drums.
const slideTarget = (ev, ne) => ne && ne.pitches.length && !ev.tie && !ne.pitches.every((q, k) => ev.pitches[k] && midi(q) === midi(ev.pitches[k])) && ne.pitches.length === ev.pitches.length;
export function toggleGliss(score, s, b, i) {
  const ev = score.staves[s].bars[b][i];
  if (ev.gliss) { delete ev.gliss; return null; }
  if (!ev.pitches.length) return "Rests can't slide";
  if (isPerc(score.staves[s])) return "Drums don't slide";
  if (ev.tie) return "Untie the note first";
  const ne = nextAfter(score, s, b, i, 0, score.staves[s].bars);
  if (!ne?.pitches.length) return "A slide needs a note right after it";
  if (!slideTarget(ev, ne)) return ne.pitches.length !== ev.pitches.length ? "A slide needs the same number of notes at each end" : "A slide needs a different note to go to";
  ev.gliss = true;
  return null;
}

// Drop ties whose next note no longer shares a pitch, and slides with nowhere to go (after inserts, pastes, edits).
export function clearBrokenTies(score) {
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    if (!ev.tie) return;
    const ne = nextAfter(score, s, b, i, v, bars);
    if (!ne || !ev.pitches.some((p) => ne.pitches.some((q) => samePitch(p, q) && p.alter === q.alter))) ev.tie = false;
  }))));
  clearBrokenSlides(score);
}
// The event right after event i (same bar or the next one), or null.
function nextAfter(score, s, b, i, v, bars) {
  const n = nextEventPos(score, s, b, i, v);
  return n && (n.bar === b || n.bar === b + 1) ? bars[n.bar][n.idx] : null;
}
// Drop slides with nowhere to go. Returns how many went (importers count them).
export function clearBrokenSlides(score) {
  let n = 0;
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    if (ev.gliss && (isPerc(st) || !slideTarget(ev, nextAfter(score, s, b, i, v, bars)))) { delete ev.gliss; n++; }
  }))));
  return n;
}

// ---------- clef changes (DESIGN §25) ----------
// st.clefs = {bar: clef}: changes at barlines, bar ≥ 1; st.clef is the clef at bar 0.
export function clefAt(st, b) {
  let c = st.clef, at = 0;
  for (const k in st.clefs) if (+k <= b && +k >= at) { at = +k; c = st.clefs[k]; }
  return c;
}

// Drop changes past the last bar or to the clef already in effect; no empty object.
export function tidyClefs(st, n) {
  if (!st.clefs) return;
  const out = {};
  let cur = st.clef;
  for (const k of Object.keys(st.clefs).map(Number).sort((a, b) => a - b)) {
    if (Number.isInteger(k) && k >= 1 && k < n && st.clefs[k] !== cur) cur = out[k] = st.clefs[k];
  }
  delete st.clefs; // re-added last, so saved files list it in one place
  if (Object.keys(out).length) st.clefs = out;
}

// Importers: tidy every staff's clef changes once the bar count is known; returns how many fell
// after the last bar (a clef written at the very end of a piece).
export function finishClefs(score) {
  let lost = 0;
  for (const st of score.staves) {
    lost += Object.keys(st.clefs || {}).filter((k) => +k >= score.measures.length).length;
    tidyClefs(st, score.measures.length);
  }
  return lost;
}

// The clef from bar b on (bar 0 is the staff's own clef).
export function setClef(score, s, b, clef) {
  const st = score.staves[s];
  if (!st || !CLEFS.includes(clef) || !(b >= 0 && b < score.measures.length)) return "Can't change the clef there";
  if (isPerc(st)) return "Drum parts keep the percussion clef";
  if (b === 0) st.clef = clef; else (st.clefs ||= {})[b] = clef;
  tidyClefs(st, score.measures.length);
  return null;
}

export function addMeasure(score, after) {
  score.measures.splice(after + 1, 0, {});
  for (const st of score.staves) for (const bars of allLayers(st)) bars.splice(after + 1, 0, []);
  for (const st of score.staves) if (st.clefs) st.clefs = Object.fromEntries(Object.entries(st.clefs).map(([k, c]) => [+k > after ? +k + 1 : +k, c]));
  return null;
}

export function deleteMeasure(score, idx) {
  if (score.measures.length <= 1) return "A score needs at least one bar";
  const a0 = attrsAt(score, 0), tm = score.measures[idx].tempo;
  score.measures.splice(idx, 1);
  // a tempo change on the deleted bar moves to the bar after it, like a clef change
  const nx = score.measures[idx];
  if (tm && nx && !nx.tempo) nx.tempo = tm;
  if (nx?.tempo && idx && nx.tempo === tempoAt(score, idx - 1)) delete nx.tempo; // no longer a change
  for (const st of score.staves) for (const bars of allLayers(st)) bars.splice(idx, 1);
  // a clef change on the deleted bar moves to the bar after it, so that bar keeps its clef
  for (const st of score.staves) if (st.clefs) {
    const m = {};
    for (const [k, c] of Object.entries(st.clefs)) {
      if (+k < idx) m[k] = c; else if (+k > idx) m[+k - 1] = c; else if (!(idx + 1 in st.clefs)) m[idx] = c;
    }
    if (0 in m) { st.clef = m[0]; delete m[0]; }
    st.clefs = m;
    tidyClefs(st, score.measures.length);
  }
  if (idx === 0) {
    const m = score.measures[0];
    if (m.tempo) { score.tempo = m.tempo; delete m.tempo; }
    if (m.key === undefined) m.key = a0.key;
    if (!m.time) { m.time = a0.time; if (a0.sym) m.sym = a0.sym; }
  }
  return null;
}

// Set key and/or time from bar b on. A value equal to the previous bar's is stored as "no change".
export function setAttrs(score, b, { key, time, sym }) {
  const m = score.measures[b], prev = b > 0 ? attrsAt(score, b - 1) : null;
  if (key !== undefined) { if (prev && prev.key === key) delete m.key; else m.key = key; }
  if (time) {
    if (!symOk(sym, time)) sym = undefined;
    delete m.sym;
    if (prev && prev.time[0] === time[0] && prev.time[1] === time[1] && prev.sym === sym) delete m.time;
    else { m.time = time; if (sym) m.sym = sym; }
    for (let j = b; j < score.measures.length; j++) {
      if (j > b && score.measures[j].time) break;
      if (score.measures[j].len >= barCapacity(time)) delete score.measures[j].len;
      for (const st of score.staves) for (const bars of allLayers(st)) if (!fits(score, j, bars[j])) return `Bar ${barNumber(score, j)} would overflow`;
    }
  }
  return null;
}

// Remove a mid-score key/time change at bar b (b > 0).
export function clearAttrs(score, b) {
  if (b === 0) return "Bar 1 always has a key and time";
  const m = score.measures[b];
  if (m.key === undefined && !m.time) return "This bar has no key or time change";
  const hadTime = !!m.time;
  delete m.key; delete m.time; delete m.sym;
  if (hadTime) for (let j = b; j < score.measures.length; j++) {
    if (j > b && score.measures[j].time) break;
    if (score.measures[j].len >= barCapacity(attrsAt(score, j).time)) delete score.measures[j].len;
    for (const st of score.staves) for (const bars of allLayers(st)) if (!fits(score, j, bars[j])) return `Bar ${barNumber(score, j)} would overflow`;
  }
  return null;
}

// ---------- repeats and navigation (DESIGN §28) ----------
// On measures[b], beside key and time: repStart (|: at the bar's start), repEnd (:| at its end,
// the number of times the section plays, 2–10), volta (the ending numbers this bar belongs to;
// a run of bars with the same numbers is one bracket), segno and coda (signs at the bar's start:
// D.S. and To Coda targets), toCoda, fine and jump (at the bar's end).
export const JUMPS = { dc: "D.C.", dcFine: "D.C. al Fine", dcCoda: "D.C. al Coda", ds: "D.S.", dsFine: "D.S. al Fine", dsCoda: "D.S. al Coda" };
export const BAR_FLAGS = ["repStart", "segno", "coda", "toCoda", "fine"];
export const MAX_REPEAT = 10;
const okVolta = (v) => Array.isArray(v) && v.length > 0 && v.every((n, i) => Number.isInteger(n) && n >= 1 && n <= MAX_REPEAT && (i === 0 || n > v[i - 1]));
export const sameVolta = (a, b) => !!a && !!b && a.join() === b.join();
function okRepeats(m) {
  return BAR_FLAGS.every((k) => m[k] === undefined || m[k] === true) &&
    (m.repEnd === undefined || (Number.isInteger(m.repEnd) && m.repEnd >= 2 && m.repEnd <= MAX_REPEAT)) &&
    (m.volta === undefined || okVolta(m.volta)) && (m.jump === undefined || m.jump in JUMPS);
}
// Set (or with a falsy value, clear) one mark on bar b: a BAR_FLAGS name with true, repEnd with a
// count, jump with a JUMPS key.
export function setBarMark(score, b, k, val) {
  const m = score.measures[b];
  if (!m) return "No such bar";
  if (!val) { delete m[k]; return null; }
  if (BAR_FLAGS.includes(k)) m[k] = true;
  else if (k === "repEnd" && Number.isInteger(val) && val >= 2 && val <= MAX_REPEAT) m.repEnd = val;
  else if (k === "jump" && val in JUMPS) m.jump = val;
  else return "Unknown repeat mark";
  return null;
}
// Bars a..z become one ending with these numbers (sorted, deduplicated); null or [] clears them.
export function setVolta(score, a, z, nums) {
  const v = [...new Set(nums || [])].sort((x, y) => x - y);
  if (v.length && !okVolta(v)) return `Endings are numbered 1 to ${MAX_REPEAT}`;
  for (let b = Math.min(a, z); b <= Math.max(a, z); b++) { if (v.length) score.measures[b].volta = v; else delete score.measures[b].volta; }
  return null;
}
// "1, 2" or "1-3" -> [1, 2] / [1, 2, 3]; null when it isn't a list of ending numbers.
export function parseVolta(s) {
  const out = [];
  for (const part of String(s).split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2})\.?(?:[-–](\d{1,2})\.?)?$/.exec(part);
    if (!m) return null;
    for (let n = +m[1]; n <= +(m[2] || m[1]); n++) out.push(n);
  }
  const v = [...new Set(out)].sort((x, y) => x - y);
  return v.length && okVolta(v) ? v : null;
}
export const voltaLabel = (v) => v.join(", ") + ".";

// The bars in the order they play (DESIGN §28). A section runs from the last |: (or the bar
// after the last :| or ending, or bar 1) to :|, and plays repEnd times, or, at a :| inside an
// ending, until the highest ending number has come; on pass n only the endings holding n play. D.C./D.S. are taken once, go to bar 1 / the first segno (bar 1 if
// there is none), and repeats are not taken again after them: each run of endings plays only its
// last one. "al Fine" then stops at the end of a Fine bar; "al Coda" goes from a To Coda bar to
// the next coda sign (ignored when there is none). Capped, so a broken file can't loop forever.
export function playOrder(score) {
  const ms = score.measures, n = ms.length, out = [], cap = n * (MAX_REPEAT + 2) + 100;
  const maxV = (m) => m.volta[m.volta.length - 1];
  // after a jump: is bar i in the last ending of its run of endings?
  const lastEnding = (i) => { let j = i; while (j + 1 < n && ms[j + 1].volta) j++; return ms.slice(i, j + 1).every((m) => maxV(m) <= maxV(ms[i])); };
  // the highest ending number in the run of endings around bar i
  const runMax = (i) => { let a = i, z = i; while (a > 0 && ms[a - 1].volta) a--; while (z + 1 < n && ms[z + 1].volta) z++; return Math.max(...ms.slice(a, z + 1).map(maxV)); };
  let b = 0, start = 0, pass = 1, back = false, jumped = null;
  while (b < n && out.length < cap) {
    const m = ms[b];
    if (m.repStart && !back) { start = b; pass = 1; }
    back = false;
    const leaving = m.volta && !ms[b + 1]?.volta; // the end of a run of endings closes the section
    if (m.volta && (jumped ? !lastEnding(b) : !m.volta.includes(pass))) {
      if (leaving) { start = b + 1; pass = 1; }
      b++; continue;
    }
    out.push(b);
    if (jumped && m.fine && /Fine/.test(jumped)) break;
    if (jumped && m.toCoda && /Coda/.test(jumped)) {
      const c = ms.findIndex((x, i) => i > b && x.coda);
      if (c >= 0) { b = c; continue; }
    }
    if (m.repEnd && !jumped) {
      // an ending's :| goes back while a later ending is still to come ([1. :|] [2. :|] [3.])
      if (pass < m.repEnd || (m.volta && pass < runMax(b))) { pass++; b = start; back = true; continue; }
      start = b + 1; pass = 1;
    }
    if (m.jump && !jumped) {
      jumped = m.jump;
      b = jumped.startsWith("ds") ? Math.max(0, ms.findIndex((x) => x.segno)) : 0;
      continue;
    }
    if (leaving) { start = b + 1; pass = 1; }
    b++;
  }
  return out;
}

// Staves grouped into parts: a braced staff and the one after it share a part.
export function partGroups(score) {
  const groups = [];
  for (let s = 0; s < score.staves.length; s++) {
    if (score.staves[s].brace && s + 1 < score.staves.length) { groups.push([s, s + 1]); s++; }
    else groups.push([s]);
  }
  return groups;
}

// Set the General MIDI program (0–127) of a staff's whole part (DESIGN §13.2).
export function setStaffProgram(score, s, program) {
  if (!Number.isInteger(program) || program < 0 || program > 127) return "Unknown instrument";
  if (isPerc(score.staves[s])) return "Drum parts play the drum kit";
  const g = partGroups(score).find((grp) => grp.includes(s));
  for (const i of g) score.staves[i].program = program;
  return null;
}

// Your own sound for a part (DESIGN §18), by id; null goes back to the part's instrument.
export function setStaffSound(score, s, id) {
  if (id !== null && (typeof id !== "string" || !id || id.length > 64)) return "Unknown sound";
  for (const i of partGroups(score).find((grp) => grp.includes(s))) {
    if (id) score.staves[i].sound = id; else delete score.staves[i].sound;
  }
  return null;
}

// Kinds of part the Instruments dialog can add (DESIGN §20).
export const PART_KINDS = {
  treble: [{ clef: "treble" }], bass: [{ clef: "bass" }], alto: [{ clef: "alto" }], tenor: [{ clef: "tenor" }],
  grand: [{ clef: "treble", brace: true }, { clef: "bass" }], percussion: [{ clef: "percussion" }],
};

// Rebuild the part list (DESIGN §20). rows, in the new order: {from, name, kind?, program?}, where
// `from` is the first staff index of an existing part (its staves, layers and sounds are kept, as
// the same objects) or null for a new part of `kind`. Parts left out are removed.
export function arrangeParts(score, rows) {
  if (!rows.length) return "A score needs at least one part";
  const groups = partGroups(score), seen = new Set();
  for (const r of rows) { // check everything before changing anything
    if (r.from === null || r.from === undefined) { if (!PART_KINDS[r.kind]) return "Unknown kind of part"; continue; }
    if (!groups.some((x) => x[0] === r.from) || seen.has(r.from)) return "Unknown part";
    seen.add(r.from);
  }
  const staves = [];
  for (const r of rows) {
    const name = String(r.name ?? "").trim().slice(0, 60);
    let part;
    if (r.from === null || r.from === undefined) {
      const program = Number.isInteger(r.program) && r.program > 0 && r.program <= 127 ? r.program : 0;
      part = PART_KINDS[r.kind].map((k) => ({ name, clef: k.clef, brace: !!k.brace, ...(program && k.clef !== "percussion" ? { program } : {}),
        bars: score.measures.map(() => []) }));
    } else part = groups.find((x) => x[0] === r.from).map((i) => score.staves[i]);
    for (const st of part) st.name = name;
    if (part.length === 1) part[0].brace = false; // a lone staff never pairs with whatever follows
    staves.push(...part);
  }
  score.staves = staves;
  return null;
}

export const PRESETS = {
  treble: [{ name: "Staff", clef: "treble" }],
  bass: [{ name: "Staff", clef: "bass" }],
  piano: [{ name: "Piano", clef: "treble", brace: true }, { name: "Piano", clef: "bass" }],
  trebleBass: [{ name: "Upper", clef: "treble" }, { name: "Lower", clef: "bass" }],
  satb: [
    { name: "Soprano", clef: "treble" }, { name: "Alto", clef: "treble" },
    { name: "Tenor", clef: "treble" }, { name: "Bass", clef: "bass" },
  ],
  drums: [{ name: "Drums", clef: "percussion" }],
};

export function newScore({ title = "Untitled", composer = "", tempo = 100, preset = "treble",
  key = 0, time = [4, 4], sym, bars = 16, program = 0 } = {}) {
  const n = Math.max(1, Math.min(999, bars | 0));
  return {
    title, composer, tempo,
    measures: Array.from({ length: n }, (_, i) => (i === 0 ? { key, time, ...(symOk(sym, time) && sym ? { sym } : {}) } : {})),
    staves: PRESETS[preset].map((st) => ({
      name: st.name, clef: st.clef, brace: !!st.brace, ...(program && st.clef !== "percussion" ? { program } : {}),
      bars: Array.from({ length: n }, () => []),
    })),
  };
}

export function noteCount(score) {
  let n = 0;
  for (const st of score.staves) for (const bars of allLayers(st)) for (const bar of bars) for (const e of bar) n += e.pitches.length ? 1 : 0;
  return n;
}

// ---------- tracks (DESIGN §32) ----------
// A track is a part (partGroups): one staff, or a braced pair. `st.off = true` on each of its
// staves leaves it out of playback and exports (never out of Save). A DAW-style view would list
// the same rows.
export function tracks(score) {
  return partGroups(score).map((g, k) => {
    const st = score.staves[g[0]];
    return { staves: g, name: st.name || `Part ${k + 1}`, on: !st.off, perc: isPerc(st) };
  });
}
// Turn the track holding staff s on or off.
export function setTrackOn(score, s, on) {
  for (const i of partGroups(score).find((g) => g.includes(s))) { if (on) delete score.staves[i].off; else score.staves[i].off = true; }
  return null;
}
// The score with only the tracks that are on, every bar kept (so timing, repeats and bar numbers
// match), or null when they are all off. A copy: the score itself is untouched.
export function tracksOn(score) {
  const keep = tracks(score).filter((t) => t.on).flatMap((t) => t.staves);
  if (!keep.length) return null;
  const sub = JSON.parse(JSON.stringify({ ...score, staves: keep.map((i) => score.staves[i]) }));
  for (const st of sub.staves) delete st.off;
  return sub;
}

// ---------- tempo changes (DESIGN §29) ----------
// score.tempo is bar 1's (quarter notes per minute); measures[b].tempo (b ≥ 1) changes it from bar b on.
export const okBpm = (v) => Number.isInteger(v) && v >= 20 && v <= 400;
export const clampBpm = (v) => Math.max(20, Math.min(400, Math.round(v) || 100));
export function tempoAt(score, b) {
  for (let i = b; i > 0; i--) if (score.measures[i]?.tempo) return score.measures[i].tempo;
  return score.tempo || 100;
}
// Set the tempo from bar b on. At bar 1 this is the score's tempo; a change equal to the tempo
// already in effect is stored as "no change", and a later bar left equal to it loses its change.
export function setTempo(score, b, bpm) {
  if (!okBpm(bpm)) return "Tempo must be 20–400";
  if (!score.measures[b]) return "No such bar";
  if (b === 0) score.tempo = bpm;
  else if (tempoAt(score, b - 1) === bpm) delete score.measures[b].tempo;
  else score.measures[b].tempo = bpm;
  const n = score.measures.findIndex((m, i) => i > b && m.tempo);
  if (n > 0 && score.measures[n].tempo === tempoAt(score, n - 1)) delete score.measures[n].tempo;
  return null;
}

// Make every staff have the same bar count as score.measures (importers call this).
export function padBars(score) {
  const n = Math.max(1, score.measures.length, ...score.staves.map((s) => s.bars.length));
  while (score.measures.length < n) score.measures.push({});
  for (const st of score.staves) for (const bars of allLayers(st)) while (bars.length < n) bars.push([]);
  if (score.measures[0].key === undefined) score.measures[0].key = 0;
  if (!score.measures[0].time) score.measures[0].time = [4, 4];
  return score;
}

// Basic shape check for restored/imported data (untrusted input).
// ---------- swing and rit./accel. (DESIGN §39) ----------
// score.swing = [first, second]: each beat's two eighths play in that ratio ([2, 1] is a triplet
// feel), in x/4 and x/2 time. Off when absent.
export const SWINGS = [["Off", null], ["Light (3:2)", [3, 2]], ["Medium (2:1)", [2, 1]], ["Heavy (3:1)", [3, 1]]];
export const okSwing = (w) => Array.isArray(w) && w.length === 2 && w.every((n) => Number.isInteger(n) && n >= 1 && n <= 16) && w[0] > w[1];
// The simplest ratio for a percentage (MuseScore stores 67 for 2:1).
export function swingOf(pct) {
  for (let q = 1; q <= 16; q++) for (let f = q + 1; f <= 16; f++) if (Math.round((100 * f) / (f + q)) === Math.round(pct)) return [f, q];
  return null;
}
// measures[b].ramp: "rit" or "accel" from bar b's start, or "atempo" (back to the marked tempo).
export const RAMPS = { rit: "rit.", accel: "accel.", atempo: "a tempo" };
export const RAMP_WORDS = /^(rit\.?|ritard\.?|ritardando|rall\.?|rallentando|accel\.?|accelerando|a tempo)$/i;
export const rampOf = (t) => !RAMP_WORDS.test(t) ? null : /^a/i.test(t) ? (/^accel/i.test(t) ? "accel" : "atempo") : "rit";
export function setRamp(score, b, kind) {
  const m = score.measures[b];
  if (!m) return "No such bar";
  if (!kind) delete m.ramp; else if (kind in RAMPS) m.ramp = kind; else return "Unknown tempo change";
  return null;
}
const RAMP_STEP = 240; // the tempo moves every eighth note
// Tempo through each bar: per bar, [[ticks from its start, quarters per minute]...], the first at 0.
// A rit. or accel. runs to the next bar with a tempo, rit., accel. or a tempo (or the end): towards
// that bar's tempo when it goes the same way, else by a quarter. One ramp straight after another
// starts where it ended.
export function tempoSteps(score) {
  const ms = score.measures, lin = [];
  let t = 0;
  ms.forEach((_, b) => { lin.push(t); t += barLen(score, b); });
  const out = ms.map((_, b) => [[0, tempoAt(score, b)]]);
  let carry = null; // {bar, bpm}: where the last ramp ended
  ms.forEach((m, b) => {
    if (m.ramp !== "rit" && m.ramp !== "accel") return;
    let n = b + 1;
    while (n < ms.length && !ms[n].tempo && !ms[n].ramp) n++;
    const dir = m.ramp === "rit" ? -1 : 1, nx = ms[n]?.tempo;
    const b0 = carry?.bar === b && !m.tempo ? carry.bpm : tempoAt(score, b);
    const b1 = nx && (nx - b0) * dir > 0 ? nx : b0 * (dir < 0 ? 0.75 : 4 / 3);
    const a = lin[b], z = n < ms.length ? lin[n] : t, steps = Math.max(1, Math.ceil((z - a) / RAMP_STEP));
    const bpm = (j) => b0 + ((b1 - b0) * (j + 1)) / steps;
    for (let k = b; k < n; k++) {
      out[k] = [];
      for (let j = Math.floor((lin[k] - a) / RAMP_STEP); a + j * RAMP_STEP < lin[k] + barLen(score, k); j++) out[k].push([Math.max(0, a + j * RAMP_STEP - lin[k]), bpm(j)]);
    }
    carry = { bar: n, bpm: b1 };
  });
  return out;
}

export function isValidScore(sc) {
  try {
    if (!sc || !Array.isArray(sc.measures) || !Array.isArray(sc.staves) || !sc.staves.length) return false;
    const n = sc.measures.length;
    if (!n || !sc.measures[0].time) return false;
    if (!sc.measures.every((m) => m.sym === undefined || (m.time && TIME_SYMS[m.sym] && symOk(m.sym, m.time)))) return false;
    if (!sc.measures.every(okRepeats)) return false;
    if (!sc.measures.every((m) => m.ramp === undefined || m.ramp in RAMPS) || (sc.swing !== undefined && !okSwing(sc.swing))) return false;
    if (!sc.measures.every((m, b) => m.tempo === undefined || (b > 0 && okBpm(m.tempo)))) return false;
    if (!sc.measures.every((m) => m.rehearsal === undefined || okText(m.rehearsal, MAX_REHEARSAL))) return false;
    if (!sc.measures.every((m) => m.len === undefined || (Number.isInteger(m.len) && m.len > 0 && m.len % 60 === 0))) return false;
    let okPitch;
    const pitched = (p) => p.step >= 0 && p.step <= 6 && Number.isInteger(p.oct) && Math.abs(p.alter) <= 2 && p.drum === undefined && (p.finger === undefined || FINGER.test(p.finger));
    const drum = (p) => p.step >= 0 && p.step <= 6 && Number.isInteger(p.oct) && p.alter === 0 && Number.isInteger(p.drum) && p.drum >= 35 && p.drum <= 81;
    const okBars = (bars) => Array.isArray(bars) && bars.length === n && bars.every((bar) => Array.isArray(bar) && bar.every((e) =>
      DURS.includes(e.dur) && Array.isArray(e.pitches) && e.pitches.every(okPitch) &&
      (e.grace === undefined || (Array.isArray(e.grace) && e.grace.length > 0 && e.grace.length <= MAX_GRACE && e.pitches.length > 0 && e.grace.every(okPitch))) &&
      (e.marks === undefined || (Array.isArray(e.marks) && e.marks.every((m) => MARKS.includes(m)))) &&
      (e.dyn === undefined || DYNS.includes(e.dyn)) && (e.text === undefined || okText(e.text, MAX_TEXT)) && (e.harm === undefined || okChord(e.harm)) &&
      (e.slur === undefined || e.slur === true) && (e.slurEnd === undefined || e.slurEnd === true) &&
      (e.gliss === undefined || (e.gliss === true && e.pitches.length > 0)) &&
      (e.hp === undefined || e.hp === "<" || e.hp === ">") && (e.hpEnd === undefined || e.hpEnd === true) &&
      [e.slur2, e.slur2End, e.ped, e.pedEnd, e.ottEnd].every((f) => f === undefined || f === true) && (e.ott === undefined || Object.hasOwn(OTT_SHIFT, e.ott)) &&
      (e.lyrics === undefined || (Array.isArray(e.lyrics) && e.lyrics.length > 0 && e.lyrics.length <= MAX_VERSES &&
        e.pitches.length > 0 && e.lyrics[e.lyrics.length - 1] !== null && e.lyrics.every((l) => l === null ||
        (typeof l.text === "string" && l.text.length > 0 && l.text.length <= MAX_LYRIC && (l.hyph === undefined || l.hyph === true) && (l.ext === undefined || l.ext === true)))))));
    const okClefs = (c) => c === undefined || (c && typeof c === "object" && Object.keys(c).length > 0 &&
      Object.entries(c).every(([k, v]) => /^[1-9]\d*$/.test(k) && +k < n && CLEFS.includes(v)));
    return sc.staves.every((st, k) => (okPitch = isPerc(st) ? drum : pitched) && (CLEFS.includes(st.clef) || isPerc(st)) && okBars(st.bars) && okClefs(st.clefs) &&
      (!isPerc(st) || (st.clefs === undefined && st.program === undefined && st.transpose === undefined && !st.brace)) &&
      !(st.brace && sc.staves[k + 1] && isPerc(sc.staves[k + 1])) && // a drum staff is never in a braced pair
      (st.program === undefined || (Number.isInteger(st.program) && st.program >= 0 && st.program <= 127)) &&
      (st.transpose === undefined || okTranspose(st.transpose)) &&
      (st.sound === undefined || (typeof st.sound === "string" && st.sound.length > 0 && st.sound.length <= 64)) &&
      (st.off === undefined || st.off === true) &&
      (st.layers === undefined || (Array.isArray(st.layers) && st.layers.length < MAX_LAYERS && st.layers.every(okBars))));
  } catch { return false; }
}
