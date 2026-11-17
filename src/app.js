// Coda — UI wiring. See docs/DESIGN.md §4 and §6.
import * as M from "./model.js";
import { render, SHEET_W } from "./render.js";
import { play, stop, isPlaying, audition } from "./play.js";
import { demoScore } from "./demo.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const PREFIX = "coda."; // library keys: coda.doc.<id>, coda.current (DESIGN §12)
const DUR_NAMES = { w: "Whole note", h: "Half note", q: "Quarter note", 8: "Eighth note", 16: "16th note", 32: "32nd note" };
const KEY_LABELS = {
  "-7": "C♭ major / A♭ minor (7♭)", "-6": "G♭ major / E♭ minor (6♭)", "-5": "D♭ major / B♭ minor (5♭)",
  "-4": "A♭ major / F minor (4♭)", "-3": "E♭ major / C minor (3♭)", "-2": "B♭ major / G minor (2♭)",
  "-1": "F major / D minor (1♭)", 0: "C major / A minor", 1: "G major / E minor (1♯)",
  2: "D major / B minor (2♯)", 3: "A major / F♯ minor (3♯)", 4: "E major / C♯ minor (4♯)",
  5: "B major / G♯ minor (5♯)", 6: "F♯ major / D♯ minor (6♯)", 7: "C♯ major / A♯ minor (7♯)",
};

const state = {
  score: null,
  docId: null, // library entry of the open score; written on the first edit
  caret: { staff: 0, bar: 0 },
  sel: null,
  selEnd: null, // other end of a range on the same staff, {bar, idx} (DESIGN §11.7)
  clip: null,
  armed: { dur: "q", dots: 0, rest: false, alter: null, chord: false, tup: null },
  undo: [], redo: [],
  hit: null,
};

// ---------- persistence ----------

function getCurrent() {
  try { return sessionStorage.getItem(PREFIX + "current") || localStorage.getItem(PREFIX + "current"); } catch { return null; }
}

function setCurrent(id) {
  try { sessionStorage.setItem(PREFIX + "current", id); localStorage.setItem(PREFIX + "current", id); } catch { /* blocked */ }
}

// Pick the score to show: ?demo, else this tab's score, else the newest saved one, else a blank one.
function loadInitial() {
  let ls = null;
  try { ls = localStorage; } catch { /* blocked */ }
  if (ls) store.migrate(ls, PREFIX, "coda.score");
  state.docId = store.newId();
  if (new URLSearchParams(location.search).has("demo")) return demoScore();
  if (ls) {
    for (const id of [getCurrent(), ...store.list(ls, PREFIX).filter((e) => e.ok).map((e) => e.id)]) {
      const sc = id && store.load(ls, PREFIX, id);
      if (sc) { state.docId = id; setCurrent(id); return sc; }
    }
  }
  return M.newScore({ bars: 16 });
}

let saveFailed = false;
function autosave() {
  let ok = false;
  try { ok = store.save(localStorage, PREFIX, state.docId, state.score); } catch { /* blocked */ }
  if (ok) {
    setCurrent(state.docId);
    if (saveFailed) { saveFailed = false; message("Saved in this browser again"); }
  } else {
    saveFailed = true;
    message("Couldn't save in this browser (storage full or blocked). Use Save to keep a file.", true, true);
  }
}

// ---------- editing core ----------

// Every score change goes through here: snapshot, run, roll back on failure, re-render, save.
function edit(fn, { keepRedo = false } = {}) {
  const snap = JSON.stringify(state.score);
  let reason;
  try { reason = fn(state.score); if (!reason) M.clearBrokenTies(state.score); } catch (e) { console.error(e); reason = "Something went wrong"; }
  if (reason) {
    state.score = JSON.parse(snap);
    message(reason, true);
    return false;
  }
  state.undo.push(snap);
  if (state.undo.length > 200) state.undo.shift();
  if (!keepRedo) state.redo = [];
  refresh();
  autosave();
  return true;
}

// Show a different score. A new id unless `id` is given; written now when `save` is true
// (a blank New score is written on its first edit, so abandoned ones don't pile up).
function replaceScore(sc, { id = null, save = true } = {}) {
  stop();
  state.score = sc;
  state.docId = id || store.newId();
  state.undo = []; state.redo = [];
  state.sel = null;
  state.caret = { staff: 0, bar: 0 };
  refresh();
  if (save) autosave(); else setCurrent(state.docId);
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.score));
  state.score = JSON.parse(state.undo.pop());
  fixRefs(); refresh(); autosave();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.score));
  state.score = JSON.parse(state.redo.pop());
  fixRefs(); refresh(); autosave();
}

// Keep caret/selection pointing at things that exist.
function fixRefs() {
  const sc = state.score;
  state.caret.staff = Math.min(state.caret.staff, sc.staves.length - 1);
  state.caret.bar = Math.min(state.caret.bar, sc.measures.length - 1);
  const s = state.sel;
  if (s && !(sc.staves[s.staff] && sc.staves[s.staff].bars[s.bar] && sc.staves[s.staff].bars[s.bar][s.idx])) state.sel = null;
  const e = state.selEnd;
  if (e && !(state.sel && sc.staves[state.sel.staff].bars[e.bar] && sc.staves[state.sel.staff].bars[e.bar][e.idx])) state.selEnd = null;
}

function selEvent() {
  const s = state.sel;
  return s ? state.score.staves[s.staff].bars[s.bar][s.idx] : null;
}

// ---------- rendering + chrome ----------

function refresh() {
  fixRefs();
  const sc = state.score;
  $("title").textContent = sc.title || "Untitled";
  $("composer").textContent = sc.composer || "";
  $("tempo").value = sc.tempo;
  document.title = (sc.title || "Untitled") + " — Coda";
  state.hit = render(sc, $("systems"), state.sel && { ...state.sel, end: state.selEnd });
  if (state.hit.errors.length) message(state.hit.errors.join("; "), true);
  $("b-undo").disabled = !state.undo.length;
  $("b-redo").disabled = !state.redo.length;
  $("b-delbar").disabled = sc.measures.length <= 1;
  drawCaret();
  updatePalette();
  updateStatus();
}

function cellRect(cells) {
  // client-space rectangle (relative to #sheet) covering the given hit-map cells
  if (!cells.length) return null;
  const svg = cells[0].svg;
  const r = svg.getBoundingClientRect(), sheet = $("sheet").getBoundingClientRect();
  const k = r.width / SHEET_W;
  const x0 = Math.min(...cells.map((c) => c.x0)), x1 = Math.max(...cells.map((c) => c.x1));
  const y0 = Math.min(...cells.map((c) => c.yTop)) - 14, y1 = Math.max(...cells.map((c) => c.yBottom)) + 14;
  return { left: r.left - sheet.left + x0 * k, top: r.top - sheet.top + y0 * k, width: (x1 - x0) * k, height: (y1 - y0) * k };
}

function place(el, rect) {
  if (!rect) { el.style.display = "none"; return; }
  Object.assign(el.style, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
}

function drawCaret() {
  if (!state.hit) return;
  const c = state.hit.cells.filter((c) => c.staff === state.caret.staff && c.bar === state.caret.bar);
  place($("caret-hl"), cellRect(c));
}

function updateStatus() {
  const sc = state.score, { staff, bar } = state.caret;
  const a = state.armed;
  const parts = [`Bar ${bar + 1}`, `Staff ${staff + 1}${sc.staves[staff].name ? " (" + sc.staves[staff].name + ")" : ""}`];
  const ev = selEvent();
  const n = range().length;
  if (n > 1) parts.push(`${n} notes selected`);
  else if (ev) parts.push("Selected: " + (ev.pitches.length ? ev.pitches.map(M.pitchName).join(" ") : "rest") + " " + DUR_NAMES[ev.dur].toLowerCase());
  else parts.push(["", "Dotted ", "Double-dotted "][a.dots] + (a.dots ? DUR_NAMES[a.dur].toLowerCase() : DUR_NAMES[a.dur]) + (a.rest ? " rest" : "") + (a.tup ? " triplet" : "") + (a.chord ? " · chord mode" : ""));
  $("status-pos").textContent = parts.join(" · ");
}

let msgTimer = 0;
function message(text, warn = false, sticky = false) {
  const el = $("status-msg");
  el.textContent = text;
  el.classList.toggle("warn", warn);
  $("status-hint").hidden = !!text;
  clearTimeout(msgTimer);
  if (!sticky) msgTimer = setTimeout(() => { el.textContent = ""; $("status-hint").hidden = false; }, 3500);
}

// ---------- palette ----------

const NOTE_HEAD = (filled) => `<ellipse cx="10" cy="18" rx="4.6" ry="3.3" transform="rotate(-20 10 18)" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.6"'}/>`;
const STEM = '<line x1="14.2" y1="17" x2="14.2" y2="3" stroke="currentColor" stroke-width="1.4"/>';
const FLAG = (y) => `<path d="M14.2 ${y} c0 3 5 4 4.5 9 c1-4-2-5-4.5-6" fill="currentColor"/>`;
const ICONS = {
  w: '<ellipse cx="12" cy="13" rx="5.5" ry="3.8" fill="none" stroke="currentColor" stroke-width="2"/>',
  h: NOTE_HEAD(false) + STEM,
  q: NOTE_HEAD(true) + STEM,
  8: NOTE_HEAD(true) + STEM + FLAG(3),
  16: NOTE_HEAD(true) + STEM + FLAG(3) + FLAG(7),
  32: NOTE_HEAD(true) + STEM + FLAG(3) + FLAG(6.5) + FLAG(10),
  rest: '<path d="M10 3 l5 6 l-4 5 l5 5 c-3-1-5 0-3 4 c-4-3-3-6 0-6 l-5-5 l4-4z" fill="currentColor"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  sharp: '<g stroke="currentColor"><line x1="9.5" y1="3" x2="9.5" y2="21" stroke-width="1.4"/><line x1="14.5" y1="2" x2="14.5" y2="20" stroke-width="1.4"/><line x1="6" y1="10" x2="18" y2="7" stroke-width="2.6"/><line x1="6" y1="16" x2="18" y2="13" stroke-width="2.6"/></g>',
  flat: '<path d="M9 2 v19 c4-2 8-5 8-8 c0-3-4-4-8-1" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  natural: '<g stroke="currentColor" fill="none"><path d="M8.5 3 v14 l7-2.5" stroke-width="1.5"/><path d="M15.5 21 v-14 l-7 2.5" stroke-width="1.5"/></g>',
  tie: '<path d="M3 11 q9 9 18 0 q-9 6 -18 0z" fill="currentColor"/>',
  tup: '<path d="M3 9 v-4 h7 M14 5 h7 v4" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="12" y="10" font-size="9" text-anchor="middle" fill="currentColor" font-family="serif" font-style="italic" font-weight="bold">3</text><g fill="currentColor"><ellipse cx="5" cy="19" rx="2.6" ry="1.9"/><ellipse cx="12" cy="19" rx="2.6" ry="1.9"/><ellipse cx="19" cy="19" rx="2.6" ry="1.9"/></g>',
  chord: '<g fill="currentColor"><ellipse cx="9" cy="19" rx="4.4" ry="3.1" transform="rotate(-20 9 19)"/><ellipse cx="9" cy="12" rx="4.4" ry="3.1" transform="rotate(-20 9 12)"/></g><line x1="13" y1="18" x2="13" y2="2" stroke="currentColor" stroke-width="1.4"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

function buildPalette() {
  const pal = $("palette");
  const durKeys = { w: 7, h: 6, q: 5, 8: 4, 16: 3, 32: 2 };
  const group = document.createElement("div");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Duration");
  group.style.display = "contents";
  for (const d of M.DURS) {
    const b = document.createElement("button");
    b.className = "pal"; b.dataset.dur = d;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", DUR_NAMES[d]);
    b.title = `${DUR_NAMES[d]} (${durKeys[d]})`;
    b.innerHTML = svg(d); // static icon markup, no user data
    b.onclick = () => setDuration(d);
    group.appendChild(b);
  }
  pal.appendChild(group);
  pal.appendChild(document.createElement("hr"));
  const toggles = [
    ["rest", "Rest (R enters one)", () => { state.armed.rest = !state.armed.rest; updatePalette(); updateStatus(); }],
    ["dot", "Dot (.)", () => toggleDot()],
    ["tup", "Triplet: next notes are triplets (;)", () => toggleTriplet()],
    ["sharp", "Sharp (+)", () => accidental(1)],
    ["flat", "Flat (-)", () => accidental(-1)],
    ["natural", "Natural (N)", () => accidental(0)],
    ["tie", "Tie to next note (T)", () => tie()],
    ["chord", "Chord mode: clicks add notes to the selected note (or Shift+A–G)", () => { state.armed.chord = !state.armed.chord; updatePalette(); updateStatus(); }],
  ];
  toggles.forEach(([k, title, fn], i) => {
    if (i === 3 || i === 6) pal.appendChild(document.createElement("hr"));
    const b = document.createElement("button");
    b.className = "pal"; b.dataset.tog = k;
    b.title = title;
    b.setAttribute("aria-label", title.replace(/ \(.*\)$/, ""));
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = svg(k);
    b.onclick = fn;
    pal.appendChild(b);
  });
}

function updatePalette() {
  const a = state.armed, ev = selEvent();
  const dur = ev ? ev.dur : a.dur, dots = ev ? ev.dots : a.dots;
  document.querySelectorAll(".pal[data-dur]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.dur === dur)));
  // accidental buttons show what is armed for the next note, not the selection
  const pressed = { rest: a.rest, dot: dots > 0, sharp: a.alter === 1, flat: a.alter === -1, natural: a.alter === 0, tie: !!(ev && ev.tie), chord: a.chord, tup: !!a.tup };
  document.querySelectorAll(".pal[data-tog]").forEach((b) => b.setAttribute("aria-pressed", String(pressed[b.dataset.tog])));
}

// ---------- commands used by palette + keyboard ----------

function setDuration(d) {
  state.armed.dur = d;
  const s = state.sel;
  if (s) edit((sc) => M.setDuration(sc, s.staff, s.bar, s.idx, d, selEvent().dots));
  else { updatePalette(); updateStatus(); }
}

function toggleDot() {
  const s = state.sel;
  if (s) {
    const ev = selEvent();
    let dots = (ev.dots + 1) % 3;
    // if a second dot doesn't fit, go back to none rather than getting stuck at one
    if (dots === 2 && M.setDuration(JSON.parse(JSON.stringify(state.score)), s.staff, s.bar, s.idx, ev.dur, 2)) dots = 0;
    state.armed.dots = dots;
    edit((sc) => M.setDuration(sc, s.staff, s.bar, s.idx, ev.dur, dots));
  } else {
    state.armed.dots = (state.armed.dots + 1) % 3;
    updatePalette(); updateStatus();
  }
}

function toggleTriplet() {
  state.armed.tup = state.armed.tup ? null : [3, 2];
  updatePalette(); updateStatus();
}

function accidental(v) {
  const s = state.sel;
  if (s && selEvent().pitches.length) {
    if (edit((sc) => M.setAlter(sc, s.staff, s.bar, s.idx, v))) hear(selEvent());
  } else {
    state.armed.alter = state.armed.alter === v ? null : v;
    updatePalette(); updateStatus();
  }
}

function tie() {
  const s = state.sel;
  if (!s) { message("Select a note first", true); return; }
  edit((sc) => M.toggleTie(sc, s.staff, s.bar, s.idx));
}

function makeEvent(pitch) {
  const a = state.armed;
  const ev = { dur: a.dur, dots: a.dots, tie: false, pitches: pitch ? [pitch] : [] };
  if (a.tup && M.tupletOk(a.dur, a.dots, a.tup)) ev.tup = [...a.tup];
  return ev;
}

function withAlter(step, oct) {
  const { key } = M.attrsAt(state.score, state.caret.bar);
  return { step, oct, alter: state.armed.alter ?? M.keyAlter(key, step) };
}

// Append at the caret, auto-advancing to (or creating) the next bar with room.
function enterAtCaret(pitch) {
  const ev = makeEvent(pitch);
  const need = M.eventTicks(ev);
  const sl = state.sel;
  // after the selected note when it's in the caret bar and not the last one: insert there, no auto-advance
  if (sl && sl.staff === state.caret.staff && sl.bar === state.caret.bar && sl.idx < state.score.staves[sl.staff].bars[sl.bar].length - 1) {
    if (edit((sc) => {
      const r = M.insertEvent(sc, sl.staff, sl.bar, sl.idx + 1, ev);
      if (r) return r;
      state.sel = { staff: sl.staff, bar: sl.bar, idx: sl.idx + 1 };
      state.selEnd = null;
      return null;
    })) hear(selEvent());
    return;
  }
  edit((sc) => {
    const s = state.caret.staff;
    let b = state.caret.bar;
    const room = (bb) => M.barCapacity(M.attrsAt(sc, bb).time) - M.barTicks(sc.staves[s].bars[bb]);
    while (room(b) < need) {
      if (need > M.barCapacity(M.attrsAt(sc, b).time)) return "That note is longer than a bar";
      b++;
      if (b >= sc.measures.length) M.addMeasure(sc, sc.measures.length - 1);
    }
    const r = M.appendEvent(sc, s, b, ev);
    if (r) return r;
    state.caret.bar = b;
    state.sel = { staff: s, bar: b, idx: sc.staves[s].bars[b].length - 1 };
    state.selEnd = null;
    return null;
  }) && hear(selEvent());
}

// Sound the pitches of an event (DESIGN §11.2).
function hear(ev) {
  if (ev && ev.pitches.length) audition(ev.pitches.map(M.midi));
}

// Shift+A–G: add that letter above the selected note's top pitch (DESIGN §11.1).
function chordLetter(letter) {
  const s = state.sel;
  if (!s) { message("Select a note first, then Shift+letter adds to it", true); return; }
  const step = "CDEFGAB".indexOf(letter);
  const ev = selEvent();
  let base = ev.pitches[ev.pitches.length - 1];
  if (!base) { // a rest: start from the nearest such letter to the previous note
    const prev = lastPitchBefore() || { step: 0, oct: 4 };
    base = M.fromDiatonic(M.diatonic(prev) - 4);
  }
  const p = M.chordAbove(base, step);
  const { key } = M.attrsAt(state.score, s.bar);
  const pitch = { ...p, alter: state.armed.alter ?? M.keyAlter(key, p.step) };
  if (edit((sc) => M.toggleChordPitch(sc, s.staff, s.bar, s.idx, pitch))) { hear(selEvent()); message(M.pitchName(pitch) + " added"); }
}

function lastPitchBefore() {
  const sc = state.score, s = state.caret.staff;
  const ev = selEvent();
  if (ev && ev.pitches.length && state.sel.staff === s) return ev.pitches[0];
  for (let b = state.caret.bar; b >= 0; b--) {
    const bar = sc.staves[s].bars[b];
    for (let i = bar.length - 1; i >= 0; i--) if (bar[i].pitches.length) return bar[i].pitches[0];
  }
  return null;
}

function typeLetter(letter) {
  const step = "CDEFGAB".indexOf(letter);
  const prev = lastPitchBefore();
  const target = prev ? M.diatonic(prev) : M.BOTTOM_LINE[state.score.staves[state.caret.staff].clef] + 4;
  let best = null;
  for (let oct = 0; oct <= 8; oct++) {
    const d = oct * 7 + step;
    if (!best || Math.abs(d - target) < Math.abs(best - target)) best = d;
  }
  const { oct } = M.fromDiatonic(best);
  enterAtCaret(withAlter(step, oct));
}

// Selected positions in score order (one, or a Shift+arrow range).
function range() {
  const s = state.sel;
  if (!s) return [];
  return state.selEnd ? M.rangePositions(state.score, s.staff, s, state.selEnd) : [{ bar: s.bar, idx: s.idx }];
}

function extendSel(dir) {
  const s = state.sel;
  if (!s) { moveSel(dir); return; }
  const from = state.selEnd || { bar: s.bar, idx: s.idx };
  const n = dir > 0 ? M.nextEventPos(state.score, s.staff, from.bar, from.idx) : M.prevEventPos(state.score, s.staff, from.bar, from.idx);
  if (n) { state.selEnd = n; state.caret.bar = n.bar; refresh(); }
}

function copySel(cut) {
  const r = range();
  if (!r.length) return false;
  const st = state.score.staves[state.sel.staff];
  state.clip = JSON.parse(JSON.stringify(r.map((p) => st.bars[p.bar][p.idx])));
  message(`${r.length} note${r.length > 1 ? "s" : ""} copied`);
  if (cut) deleteSel();
  return true;
}

function paste() {
  if (!state.clip) return false;
  const s = state.sel, last = range().slice(-1)[0];
  const staff = s ? s.staff : state.caret.staff;
  const bar = last ? last.bar : state.caret.bar;
  const idx = last ? last.idx + 1 : state.score.staves[staff].bars[bar].length;
  edit((sc) => {
    const placed = [];
    const r = M.pasteEvents(sc, staff, bar, idx, state.clip, placed);
    if (r) return r;
    const first = placed[0], last = placed[placed.length - 1];
    state.sel = { staff, ...first };
    state.selEnd = placed.length > 1 ? last : null;
    state.caret = { staff, bar: last.bar };
    return null;
  });
  return true;
}

function moveSel(dir) {
  state.selEnd = null;
  const sc = state.score;
  let s = state.sel;
  if (!s) {
    const bar = sc.staves[state.caret.staff].bars[state.caret.bar];
    if (bar.length) state.sel = { staff: state.caret.staff, bar: state.caret.bar, idx: bar.length - 1 };
    refresh();
    return;
  }
  const n = dir > 0 ? M.nextEventPos(sc, s.staff, s.bar, s.idx) : M.prevEventPos(sc, s.staff, s.bar, s.idx);
  if (n) { state.sel = { staff: s.staff, bar: n.bar, idx: n.idx }; state.caret.bar = n.bar; refresh(); }
}

function deleteSel() {
  const s = state.sel, r = range();
  if (!s) return;
  const prev = M.prevEventPos(state.score, s.staff, r[0].bar, r[0].idx);
  edit((sc) => {
    M.deleteRange(sc, s.staff, r[0], r[r.length - 1]);
    state.sel = prev ? { staff: s.staff, bar: prev.bar, idx: prev.idx } : null;
    state.selEnd = null;
    return null;
  });
}

// ---------- mouse ----------

function locate(e) {
  const sysEl = e.target.closest?.(".system");
  if (!sysEl || !state.hit) return null;
  const si = state.hit.systems.findIndex((s) => s.el === sysEl);
  if (si < 0) return null;
  const svgEl = state.hit.systems[si].svg;
  const r = svgEl.getBoundingClientRect();
  const k = SHEET_W / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  const cells = state.hit.cells.filter((c) => c.sys === si);
  if (!cells.length) return null;
  // staff: nearest band (midpoints between staves)
  const staffIds = [...new Set(cells.map((c) => c.staff))];
  let staff = staffIds[0], bestD = Infinity;
  for (const s of staffIds) {
    const c = cells.find((cc) => cc.staff === s);
    const d = y < c.yTop ? c.yTop - y : y > c.yBottom ? y - c.yBottom : 0;
    if (d < bestD) { bestD = d; staff = s; }
  }
  const row = cells.filter((c) => c.staff === staff);
  let cell = row.find((c) => x >= c.x0 && x < c.x1);
  if (!cell) cell = x < row[0].x0 ? row[0] : row[row.length - 1];
  const clef = state.score.staves[staff].clef;
  const p = M.yToPitch(cell.yBottom, cell.spacing, clef, y);
  const near = cell.notes.reduce((best, n) => {
    const d = Math.abs(n.x + 5 - x);
    return d < 14 && (!best || d < best.d) ? { idx: n.idx, d } : best;
  }, null);
  return { cell, staff, bar: cell.bar, pitch: p, near, k, svgEl, x, y };
}

function onClick(e) {
  const L = locate(e);
  if (!L) return;
  state.caret = { staff: L.staff, bar: L.bar };
  state.selEnd = null;
  const chord = e.shiftKey || state.armed.chord;
  const s = state.sel;
  // chord target: the clicked note, else (chord mode) the selection in this staff and bar
  const target = L.near ? L.near.idx : chord && s && s.staff === L.staff && s.bar === L.bar ? s.idx : null;
  if (target !== null && (chord || L.near)) {
    state.sel = { staff: L.staff, bar: L.bar, idx: target };
    if (chord) {
      const { key } = M.attrsAt(state.score, L.bar);
      const pitch = { ...L.pitch, alter: state.armed.alter ?? M.keyAlter(key, L.pitch.step) };
      if (edit((sc) => M.toggleChordPitch(sc, L.staff, L.bar, target, pitch))) hear(selEvent());
    } else {
      refresh();
      hear(selEvent());
    }
    return;
  }
  const pitch = state.armed.rest ? null : withAlter(L.pitch.step, L.pitch.oct);
  const ok = edit((sc) => {
    const at = L.cell.notes.filter((n) => n.x < L.x).length; // insert by position (DESIGN §11.5)
    const r = M.insertEvent(sc, L.staff, L.bar, at, makeEvent(pitch));
    if (r) return r;
    state.sel = { staff: L.staff, bar: L.bar, idx: at };
    return null;
  });
  if (ok && pitch) { message(M.pitchName(pitch)); hear(selEvent()); }
}

function onMove(e) {
  const g = $("ghost");
  const L = locate(e);
  const chordish = state.armed.chord || e.shiftKey;
  if (!L || (L.near && !chordish) || (state.armed.rest && !chordish)) { g.style.display = "none"; return; }
  const sheet = $("sheet").getBoundingClientRect(), r = L.svgEl.getBoundingClientRect();
  const k = r.width / SHEET_W;
  const pos = Math.round((L.cell.yBottom - L.y) / (L.cell.spacing / 2));
  const clamped = Math.max(-10, Math.min(18, pos));
  const ySnap = L.cell.yBottom - clamped * (L.cell.spacing / 2);
  const w = L.cell.spacing * 1.3 * k, h = L.cell.spacing * 0.95 * k;
  Object.assign(g.style, {
    display: "block", width: w + "px", height: h + "px",
    left: r.left - sheet.left + L.x * k - w / 2 + "px", top: r.top - sheet.top + ySnap * k - h / 2 + "px",
  });
}

// ---------- keyboard ----------

function onKey(e) {
  if (document.querySelector("dialog[open]") || openMenu()) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  // let a focused button handle its own Space/Enter
  if (t && t.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === "s") { e.preventDefault(); saveFile(); return; }
  if (mod && k.toLowerCase() === "o") { e.preventDefault(); $("file").click(); return; }
  if (mod && (k === "ArrowUp" || k === "ArrowDown")) { e.preventDefault(); transposeSel(k === "ArrowUp" ? 7 : -7); return; }
  if (mod && k.toLowerCase() === "c") { if (copySel(false)) e.preventDefault(); return; }
  if (mod && k.toLowerCase() === "x") { if (copySel(true)) e.preventDefault(); return; }
  if (mod && k.toLowerCase() === "v") { if (paste()) e.preventDefault(); return; }
  if (mod || e.altKey) return;
  const durKey = { 7: "w", 6: "h", 5: "q", 4: "8", 3: "16", 2: "32" }[k];
  let handled = true;
  if (e.shiftKey && /^[A-G]$/.test(k)) chordLetter(k);
  else if (/^[a-gA-G]$/.test(k)) typeLetter(k.toUpperCase());
  else if (k === "r" || k === "R") enterAtCaret(null);
  else if (durKey) setDuration(durKey);
  else if (k === ".") toggleDot();
  else if (k === "+" || k === "=") accidental(1);
  else if (k === "-" || k === "_") accidental(-1);
  else if (k === "n" || k === "N") accidental(0);
  else if (k === "t" || k === "T") tie();
  else if (k === "ArrowUp") transposeSel(1);
  else if (k === "ArrowDown") transposeSel(-1);
  else if (k === "ArrowLeft") e.shiftKey ? extendSel(-1) : moveSel(-1);
  else if (k === "ArrowRight") e.shiftKey ? extendSel(1) : moveSel(1);
  else if (k === ";") toggleTriplet();
  else if (k === "Delete" || k === "Backspace") deleteSel();
  else if (k === "Escape") { state.sel = null; state.selEnd = null; refresh(); }
  else if (k === " ") togglePlay();
  else if (k === "?") $("help").showModal();
  else handled = false;
  if (handled) e.preventDefault();
}

function transposeSel(steps) {
  const s = state.sel;
  if (!s) { message("Select a note first", true); return; }
  const r = range().filter((p) => state.score.staves[s.staff].bars[p.bar][p.idx].pitches.length);
  if (!r.length) { message("Rests have no pitch", true); return; }
  if (!edit((sc) => { for (const p of r) M.transpose(sc, s.staff, p.bar, p.idx, steps); return null; })) return;
  if (r.length > 1) return;
  const ev = selEvent();
  if (ev && ev.pitches.length) { message(ev.pitches.map(M.pitchName).join(" ")); hear(ev); }
}

// ---------- playback ----------

function togglePlay() { isPlaying() ? stopPlay() : startPlay(); }

function startPlay() {
  const hl = $("play-hl");
  play(state.score, state.caret.bar, (bar) => {
    if (bar === null) { hl.style.display = "none"; $("b-play").disabled = false; return; }
    place(hl, cellRect(state.hit.cells.filter((c) => c.bar === bar)));
    hl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }).catch((e) => message("Audio could not start: " + e.message, true));
  $("b-play").disabled = true;
}

function stopPlay() {
  stop();
  $("play-hl").style.display = "none";
  $("b-play").disabled = false;
}

// ---------- setup dialog ----------

function buildKeySelect(id) {
  const sel = $(id);
  for (let k = -7; k <= 7; k++) {
    const o = document.createElement("option");
    o.value = k; o.textContent = KEY_LABELS[k];
    if (k === 0) o.selected = true;
    sel.appendChild(o);
  }
}

function openSetup(isNew) {
  const d = $("setup"), sc = state.score;
  $("setup-head").textContent = isNew ? "New score" : "Score details";
  $("setup-ok").textContent = isNew ? "Create" : "Apply";
  d.querySelectorAll(".new-only").forEach((el) => (el.hidden = !isNew));
  $("f-title").value = isNew ? "Untitled" : sc.title;
  $("f-composer").value = isNew ? "" : sc.composer;
  $("f-tempo").value = isNew ? 100 : sc.tempo;
  d.dataset.mode = isNew ? "new" : "edit";
  d.returnValue = "";
  d.showModal();
  $("f-title").select();
}

function closeSetup() {
  const d = $("setup");
  if (d.returnValue !== "ok") return;
  const title = $("f-title").value.trim() || "Untitled";
  const composer = $("f-composer").value.trim();
  const tempo = Math.max(20, Math.min(400, +$("f-tempo").value || 100));
  if (d.dataset.mode === "new") {
    const [n, dd] = $("f-time").value.split("/").map(Number);
    replaceScore(M.newScore({
      title, composer, tempo, preset: $("f-preset").value, key: +$("f-key").value,
      time: [n, dd], bars: +$("f-bars").value || 16,
    }), { save: false });
  } else {
    edit((sc) => { sc.title = title; sc.composer = composer; sc.tempo = tempo; return null; });
  }
}

// ---------- key / time change at a bar (DESIGN §11.3) ----------

function openAttrs() {
  const b = state.caret.bar, sc = state.score;
  const { key, time } = M.attrsAt(sc, b);
  const m = sc.measures[b];
  $("attrs-head").textContent = `Key and time from bar ${b + 1}`;
  $("a-key").value = key;
  const ts = $("a-time"), t = `${time[0]}/${time[1]}`;
  if (![...ts.options].some((o) => o.value === t)) ts.add(new Option(t, t));
  ts.value = t;
  $("attrs-remove").hidden = b === 0 || (m.key === undefined && !m.time);
  $("attrs").returnValue = "";
  $("attrs").showModal();
}

function closeAttrs() {
  const how = $("attrs").returnValue, b = state.caret.bar;
  if (how === "remove") edit((sc) => M.clearAttrs(sc, b));
  else if (how === "ok") {
    const time = $("a-time").value.split("/").map(Number), cur = M.attrsAt(state.score, b).time;
    const changed = time[0] !== cur[0] || time[1] !== cur[1];
    // only pass time when it changes, so a key change never trips the bar-fit check
    edit((sc) => M.setAttrs(sc, b, changed ? { key: +$("a-key").value, time } : { key: +$("a-key").value }));
  }
}

// ---------- menu bar (DESIGN §13.1) ----------

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const openMenu = () => document.querySelector("#menubar .mlist:not([hidden])");

function closeMenus(focusButton = false) {
  const list = openMenu();
  if (!list) return;
  list.hidden = true;
  const mb = list.previousElementSibling;
  mb.setAttribute("aria-expanded", "false");
  if (focusButton) mb.focus();
}

function showMenu(mb, focusFirst) {
  closeMenus();
  const list = mb.nextElementSibling;
  if (mb.textContent === "Edit") { // enable what can act now
    const has = !!state.sel;
    $("m-cut").disabled = $("m-copy").disabled = $("m-delete").disabled = !has;
    $("m-paste").disabled = !state.clip;
  }
  list.hidden = false;
  mb.setAttribute("aria-expanded", "true");
  if (focusFirst) list.querySelector("button:not(:disabled)")?.focus();
}

function setupMenus() {
  const bar = $("menubar"), mbs = [...bar.querySelectorAll(".mb")];
  // shortcut labels
  for (const b of bar.querySelectorAll("[data-short]")) {
    const k = document.createElement("kbd");
    k.textContent = b.dataset.short.replace("mod+", IS_MAC ? "⌘" : "Ctrl+").replace("Shift+", IS_MAC ? "⇧" : "Shift+");
    const label = document.createElement("span");
    label.textContent = b.textContent;
    b.replaceChildren(label, k);
  }
  mbs.forEach((mb, i) => {
    mb.onclick = () => (mb.getAttribute("aria-expanded") === "true" ? closeMenus() : showMenu(mb, false));
    mb.onmouseenter = () => { if (openMenu() && mb.getAttribute("aria-expanded") !== "true") showMenu(mb, false); };
    mb.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); showMenu(mb, true); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); mbs[(i + (e.key === "ArrowRight" ? 1 : mbs.length - 1)) % mbs.length].focus(); }
    };
    const list = mb.nextElementSibling;
    list.onkeydown = (e) => {
      const items = [...list.querySelectorAll("button:not(:disabled)")], at = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        showMenu(mbs[(i + (e.key === "ArrowRight" ? 1 : mbs.length - 1)) % mbs.length], true);
      } else if (e.key === "Escape") { e.preventDefault(); closeMenus(true); }
      else if (e.key === "Tab") closeMenus();
    };
    // after an item's own onclick runs: close, and take focus off the menu so Space plays again
    list.addEventListener("click", (e) => {
      if (!e.target.closest("button")) return;
      closeMenus();
      if (document.activeElement?.closest?.("#menubar")) document.activeElement.blur();
    });
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menubar")) closeMenus(); });
}

// View zoom: the sheet's width; the SVGs scale with it and clicks map through their real size.
let zoom = 1;
function setZoom(z) {
  zoom = Math.max(0.5, Math.min(2.5, Math.round(z * 100) / 100));
  const sh = $("sheet");
  if (zoom === 1) { sh.style.width = ""; sh.style.maxWidth = ""; }
  else { sh.style.width = 1100 * zoom + "px"; sh.style.maxWidth = "none"; }
  drawCaret();
  message(`Zoom ${Math.round(zoom * 100)}%`);
}

// ---------- score library dialog (DESIGN §12) ----------

function openLibrary() {
  const ul = $("lib-list");
  ul.replaceChildren();
  let entries = [];
  try { entries = store.list(localStorage, PREFIX); } catch { /* blocked */ }
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = "No scores saved in this browser yet.";
    ul.appendChild(li);
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = e.ok ? e.title : "Unreadable score";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = e.ok
      ? [e.composer, `${e.bars} bar${e.bars === 1 ? "" : "s"}`, new Date(e.modified).toLocaleString(), e.id === state.docId ? "open now" : ""].filter(Boolean).join(" · ")
      : "This entry is damaged and can only be deleted.";
    info.append(name, meta);
    const btns = document.createElement("div");
    const btn = (label, fn) => { const b = document.createElement("button"); b.className = "btn"; b.type = "button"; b.textContent = label; b.onclick = fn; btns.appendChild(b); };
    if (e.ok && e.id !== state.docId) btn("Open", () => libOpen(e.id));
    if (e.ok) btn("Duplicate", () => libDuplicate(e.id));
    btn("Delete", () => libDelete(e));
    li.append(info, btns);
    ul.appendChild(li);
  }
  if (!$("library").open) $("library").showModal();
}

function libOpen(id) {
  const sc = store.load(localStorage, PREFIX, id);
  if (!sc) { message("That score couldn't be read", true); return; }
  $("library").close();
  replaceScore(sc, { id, save: false });
}

function libDuplicate(id) {
  const sc = store.load(localStorage, PREFIX, id);
  if (!sc) return;
  sc.title = (sc.title || "Untitled") + " (copy)";
  if (!store.save(localStorage, PREFIX, store.newId(), sc)) message("Couldn't save the copy (storage full?)", true);
  openLibrary();
}

function libDelete(e) {
  if (!confirm(`Delete “${e.ok ? e.title : "Unreadable score"}” from this browser? This can't be undone.`)) return;
  store.remove(localStorage, PREFIX, e.id);
  if (e.id === state.docId) {
    const next = store.list(localStorage, PREFIX).find((x) => x.ok);
    const sc = next && store.load(localStorage, PREFIX, next.id);
    if (sc) replaceScore(sc, { id: next.id, save: false });
    else replaceScore(M.newScore({ bars: 16 }), { save: false });
  }
  openLibrary();
}

// ---------- files (implemented in src/io, Phase 3+) ----------

async function saveFile() {
  try {
    const { exportMusicXML } = await import("./io/musicxml.js");
    const xml = exportMusicXML(state.score);
    const name = (state.score.title || "score").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100) + ".musicxml";
    download(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }), name);
    message("Saved " + name);
  } catch (e) { console.error(e); message("Saving is not available yet", true); }
}

async function openFile(file) {
  if (!file) return;
  try {
    const { openFile: open } = await import("./io/open.js");
    const { score, report } = await open(file);
    replaceScore(score);
    showReport(file.name, report);
  } catch (e) {
    console.error(e);
    showReport(file.name, { error: e.message || String(e) });
  }
  if (new URLSearchParams(location.search).has("debug") && /\.musx$/i.test(file.name)) debugMusx(file);
}

// ?debug: save the decoded EnigmaXML of a .musx file, for confirming the format (PLAN Phase 6).
async function debugMusx(file) {
  try {
    const { decodeMusx } = await import("./io/musx.js");
    const text = decodeMusx(new Uint8Array(await file.arrayBuffer()));
    download(new Blob([text], { type: "application/xml" }), file.name.replace(/\.musx$/i, "") + ".enigma.xml");
  } catch (e) { message("Debug decode failed: " + e.message, true); }
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showReport(name, report) {
  const box = $("report"), head = $("report-head"), list = $("report-list");
  list.textContent = "";
  clearTimeout(showReport.t);
  if (report.error) {
    head.textContent = `Could not open “${name}”. ${report.error}`;
  } else {
    head.textContent = `Opened “${name}” (${report.format}) — ${report.notes} notes.`;
    for (const w of report.warnings || []) {
      const li = document.createElement("li");
      li.textContent = w;
      list.appendChild(li);
    }
    if (!(report.warnings || []).length) showReport.t = setTimeout(() => (box.style.display = "none"), 4000);
  }
  box.style.display = "block";
}

// ---------- wire up ----------

function init() {
  state.score = loadInitial();
  buildPalette();
  buildKeySelect("f-key");
  buildKeySelect("a-key");
  $("b-attrs").onclick = openAttrs;
  $("attrs").addEventListener("close", closeAttrs);
  $("attrs-cancel").onclick = () => $("attrs").close("cancel");
  $("attrs-remove").onclick = () => $("attrs").close("remove");
  $("b-new").onclick = () => openSetup(true);
  $("b-lib").onclick = openLibrary;
  $("title").onclick = $("composer").onclick = () => openSetup(false);
  $("setup").addEventListener("close", closeSetup);
  $("setup-cancel").onclick = () => $("setup").close("cancel");
  $("b-open").onclick = () => $("file").click();
  $("file").onchange = (e) => { openFile(e.target.files[0]); e.target.value = ""; };
  $("b-save").onclick = saveFile;
  $("b-print").onclick = () => window.print();
  $("b-undo").onclick = undo;
  $("b-redo").onclick = redo;
  $("b-play").onclick = startPlay;
  $("b-stop").onclick = stopPlay;
  $("b-help").onclick = () => $("help").showModal();
  $("m-about").onclick = () => $("about").showModal();
  $("m-details").onclick = () => openSetup(false);
  $("m-cut").onclick = () => copySel(true);
  $("m-copy").onclick = () => copySel(false);
  $("m-paste").onclick = () => paste();
  $("m-delete").onclick = () => deleteSel();
  $("m-zoomin").onclick = () => setZoom(zoom * 1.2);
  $("m-zoomout").onclick = () => setZoom(zoom / 1.2);
  $("m-zoom1").onclick = () => setZoom(1);
  setupMenus();
  $("report-close").onclick = () => ($("report").style.display = "none");
  $("tempo").onchange = (e) => {
    const v = Math.max(20, Math.min(400, Math.round(+e.target.value) || 100));
    edit((sc) => { sc.tempo = v; return null; });
  };
  $("b-addbar").onclick = () => edit((sc) => { M.addMeasure(sc, state.caret.bar); state.caret.bar++; return null; });
  $("b-delbar").onclick = () => {
    const b = state.caret.bar;
    const has = state.score.staves.some((s) => s.bars[b].length);
    if (has && !confirm(`Delete bar ${b + 1} and its notes?`)) return;
    edit((sc) => M.deleteMeasure(sc, b));
  };
  const systems = $("systems");
  systems.addEventListener("click", onClick);
  systems.addEventListener("mousemove", onMove);
  systems.addEventListener("mouseleave", () => ($("ghost").style.display = "none"));
  document.addEventListener("keydown", onKey);
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawCaret, 100); });
  refresh();
  window.coda = { state, edit, M, locate }; // debugging aid
}

init();
