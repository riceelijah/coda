// Coda score model. PURE: no DOM, no VexFlow. See docs/DESIGN.md §3.
//
// Edit commands mutate the score they are given and return null on success or a
// reason string on failure. Callers (app.js `edit()`) work on a snapshot and roll back
// on failure, so a failed command may leave the score half-changed.

export const PPQ = 480;
export const DURS = ["w", "h", "q", "8", "16", "32"];
export const BASE = { w: 1920, h: 960, q: 480, 8: 240, 16: 120, 32: 60 };
export const CLEFS = ["treble", "bass", "alto", "tenor"];
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
  let key = 0, time = [4, 4];
  for (let j = 0; j <= i && j < score.measures.length; j++) {
    const m = score.measures[j];
    if (m.key !== undefined) key = m.key;
    if (m.time) time = m.time;
  }
  return { key, time };
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

export function nextEventPos(score, s, b, i) {
  const bars = score.staves[s].bars;
  if (i + 1 < bars[b].length) return { bar: b, idx: i + 1 };
  for (let nb = b + 1; nb < bars.length; nb++) if (bars[nb].length) return { bar: nb, idx: 0 };
  return null;
}

export function prevEventPos(score, s, b, i) {
  const bars = score.staves[s].bars;
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
export function rangePositions(score, s, a, z) {
  const before = (p, q) => p.bar < q.bar || (p.bar === q.bar && p.idx <= q.idx);
  const [lo, hi] = before(a, z) ? [a, z] : [z, a];
  const out = [];
  for (let p = lo; p && before(p, hi); p = nextEventPos(score, s, p.bar, p.idx)) out.push(p);
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
    if (!ev.pitches.length) ev.tie = false;
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

export function transpose(score, s, b, i, steps) {
  const ev = score.staves[s].bars[b][i];
  if (!ev.pitches.length) return "Rests have no pitch";
  const { key } = attrsAt(score, b);
  ev.pitches = ev.pitches.map((p) => {
    const np = fromDiatonic(diatonic(p) + steps);
    return { ...np, alter: keyAlter(key, np.step) };
  });
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
  score.staves.forEach((st, s) => st.bars.forEach((bar, b) => bar.forEach((ev, i) => {
    if (!ev.tie) return;
    const n = nextEventPos(score, s, b, i);
    const ne = n && (n.bar === b || n.bar === b + 1) ? st.bars[n.bar][n.idx] : null;
    if (!ne || !ev.pitches.some((p) => ne.pitches.some((q) => samePitch(p, q) && p.alter === q.alter))) ev.tie = false;
  })));
}

export function addMeasure(score, after) {
  score.measures.splice(after + 1, 0, {});
  for (const st of score.staves) st.bars.splice(after + 1, 0, []);
  return null;
}

export function deleteMeasure(score, idx) {
  if (score.measures.length <= 1) return "A score needs at least one bar";
  const a0 = attrsAt(score, 0);
  score.measures.splice(idx, 1);
  for (const st of score.staves) st.bars.splice(idx, 1);
  if (idx === 0) {
    const m = score.measures[0];
    if (m.key === undefined) m.key = a0.key;
    if (!m.time) m.time = a0.time;
  }
  return null;
}

// Set key and/or time from bar b on. A value equal to the previous bar's is stored as "no change".
export function setAttrs(score, b, { key, time }) {
  const m = score.measures[b], prev = b > 0 ? attrsAt(score, b - 1) : null;
  if (key !== undefined) { if (prev && prev.key === key) delete m.key; else m.key = key; }
  if (time) {
    if (prev && prev.time[0] === time[0] && prev.time[1] === time[1]) delete m.time; else m.time = time;
    for (let j = b; j < score.measures.length; j++) {
      if (j > b && score.measures[j].time) break;
      for (const st of score.staves) if (!fits(score, j, st.bars[j])) return `Bar ${j + 1} would overflow`;
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
  delete m.key; delete m.time;
  if (hadTime) for (let j = b; j < score.measures.length; j++) {
    if (j > b && score.measures[j].time) break;
    for (const st of score.staves) if (!fits(score, j, st.bars[j])) return `Bar ${j + 1} would overflow`;
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
  key = 0, time = [4, 4], bars = 16 } = {}) {
  const n = Math.max(1, Math.min(999, bars | 0));
  return {
    title, composer, tempo,
    measures: Array.from({ length: n }, (_, i) => (i === 0 ? { key, time } : {})),
    staves: PRESETS[preset].map((st) => ({
      name: st.name, clef: st.clef, brace: !!st.brace,
      bars: Array.from({ length: n }, () => []),
    })),
  };
}

export function noteCount(score) {
  let n = 0;
  for (const st of score.staves) for (const bar of st.bars) for (const e of bar) n += e.pitches.length ? 1 : 0;
  return n;
}

// Make every staff have the same bar count as score.measures (importers call this).
export function padBars(score) {
  const n = Math.max(1, score.measures.length, ...score.staves.map((s) => s.bars.length));
  while (score.measures.length < n) score.measures.push({});
  for (const st of score.staves) while (st.bars.length < n) st.bars.push([]);
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
    return sc.staves.every((st) => CLEFS.includes(st.clef) && Array.isArray(st.bars) && st.bars.length === n &&
      (st.program === undefined || (Number.isInteger(st.program) && st.program >= 0 && st.program <= 127)) &&
      st.bars.every((bar) => Array.isArray(bar) && bar.every((e) =>
        DURS.includes(e.dur) && Array.isArray(e.pitches) &&
        e.pitches.every((p) => p.step >= 0 && p.step <= 6 && Number.isInteger(p.oct) && Math.abs(p.alter) <= 2))));
  } catch { return false; }
}
