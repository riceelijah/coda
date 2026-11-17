// Coda score model. PURE: no DOM, no VexFlow. See docs/DESIGN.md §3.
//
// Edit commands mutate the score they are given and return null on success or a
// reason string on failure. Callers (app.js `edit()`) work on a snapshot and roll back
// on failure, so a failed command may leave the score half-changed.

export const PPQ = 480;
export const DURS = ["w", "h", "q", "8", "16", "32"];
export const BASE = { w: 1920, h: 960, q: 480, 8: 240, 16: 120, 32: 60 };
export const CLEFS = ["treble", "bass", "alto", "tenor"];
// Marks a note or rest can carry, in drawing and file order (DESIGN §16). Only a fermata goes on a rest.
export const MARKS = ["fermata", "staccato", "accent", "tenuto", "marcato"];
export const STEP_NAMES = "CDEFGAB";
const STEP_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
// diatonic number (oct*7+step) of each clef's bottom line
export const BOTTOM_LINE = { treble: 30, bass: 18, alto: 24, tenor: 22 };

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
// Menu value <-> {time, sym}: "C", "C|" (also what VexFlow draws) or "n/d".
export function parseTime(v) {
  for (const [sym, t] of Object.entries(TIME_SYMS)) if (v === timeLabel({ time: t, sym })) return { time: [...t], sym };
  const [n, d] = v.split("/").map(Number);
  return { time: [n, d] };
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

function samePitch(a, b) { return a.step === b.step && a.oct === b.oct; }
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

function fits(score, b, bar) { return barTicks(bar) <= barCapacity(attrsAt(score, b).time); }

// ---------- edit commands ----------

export function appendEvent(score, s, b, ev) {
  return insertEvent(score, s, b, score.staves[s].bars[b].length, ev);
}

// Insert ev before index idx of a bar (DESIGN §11.5).
export function insertEvent(score, s, b, idx, ev) {
  const bar = score.staves[s].bars[b];
  if (barTicks(bar) + eventTicks(ev) > barCapacity(attrsAt(score, b).time)) return "Bar is full";
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
    if (barTicks(score.staves[s].bars[b]) + eventTicks(ev) > barCapacity(attrsAt(score, b).time)) {
      // carry on only into an empty next bar (added at the end of the score if needed)
      b++; idx = 0;
      if (b >= score.measures.length) addMeasure(score, score.measures.length - 1);
      if (score.staves[s].bars[b].length) return "Not enough room to paste here";
      if (eventTicks(ev) > barCapacity(attrsAt(score, b).time)) return "A copied note is longer than a bar";
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
export const soundingMidi = (st, p) => midi(p) + (st.transpose?.[0] || 0);
// p moved by an interval, spelled by its letter; past a double accidental, respelled.
export function shiftPitch(p, c, d) {
  const np = fromDiatonic(diatonic(p) + d), m = midi(p) + c;
  const alter = m - midi({ ...np, alter: 0 });
  return Math.abs(alter) <= 2 ? { ...np, alter } : spellMidi(m, 0);
}
const okTranspose = (t) => Array.isArray(t) && t.length === 2 && t.every(Number.isInteger) && Math.abs(t[0]) <= 36 && Math.abs(t[1]) <= 21;
// Set a part's transposition, keeping its sound: every written note in every layer moves by
// old − new. null or [0, 0] = concert pitch.
export function setStaffTranspose(score, s, t) {
  if (t && !okTranspose(t)) return "Unknown transposition";
  const nt = t && (t[0] || t[1]) ? [...t] : null;
  const group = partGroups(score).find((g) => g.includes(s));
  const dc = (score.staves[s].transpose?.[0] || 0) - (nt?.[0] || 0);
  for (const i of group) for (const bars of allLayers(score.staves[i])) for (const bar of bars) for (const ev of bar)
    if ([...ev.pitches, ...(ev.grace || [])].some((p) => midi(p) + dc < 0 || midi(p) + dc > 127)) return "Some notes would be written too high or too low";
  for (const i of group) {
    const st = score.staves[i], ot = st.transpose || [0, 0], dc = ot[0] - (nt?.[0] || 0), dd = ot[1] - (nt?.[1] || 0);
    if (dc || dd) for (const bars of allLayers(st)) for (const bar of bars) for (const ev of bar) {
      ev.pitches = sortPitches(ev.pitches.map((p) => shiftPitch(p, dc, dd)));
      if (ev.grace) ev.grace = ev.grace.map((p) => shiftPitch(p, dc, dd));
    }
    if (nt) st.transpose = nt; else delete st.transpose;
  }
  return null;
}

export function transpose(score, s, b, i, steps) {
  const ev = score.staves[s].bars[b][i];
  if (!ev.pitches.length) return "Rests have no pitch";
  const key = keyAt(score, s, b);
  const move = (p) => { const np = fromDiatonic(diatonic(p) + steps); return { ...np, alter: keyAlter(key, np.step) }; };
  ev.pitches = ev.pitches.map(move);
  if (ev.grace) ev.grace = ev.grace.map(move); // grace notes move with their note
  sortPitches(ev.pitches);
  // drop duplicates created by collisions
  ev.pitches = ev.pitches.filter((p, k, a) => k === 0 || !samePitch(p, a[k - 1]));
  return null;
}

export function setAlter(score, s, b, i, alter) {
  const ev = score.staves[s].bars[b][i];
  if (!ev.pitches.length) return "Rests have no pitch";
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

// ---------- slurs and hairpins (DESIGN §23) ----------
// A span is a flag on its first event (slur: true, hp: "<" or ">") and one on its last (slurEnd,
// hpEnd), in the same staff and layer. One of each kind at a time per layer.
export const SPAN_KINDS = [["slur", "slurEnd"], ["hp", "hpEnd"]];
// Over events in order (2 or more): set the span, or remove it when exactly that one is there.
export function toggleSpan(events, kind, type = true) {
  if (events.length < 2) return "Select two or more notes";
  const end = kind + "End", a = events[0], z = events[events.length - 1];
  if (a[kind] === type && z[end]) { delete a[kind]; delete z[end]; return null; }
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
    for (const bar of bars) for (const ev of bar) {
      if (ev[ke]) { if (open) open = null; else { delete ev[ke]; n++; } }
      if (ev[k]) { if (open) { delete open[k]; n++; } open = ev; }
    }
    if (open) { delete open[k]; n++; }
  }
  return n;
}

// ---------- lyrics (DESIGN §24) ----------
// ev.lyrics = [{text, hyph?} | null, …]: verse v's syllable at index v (null: none in that verse),
// hyph a hyphen to the next one. No trailing nulls; absent when empty. Notes only.
export const MAX_LYRIC = 40, MAX_VERSES = 5;
// ---------- grace notes (DESIGN §26) ----------
// ev.grace = [pitch, …]: single grace notes before a note, played on the beat. One draws as a
// slashed eighth, more as beamed sixteenths.
export const MAX_GRACE = 8;
export function addGrace(ev, pitch) {
  if (!ev.pitches.length) return "Grace notes go before a note, not a rest";
  if ((ev.grace || []).length >= MAX_GRACE) return `At most ${MAX_GRACE} grace notes before a note`;
  ev.grace = [...(ev.grace || []), { step: pitch.step, oct: pitch.oct, alter: pitch.alter || 0 }]; // a new array: pasted copies share none
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

export function setLyric(ev, text, hyph = false, verse = 0) {
  if (!Number.isInteger(verse) || verse < 0 || verse >= MAX_VERSES) return;
  if (!ev.pitches.length) { delete ev.lyrics; return; }
  const t = String(text || "").trim().slice(0, MAX_LYRIC);
  const ls = Array.from({ length: Math.max(ev.lyrics?.length || 0, verse + 1) }, (_, i) => ev.lyrics?.[i] ?? null); // no holes
  ls[verse] = t ? (hyph ? { text: t, hyph: true } : { text: t }) : null;
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

// Drop ties whose next note no longer shares a pitch (after inserts, pastes, edits).
export function clearBrokenTies(score) {
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    if (!ev.tie) return;
    const n = nextEventPos(score, s, b, i, v);
    const ne = n && (n.bar === b || n.bar === b + 1) ? bars[n.bar][n.idx] : null;
    if (!ne || !ev.pitches.some((p) => ne.pitches.some((q) => samePitch(p, q) && p.alter === q.alter))) ev.tie = false;
  }))));
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
  const a0 = attrsAt(score, 0);
  score.measures.splice(idx, 1);
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
      for (const st of score.staves) for (const bars of allLayers(st)) if (!fits(score, j, bars[j])) return `Bar ${j + 1} would overflow`;
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
    for (const st of score.staves) for (const bars of allLayers(st)) if (!fits(score, j, bars[j])) return `Bar ${j + 1} would overflow`;
  }
  return null;
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
  grand: [{ clef: "treble", brace: true }, { clef: "bass" }],
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
      part = PART_KINDS[r.kind].map((k) => ({ name, clef: k.clef, brace: !!k.brace, ...(program ? { program } : {}),
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
};

export function newScore({ title = "Untitled", composer = "", tempo = 100, preset = "treble",
  key = 0, time = [4, 4], sym, bars = 16, program = 0 } = {}) {
  const n = Math.max(1, Math.min(999, bars | 0));
  return {
    title, composer, tempo,
    measures: Array.from({ length: n }, (_, i) => (i === 0 ? { key, time, ...(symOk(sym, time) && sym ? { sym } : {}) } : {})),
    staves: PRESETS[preset].map((st) => ({
      name: st.name, clef: st.clef, brace: !!st.brace, ...(program ? { program } : {}),
      bars: Array.from({ length: n }, () => []),
    })),
  };
}

export function noteCount(score) {
  let n = 0;
  for (const st of score.staves) for (const bars of allLayers(st)) for (const bar of bars) for (const e of bar) n += e.pitches.length ? 1 : 0;
  return n;
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
export function isValidScore(sc) {
  try {
    if (!sc || !Array.isArray(sc.measures) || !Array.isArray(sc.staves) || !sc.staves.length) return false;
    const n = sc.measures.length;
    if (!n || !sc.measures[0].time) return false;
    if (!sc.measures.every((m) => m.sym === undefined || (m.time && TIME_SYMS[m.sym] && symOk(m.sym, m.time)))) return false;
    const okPitch = (p) => p.step >= 0 && p.step <= 6 && Number.isInteger(p.oct) && Math.abs(p.alter) <= 2;
    const okBars = (bars) => Array.isArray(bars) && bars.length === n && bars.every((bar) => Array.isArray(bar) && bar.every((e) =>
      DURS.includes(e.dur) && Array.isArray(e.pitches) && e.pitches.every(okPitch) &&
      (e.grace === undefined || (Array.isArray(e.grace) && e.grace.length > 0 && e.grace.length <= MAX_GRACE && e.pitches.length > 0 && e.grace.every(okPitch))) &&
      (e.marks === undefined || (Array.isArray(e.marks) && e.marks.every((m) => MARKS.includes(m)))) &&
      (e.dyn === undefined || DYNS.includes(e.dyn)) &&
      (e.slur === undefined || e.slur === true) && (e.slurEnd === undefined || e.slurEnd === true) &&
      (e.hp === undefined || e.hp === "<" || e.hp === ">") && (e.hpEnd === undefined || e.hpEnd === true) &&
      (e.lyrics === undefined || (Array.isArray(e.lyrics) && e.lyrics.length > 0 && e.lyrics.length <= MAX_VERSES &&
        e.pitches.length > 0 && e.lyrics[e.lyrics.length - 1] !== null && e.lyrics.every((l) => l === null ||
        (typeof l.text === "string" && l.text.length > 0 && l.text.length <= MAX_LYRIC && (l.hyph === undefined || l.hyph === true)))))));
    const okClefs = (c) => c === undefined || (c && typeof c === "object" && Object.keys(c).length > 0 &&
      Object.entries(c).every(([k, v]) => /^[1-9]\d*$/.test(k) && +k < n && CLEFS.includes(v)));
    return sc.staves.every((st) => CLEFS.includes(st.clef) && okBars(st.bars) && okClefs(st.clefs) &&
      (st.program === undefined || (Number.isInteger(st.program) && st.program >= 0 && st.program <= 127)) &&
      (st.transpose === undefined || okTranspose(st.transpose)) &&
      (st.sound === undefined || (typeof st.sound === "string" && st.sound.length > 0 && st.sound.length <= 64)) &&
      (st.layers === undefined || (Array.isArray(st.layers) && st.layers.length < MAX_LAYERS && st.layers.every(okBars))));
  } catch { return false; }
}
