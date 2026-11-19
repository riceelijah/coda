// Coda — UI wiring. See docs/DESIGN.md §4 and §6.
import * as M from "./model.js";
import { render, SHEET_W, LYRIC_LINE } from "./render.js";
import { play, stop, isPlaying, audition, prefetch, noteName, forgetUserSound, renderAudio, wavBytes, recordType, recordCompressed } from "./play.js";
import * as usnd from "./usersounds.js";
import { GM, FAMILIES } from "./gm.js";
import { demoScore } from "./demo.js";
import * as store from "./store.js";
import { DRUMS } from "./drums.js";

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
  armed: { dur: "q", dots: 0, rest: false, alter: null, chord: false, grace: false, tup: null },
  lastTup: [3, 2], // ratio 9 / ; re-arms (DESIGN §14.4)
  tool: "entry", // or "select" (DESIGN §14.2)
  layer: 0, // active layer 0–3 (NotePad's layers 1–4, DESIGN §15)
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
  try { reason = M.withLayer(state.score, state.layer, () => fn(state.score)); if (!reason) { M.clearBrokenTies(state.score); M.clearBrokenSpans(state.score); } } catch (e) { console.error(e); reason = "Something went wrong"; }
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
  if (s && !(sc.staves[s.staff] && lb(s.staff)[s.bar]?.[s.idx])) state.sel = null;
  const e = state.selEnd;
  if (e && !(state.sel && lb(state.sel.staff)[e.bar]?.[e.idx])) state.selEnd = null;
}

let printing = false; // print without the greyed-out layers
addEventListener("beforeprint", () => { printing = true; refresh(); });
addEventListener("afterprint", () => { printing = false; refresh(); });

// NotePad-style layers 1–4 (DESIGN §15). Switching clears the selection; nothing is created
// until a note is entered.
function setLayer(v) {
  state.layer = v;
  state.sel = null; state.selEnd = null;
  document.querySelectorAll("#layers button").forEach((b, i) => b.setAttribute("aria-checked", String(i === v)));
  refresh();
  message(`Layer ${v + 1}${v ? ": notes you enter go in this layer (stems down in layers 2 and 4)" : ""}`);
}

// Bars of the active layer for staff s (empty bars when that layer doesn't exist yet). Read-only:
// edits go through edit(), which swaps the active layer in (M.withLayer).
function lb(s) {
  const st = state.score.staves[s];
  return M.layerBars(st, state.layer) || st.bars.map(() => []);
}

function selEvent() {
  const s = state.sel;
  return s ? lb(s.staff)[s.bar]?.[s.idx] || null : null;
}

// ---------- rendering + chrome ----------

function refresh() {
  fixRefs();
  const sc = state.score;
  $("title").textContent = sc.title || "Untitled";
  $("composer").textContent = sc.composer || "";
  $("tempo").value = sc.tempo;
  document.title = (sc.title || "Untitled") + " — Coda";
  const layered = state.layer > 0 || sc.staves.some((st) => st.layers);
  state.hit = render(sc, $("systems"), state.sel && { ...state.sel, end: state.selEnd }, { layer: state.layer, dim: layered && !printing });
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
  const k = r.width / SHEET_W, top = svg.viewBox.baseVal.y; // the drawing may start above 0
  const x0 = Math.min(...cells.map((c) => c.x0)), x1 = Math.max(...cells.map((c) => c.x1));
  const y0 = Math.min(...cells.map((c) => c.yTop)) - 14, y1 = Math.max(...cells.map((c) => c.yBottom)) + 14;
  return { left: r.left - sheet.left + x0 * k, top: r.top - sheet.top + (y0 - top) * k, width: (x1 - x0) * k, height: (y1 - y0) * k };
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
  if (state.layer || sc.staves.some((st) => st.layers)) parts.push(`Layer ${state.layer + 1}`);
  const ev = selEvent();
  const n = range().length;
  if (n > 1) parts.push(`${n} notes selected`);
  else if (ev) parts.push("Selected: " + (ev.pitches.length ? ev.pitches.map(M.pitchName).join(" ") : "rest") + " " + DUR_NAMES[ev.dur].toLowerCase());
  else parts.push(["", "Dotted ", "Double-dotted "][a.dots] + (a.dots ? DUR_NAMES[a.dur].toLowerCase() : DUR_NAMES[a.dur]) + (a.rest ? " rest" : "") + (a.tup ? ` · ${a.tup[0]}:${a.tup[1]} tuplet` : "") + (a.chord ? " · chord mode" : ""));
  if (a.grace) parts.push("grace notes (Esc to stop)");
  $("status-pos").textContent = parts.join(" · ");
  updateTracksButton();
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
  select: '<path d="M6 3 l12 10 l-5.5 1 l3.2 6.2 l-2.4 1.2 l-3.2 -6.2 l-4.1 3.6z" fill="currentColor"/>',
  entry: '<path d="M4 20 l1.2-4.6 l10.6-10.6 l3.4 3.4 l-10.6 10.6z M14.6 6 l3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  chord: '<g fill="currentColor"><ellipse cx="9" cy="19" rx="4.4" ry="3.1" transform="rotate(-20 9 19)"/><ellipse cx="9" cy="12" rx="4.4" ry="3.1" transform="rotate(-20 9 12)"/></g><line x1="13" y1="18" x2="13" y2="2" stroke="currentColor" stroke-width="1.4"/>',
  grace: '<ellipse cx="9" cy="18" rx="3.4" ry="2.4" transform="rotate(-20 9 18)" fill="currentColor"/><path d="M12 17.5 V5 q3 2 5 5" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="7" y1="14" x2="17" y2="7" stroke="currentColor" stroke-width="1.3"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

function setTool(t) {
  state.tool = t;
  $("systems").classList.toggle("select-tool", t === "select");
  $("ghost").style.display = "none";
  endDrag();
  document.querySelectorAll(".pal[data-tool]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tool === t)));
  $("status-hint").textContent = t === "select"
    ? "Selection tool: click a note, drag a box around notes, Shift+click to extend · right-click for actions · V for note entry"
    : "Click a staff to add a note · A–G to type · Shift+A–G or Shift+click for chords · ? for help";
}

function buildPalette() {
  const pal = $("palette");
  const tools = document.createElement("div");
  tools.setAttribute("role", "radiogroup");
  tools.setAttribute("aria-label", "Tool");
  tools.style.display = "contents";
  for (const [t, title] of [["select", "Selection tool (V)"], ["entry", "Note entry tool (V)"]]) {
    const b = document.createElement("button");
    b.className = "pal"; b.dataset.tool = t;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", title.replace(/ \(.*\)$/, ""));
    b.setAttribute("aria-checked", String(t === state.tool));
    b.title = title;
    b.innerHTML = svg(t);
    b.onclick = () => setTool(t);
    tools.appendChild(b);
  }
  pal.appendChild(tools);
  pal.appendChild(document.createElement("hr"));
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
    ["tup", "Tuplet: triplets and other groups (9 or ; for the last one)", () => (state.armed.tup ? toggleTuplet() : openTuplet())],
    ["sharp", "Sharp (+)", () => accidental(1)],
    ["flat", "Flat (-)", () => accidental(-1)],
    ["natural", "Natural (N)", () => accidental(0)],
    ["tie", "Tie to next note (T)", () => tie()],
    ["chord", "Chord mode: clicks add notes to the selected note (or Shift+A–G)", () => { state.armed.chord = !state.armed.chord; state.armed.grace = false; updatePalette(); updateStatus(); }],
    ["grace", "Grace notes: clicks or A–G add one before the selected note; Delete removes them", () => graceMode(!state.armed.grace)],
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
  const pressed = { rest: a.rest, dot: dots > 0, sharp: a.alter === 1, flat: a.alter === -1, natural: a.alter === 0, tie: !!(ev && ev.tie), chord: a.chord, grace: a.grace, tup: !!a.tup };
  document.querySelectorAll(".pal[data-tog]").forEach((b) => b.setAttribute("aria-pressed", String(pressed[b.dataset.tog])));
}

// ---------- commands used by palette + keyboard ----------

// Run fn(score, staff, pos, event) on every selected event in one edit: all or nothing (DESIGN §14.2).
function eachSel(fn) {
  const s = state.sel, r = range();
  return edit((sc) => {
    for (const p of r) { const e = fn(sc, s.staff, p, sc.staves[s.staff].bars[p.bar][p.idx]); if (e) return e; }
    return null;
  });
}

// Change the length of every selected event, then check each bar once, so swapping values
// around inside a full bar works.
function retime(fn) {
  const s = state.sel, r = range();
  return edit((sc) => {
    const bars = sc.staves[s.staff].bars;
    for (const p of r) {
      const e = bars[p.bar][p.idx];
      fn(e);
      if (e.tup && !M.tupletOk(e.dur, e.dots, e.tup)) delete e.tup;
    }
    for (const b of new Set(r.map((p) => p.bar))) if (M.barTicks(bars[b]) > M.barLen(sc, b)) return "Bar is full";
    return null;
  });
}

function setDuration(d) {
  state.armed.dur = d;
  if (state.sel) retime((e) => (e.dur = d));
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
    retime((e) => (e.dots = dots));
  } else {
    state.armed.dots = (state.armed.dots + 1) % 3;
    updatePalette(); updateStatus();
  }
}

// 9 (NotePad) or ;: arm or disarm the last-used tuplet ratio for the next notes.
function toggleTuplet() {
  state.armed.tup = state.armed.tup ? null : [...state.lastTup];
  if (state.armed.tup && !M.tupletOk(state.armed.dur, state.armed.dots, state.armed.tup)) message(`A ${state.armed.tup[0]}:${state.armed.tup[1]} tuplet doesn't fit that note value`, true);
  updatePalette(); updateStatus();
}

function accidental(v) {
  const s = state.sel;
  if (s && range().some((p) => lb(s.staff)[p.bar][p.idx].pitches.length)) {
    if (eachSel((sc, st, p, e) => (e.pitches.length ? M.setAlter(sc, st, p.bar, p.idx, v) : null)) && range().length === 1) hear(selEvent());
  } else {
    state.armed.alter = state.armed.alter === v ? null : v;
    updatePalette(); updateStatus();
  }
}

// Toggle a mark (fermata, staccato…) over the selection (DESIGN §16).
function mark(m) {
  if (!state.sel) { message("Select a note first", true); return; }
  const s = state.sel, r = range();
  edit((sc) => M.toggleMark(r.map((p) => sc.staves[s.staff].bars[p.bar][p.idx]), m) ? null : "Only a fermata can go on a rest");
}

// Set or clear the dynamic on the first selected note or rest (DESIGN §22).
function dynamic(d) {
  if (!state.sel) { message("Select a note first", true); return; }
  const s = state.sel, p = range()[0];
  edit((sc) => { M.toggleDyn(sc.staves[s.staff].bars[p.bar][p.idx], d); return null; });
}

// Slur or hairpin over the selected range (DESIGN §23); again removes it.
function span(kind, type) {
  if (!state.sel) { message("Select a note first", true); return; }
  const s = state.sel, r = range();
  edit((sc) => M.toggleSpan(r.map((p) => sc.staves[s.staff].bars[p.bar][p.idx]), kind, type));
}

// ---------- lyrics (DESIGN §24) ----------
// A box under the selected note: Space or Tab moves on, "-" moves on with a hyphen, Shift+Tab
// goes back, Enter or clicking away finishes, Escape drops what's typed. Each syllable is one edit.
// ↑/↓ change verse (state.verse, kept for next time).
function openLyrics() {
  const s = state.sel;
  if (!s || !selEvent()?.pitches.length) { message("Select the note the lyrics start on", true); return; }
  state.selEnd = null;
  state.verse ??= 0;
  message(`Lyrics, verse ${state.verse + 1} (↑/↓ for another verse)`, false, true);
  placeLyricBox();
  const box = $("lyric-box");
  box.hidden = false; box.focus(); box.select();
}

function placeLyricBox() {
  const box = $("lyric-box"), s = state.sel, ev = selEvent();
  const cell = state.hit.cells.find((c) => c.staff === s.staff && c.bar === s.bar);
  const n = cell?.notes.find((q) => q.idx === s.idx);
  if (!cell || !n) { box.hidden = true; return; }
  const r = cell.svg.getBoundingClientRect(), sheet = $("sheet").getBoundingClientRect(), k = r.width / SHEET_W;
  box.value = ev.lyrics?.[state.verse]?.text || "";
  // on the verse's line: verse 1's baseline from the drawing when this staff has lyrics there
  const base = state.hit.lyricY?.[cell.sys + ":" + s.staff] ?? cell.yBottom + 32;
  box.style.left = r.left - sheet.left + (n.x + 6) * k - 55 + "px";
  box.style.top = r.top - sheet.top + (base - 14 + state.verse * LYRIC_LINE - cell.svg.viewBox.baseVal.y) * k + "px";
}

function commitLyric(hyph) {
  const s = state.sel, ev = selEvent(), text = $("lyric-box").value.trim(), v = state.verse, l = ev?.lyrics?.[v];
  if (!s || !ev || ((l?.text || "") === text && !!l?.hyph === (hyph && !!text))) return;
  edit((sc) => { M.setLyric(sc.staves[s.staff].bars[s.bar][s.idx], text, hyph, v); return null; });
}

// Next (dir 1) or previous note with pitches in the layer; false at either end.
function lyricStep(dir) {
  const step = dir > 0 ? M.nextEventPos : M.prevEventPos, staff = state.sel.staff, bars = M.layerBars(state.score.staves[staff], state.layer);
  let p = state.sel;
  do { const n = step(state.score, staff, p.bar, p.idx, state.layer); p = n && { staff, ...n }; }
  while (p && !bars[p.bar][p.idx].pitches.length);
  if (!p) return false;
  state.sel = p; state.caret = { staff: p.staff, bar: p.bar };
  refresh(); placeLyricBox();
  $("lyric-box").focus(); $("lyric-box").select();
  return true;
}

function closeLyrics() { const box = $("lyric-box"); box.hidden = true; box.blur(); message(""); }
const hyphOf = () => !!selEvent()?.lyrics?.[state.verse]?.hyph; // Enter, Shift+Tab and ↑/↓ keep the hyphen

function onLyricKey(e) {
  const k = e.key;
  if (k === " " || (k === "Tab" && !e.shiftKey) || k === "-") {
    e.preventDefault();
    commitLyric(k === "-");
    if (!lyricStep(1)) closeLyrics();
  } else if (k === "Tab") { e.preventDefault(); commitLyric(hyphOf()); lyricStep(-1); }
  else if (k === "Enter") { e.preventDefault(); commitLyric(hyphOf()); closeLyrics(); }
  else if (k === "ArrowUp" || k === "ArrowDown") {
    e.preventDefault();
    const v = state.verse + (k === "ArrowDown" ? 1 : -1);
    if (v < 0 || v >= M.MAX_VERSES) return;
    commitLyric(hyphOf());
    state.verse = v;
    message(`Lyrics, verse ${v + 1}`, false, true);
    placeLyricBox(); $("lyric-box").select();
  }
  else if (k === "Escape") { e.preventDefault(); closeLyrics(); }
}

// Slide each selected note into the next (DESIGN §31); over a range, the whole phrase glides.
// If they all already slide, the slides come off.
function glide() {
  const s = state.sel;
  if (!s) { message("Select a note first", true); return; }
  const r = range();
  if (r.length === 1) { edit((sc) => M.toggleGliss(sc, s.staff, s.bar, s.idx)); return; }
  const body = r.slice(0, -1), bars = lb(s.staff);
  const all = body.every((p) => bars[p.bar][p.idx].gliss || !bars[p.bar][p.idx].pitches.length);
  let n = 0, why = null;
  edit((sc) => {
    for (const p of body) {
      const ev = sc.staves[s.staff].bars[p.bar][p.idx];
      if (all) delete ev.gliss;
      else if (!ev.gliss && ev.pitches.length) { const e = M.toggleGliss(sc, s.staff, p.bar, p.idx); if (e) why = e; else n++; }
    }
    return all || n ? null : why || "Nothing to slide to";
  });
}

function tie() {
  const s = state.sel;
  if (!s) { message("Select a note first", true); return; }
  const r = range();
  if (r.length === 1) { edit((sc) => M.toggleTie(sc, s.staff, s.bar, s.idx)); return; }
  // a range: tie every note that can be tied to the next; if they all already are, untie them
  const body = r.slice(0, -1), bars = lb(s.staff);
  const allTied = body.every((p) => bars[p.bar][p.idx].tie || !bars[p.bar][p.idx].pitches.length);
  let n = 0;
  edit((sc) => {
    for (const p of body) {
      const ev = sc.staves[s.staff].bars[p.bar][p.idx];
      if (allTied) ev.tie = false;
      else if (!ev.tie && !M.toggleTie(sc, s.staff, p.bar, p.idx)) n++;
    }
    return allTied || n ? null : "Nothing to tie to";
  });
}

function makeEvent(pitch) {
  const a = state.armed;
  const ev = { dur: a.dur, dots: a.dots, tie: false, pitches: pitch ? [pitch] : [] };
  if (a.tup && M.tupletOk(a.dur, a.dots, a.tup)) ev.tup = [...a.tup];
  else if (a.tup) message(`A ${a.tup[0]}:${a.tup[1]} tuplet doesn't fit that note value, so this note isn't one`, true);
  return ev;
}

function withAlter(step, oct) {
  const key = M.keyAt(state.score, state.caret.staff, state.caret.bar);
  return M.fitPitch(state.score.staves[state.caret.staff], { step, oct, alter: state.armed.alter ?? M.keyAlter(key, step) });
}

// Append at the caret, auto-advancing to (or creating) the next bar with room.
function enterAtCaret(pitch) {
  const ev = makeEvent(pitch);
  const need = M.eventTicks(ev);
  const sl = state.sel;
  // after the selected note when it's in the caret bar and not the last one: insert there, no auto-advance
  if (sl && sl.staff === state.caret.staff && sl.bar === state.caret.bar && sl.idx < lb(sl.staff)[sl.bar].length - 1) {
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
    const room = (bb) => M.barLen(sc, bb) - M.barTicks(sc.staves[s].bars[bb]);
    while (room(b) < need) {
      if (need > M.barLen(sc, b)) return "That note is longer than a bar";
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
  const st = state.score.staves[state.sel?.staff ?? 0];
  if (ev && ev.pitches.length) audition(ev.pitches.map((p) => M.soundingMidi(st, p)), M.isPerc(st) ? -1 : st.program ?? 0, st.sound);
}

// Shift+A–G: add that letter above the selected note's top pitch (DESIGN §11.1).
// ---------- grace notes (DESIGN §26) ----------
function graceMode(on) {
  state.armed.grace = on;
  if (on) { state.armed.chord = false; message("Click a note, or select one and type A–G, to put a grace note before it"); }
  updatePalette(); updateStatus();
}

function addGrace(s, pitch) {
  pitch = M.fitPitch(state.score.staves[s.staff], pitch);
  if (edit((sc) => M.addGrace(sc.staves[s.staff].bars[s.bar][s.idx], pitch))) { hear({ pitches: [pitch] }); message(M.pitchName(pitch) + " grace note added"); }
}

// A–G in grace mode: the nearest such note to the last grace note, else to the note's top
function graceLetter(letter) {
  const s = state.sel, ev = selEvent();
  if (!s || !ev?.pitches.length) { message("Select the note the grace note goes before", true); return; }
  const ref = M.diatonic(ev.grace?.[ev.grace.length - 1] || ev.pitches[ev.pitches.length - 1]);
  const step = "CDEFGAB".indexOf(letter);
  let d = Math.round((ref - step) / 7) * 7 + step;
  const p = M.fromDiatonic(d);
  addGrace(s, { ...p, alter: state.armed.alter ?? M.keyAlter(M.keyAt(state.score, s.staff, s.bar), p.step) });
}

function clearGrace() {
  const r = range().filter((p) => lb(state.sel.staff)[p.bar][p.idx].grace);
  if (!r.length) { message("No grace notes on the selection", true); return; }
  edit((sc) => { for (const p of r) delete sc.staves[state.sel.staff].bars[p.bar][p.idx].grace; return null; });
}

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
  const key = M.keyAt(state.score, s.staff, s.bar);
  const pitch = M.fitPitch(state.score.staves[s.staff], { ...p, alter: state.armed.alter ?? M.keyAlter(key, p.step) });
  if (inChordAlready(ev, p, pitch)) return;
  if (edit((sc) => M.toggleChordPitch(sc, s.staff, s.bar, s.idx, pitch))) { hear(selEvent()); message(M.pitchName(pitch) + " added"); }
}

// On a drum staff a position with no drum of its own snaps to one that may already be in the
// chord: say so rather than toggling it off (DESIGN §27). The drum's own position still toggles.
function inChordAlready(ev, at, pitch) {
  if (!pitch.drum || (at.step === pitch.step && at.oct === pitch.oct) || !ev.pitches.some((p) => p.drum === pitch.drum)) return false;
  message(M.pitchName(pitch) + " is already in the chord", true);
  return true;
}

function lastPitchBefore() {
  const sc = state.score, s = state.caret.staff;
  const ev = selEvent();
  if (ev && ev.pitches.length && state.sel.staff === s) return ev.pitches[0];
  for (let b = state.caret.bar; b >= 0; b--) {
    const bar = lb(s)[b];
    for (let i = bar.length - 1; i >= 0; i--) if (bar[i].pitches.length) return bar[i].pitches[0];
  }
  return null;
}

function typeLetter(letter) {
  const step = "CDEFGAB".indexOf(letter);
  const prev = lastPitchBefore();
  const target = prev ? M.diatonic(prev) : M.BOTTOM_LINE[M.clefAt(state.score.staves[state.caret.staff], state.caret.bar)] + 4;
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
  return state.selEnd ? M.rangePositions(state.score, s.staff, s, state.selEnd, state.layer) : [{ bar: s.bar, idx: s.idx }];
}

function extendSel(dir) {
  const s = state.sel;
  if (!s) { moveSel(dir); return; }
  const from = state.selEnd || { bar: s.bar, idx: s.idx };
  const n = dir > 0 ? M.nextEventPos(state.score, s.staff, from.bar, from.idx, state.layer) : M.prevEventPos(state.score, s.staff, from.bar, from.idx, state.layer);
  if (n) { state.selEnd = n; state.caret.bar = n.bar; refresh(); }
}

function copySel(cut) {
  const r = range();
  if (!r.length) return false;
  const bars = lb(state.sel.staff);
  state.clip = JSON.parse(JSON.stringify(r.map((p) => bars[p.bar][p.idx])));
  state.clipTr = state.score.staves[state.sel.staff].transpose || [0, 0]; // to keep the sound in another part
  state.clipPerc = M.isPerc(state.score.staves[state.sel.staff]);
  message(`${r.length} note${r.length > 1 ? "s" : ""} copied`);
  if (cut) deleteSel();
  return true;
}

function paste() {
  if (!state.clip) return false;
  const s = state.sel, last = range().slice(-1)[0];
  const staff = s ? s.staff : state.caret.staff;
  const bar = last ? last.bar : state.caret.bar;
  const idx = last ? last.idx + 1 : lb(staff)[bar].length;
  const hasNotes = state.clip.some((e) => e.pitches.length);
  if (hasNotes && !!state.clipPerc !== M.isPerc(state.score.staves[staff])) { message(state.clipPerc ? "Drum notes paste only into a drum part" : "Pitched notes don't paste into a drum part", true); return true; }
  edit((sc) => {
    const placed = [], [c, d] = state.clipTr || [0, 0], [c2, d2] = sc.staves[staff].transpose || [0, 0];
    const clip = c === c2 && d === d2 ? state.clip
      : state.clip.map((e) => ({ ...e, pitches: e.pitches.map((p) => M.shiftPitch(p, c - c2, d - d2)),
        ...(e.grace ? { grace: e.grace.map((p) => M.shiftPitch(p, c - c2, d - d2)) } : {}) }));
    const r = M.pasteEvents(sc, staff, bar, idx, clip, placed);
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
    const bar = lb(state.caret.staff)[state.caret.bar];
    if (bar.length) state.sel = { staff: state.caret.staff, bar: state.caret.bar, idx: bar.length - 1 };
    refresh();
    return;
  }
  const n = dir > 0 ? M.nextEventPos(sc, s.staff, s.bar, s.idx, state.layer) : M.prevEventPos(sc, s.staff, s.bar, s.idx, state.layer);
  if (n) { state.sel = { staff: s.staff, bar: n.bar, idx: n.idx }; state.caret.bar = n.bar; refresh(); }
}

function deleteSel() {
  const s = state.sel, r = range();
  if (!s) return;
  const prev = M.prevEventPos(state.score, s.staff, r[0].bar, r[0].idx, state.layer);
  edit((sc) => {
    M.deleteRange(sc, s.staff, r[0], r[r.length - 1]);
    state.sel = prev ? { staff: s.staff, bar: prev.bar, idx: prev.idx } : null;
    state.selEnd = null;
    return null;
  });
}

// ---------- mouse ----------

function locate(e, forceStaff = null) {
  const sysEl = e.target.closest?.(".system");
  if (!sysEl || !state.hit) return null;
  const si = state.hit.systems.findIndex((s) => s.el === sysEl);
  if (si < 0) return null;
  const svgEl = state.hit.systems[si].svg;
  const r = svgEl.getBoundingClientRect();
  const k = SHEET_W / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k + svgEl.viewBox.baseVal.y;
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
  if (forceStaff !== null && staffIds.includes(forceStaff)) staff = forceStaff;
  const row = cells.filter((c) => c.staff === staff);
  let cell = row.find((c) => x >= c.x0 && x < c.x1);
  if (!cell) cell = x < row[0].x0 ? row[0] : row[row.length - 1];
  const clef = M.clefAt(state.score.staves[staff], cell.bar);
  const p = M.yToPitch(cell.yBottom, cell.spacing, clef, y);
  const near = cell.notes.reduce((best, n) => {
    const d = Math.abs(n.x + 5 - x);
    return d < 14 && (!best || d < best.d) ? { idx: n.idx, d } : best;
  }, null);
  return { cell, staff, bar: cell.bar, pitch: p, near, k, svgEl, x, y };
}

function onClick(e) {
  if (state.tool === "select") return; // handled by onDown / onDrag
  const L = locate(e);
  if (!L) return;
  state.caret = { staff: L.staff, bar: L.bar };
  state.selEnd = null;
  if (state.armed.grace) { // grace mode: a click on a note adds a grace note at the clicked pitch
    if (!L.near) { message("Click a note to put a grace note before it", true); return; }
    state.sel = { staff: L.staff, bar: L.bar, idx: L.near.idx };
    addGrace(state.sel, withAlter(L.pitch.step, L.pitch.oct));
    return;
  }
  const chord = e.shiftKey || state.armed.chord;
  const s = state.sel;
  // chord target: the clicked note, else (chord mode) the selection in this staff and bar
  const target = L.near ? L.near.idx : chord && s && s.staff === L.staff && s.bar === L.bar ? s.idx : null;
  if (target !== null && (chord || L.near)) {
    state.sel = { staff: L.staff, bar: L.bar, idx: target };
    if (chord) {
      const key = M.keyAt(state.score, L.staff, L.bar);
      const pitch = M.fitPitch(state.score.staves[L.staff], { ...L.pitch, alter: state.armed.alter ?? M.keyAlter(key, L.pitch.step) });
      if (inChordAlready(selEvent(), L.pitch, pitch)) return;
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
  if (state.tool === "select") { g.style.display = "none"; return; }
  const L = locate(e);
  const chordish = state.armed.chord || state.armed.grace || e.shiftKey;
  if (!L || (L.near && !chordish) || (state.armed.rest && !chordish)) { g.style.display = "none"; return; }
  const sheet = $("sheet").getBoundingClientRect(), r = L.svgEl.getBoundingClientRect();
  const k = r.width / SHEET_W;
  const pos = Math.round((L.cell.yBottom - L.y) / (L.cell.spacing / 2));
  const clamped = Math.max(-10, Math.min(18, pos));
  const ySnap = L.cell.yBottom - clamped * (L.cell.spacing / 2);
  const w = L.cell.spacing * 1.3 * k, h = L.cell.spacing * 0.95 * k;
  Object.assign(g.style, {
    display: "block", width: w + "px", height: h + "px",
    left: r.left - sheet.left + L.x * k - w / 2 + "px", top: r.top - sheet.top + (ySnap - L.svgEl.viewBox.baseVal.y) * k - h / 2 + "px",
  });
}

// ---------- Selection tool (DESIGN §14.2) ----------

let drag = null, dragged = false; // dragged: swallow the click that ends a box drag
const nearestIdx = (L) => (L.cell.notes.length
  ? L.cell.notes.reduce((b, n) => (Math.abs(n.x - L.x) < Math.abs(b.x - L.x) ? n : b)).idx : null);

function onDown(e) {
  dragged = false;
  if (state.tool !== "select" || e.button !== 0 || e.target.closest("input, button:not(#title, #composer)")) return;
  e.preventDefault();
  const L = locate(e), sh = $("sheet").getBoundingClientRect();
  // any drag past 4 px draws a selection box, wherever it starts
  if (!e.shiftKey) drag = { x: e.clientX - sh.left, y: e.clientY - sh.top, staff: L?.staff, moved: false };
  if (!L) return;
  state.caret = { staff: L.staff, bar: L.bar };
  const idx = nearestIdx(L);
  if (idx === null) { if (!e.shiftKey) { state.sel = null; state.selEnd = null; } refresh(); return; } // empty bar
  const pos = { bar: L.bar, idx }, s = state.sel;
  if (e.shiftKey && s && s.staff === L.staff) {
    state.selEnd = s.bar === pos.bar && s.idx === pos.idx ? null : pos;
  } else {
    state.sel = { staff: L.staff, ...pos };
    state.selEnd = null;
    hear(selEvent());
  }
  refresh();
}

function endDrag() {
  if (drag?.moved) dragged = true;
  drag = null;
  $("sel-box").style.display = "none";
}

// Events whose heads are inside the box (sheet coordinates): [{staff, bar, idx}].
function boxHits(box, sh) {
  const hits = [];
  state.hit.systems.forEach((sys, si) => {
    const r = sys.svg.getBoundingClientRect(), k = r.width / SHEET_W, vy = sys.svg.viewBox.baseVal.y;
    const px = (x) => r.left - sh.left + x * k, py = (y) => r.top - sh.top + (y - vy) * k;
    for (const c of state.hit.cells) {
      if (c.sys !== si) continue;
      for (const n of c.notes) {
        const x = px(n.x + 5), ys = n.ys.length ? n.ys : [(c.yTop + c.yBottom) / 2];
        if (x >= box.l && x <= box.r && ys.some((y) => py(y) >= box.t && py(y) <= box.b)) hits.push({ staff: c.staff, bar: c.bar, idx: n.idx });
      }
    }
  });
  return hits;
}

function onDrag(e) {
  if (!drag) return;
  if (!e.buttons) { endDrag(); return; } // released outside the window
  const sh = $("sheet").getBoundingClientRect(), x = e.clientX - sh.left, y = e.clientY - sh.top;
  if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 4) return;
  drag.moved = true;
  const box = { l: Math.min(x, drag.x), r: Math.max(x, drag.x), t: Math.min(y, drag.y), b: Math.max(y, drag.y) };
  Object.assign($("sel-box").style, { display: "block", left: box.l + "px", top: box.t + "px", width: box.r - box.l + "px", height: box.b - box.t + "px" });
  // a range stays on one staff: the one pressed on if the box holds notes there, else the top one
  const hits = boxHits(box, sh);
  const staff = hits.some((h) => h.staff === drag.staff) ? drag.staff : Math.min(...hits.map((h) => h.staff));
  const on = hits.filter((h) => h.staff === staff).sort((a, b) => a.bar - b.bar || a.idx - b.idx);
  const first = on[0], last = on[on.length - 1];
  const sel = first ? { staff, bar: first.bar, idx: first.idx } : null;
  const end = first && (last.bar !== first.bar || last.idx !== first.idx) ? { bar: last.bar, idx: last.idx } : null;
  const same = (a, b) => (!a && !b) || (a && b && a.staff === b.staff && a.bar === b.bar && a.idx === b.idx);
  if (same(sel, state.sel) && same(end && { staff, ...end }, state.selEnd && { staff, ...state.selEnd })) return;
  state.sel = sel; state.selEnd = end;
  if (sel) state.caret = { staff, bar: (end || sel).bar };
  refresh();
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
  if (mod && runShortcut(e)) return;
  if (mod && k.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && (k === "ArrowUp" || k === "ArrowDown")) { e.preventDefault(); transposeSel(k === "ArrowUp" ? 7 : -7); return; }
  if (mod || e.altKey) return;
  const durKey = { 7: "w", 6: "h", 5: "q", 4: "8", 3: "16", 2: "32" }[k];
  let handled = true;
  if (e.shiftKey && /^[A-G]$/.test(k)) chordLetter(k);
  else if (state.armed.grace && /^[a-gA-G]$/.test(k)) graceLetter(k.toUpperCase());
  else if (/^[a-gA-G]$/.test(k)) typeLetter(k.toUpperCase());
  else if (k === "r" || k === "R" || k === "0") enterAtCaret(null); // 0: NotePad's rest key
  else if (durKey) setDuration(durKey);
  else if (k === ".") toggleDot();
  else if (k === "+" || k === "=") accidental(1);
  else if (k === "-" || k === "_") accidental(-1);
  else if (k === "n" || k === "N") accidental(0);
  else if (k === "t" || k === "T") tie();
  else if (k === "s" || k === "S") span("slur", true);
  else if (k === "l" || k === "L") openLyrics();
  else if (k === "ArrowUp") transposeSel(e.shiftKey ? 7 : 1); // Shift: an octave, as in NotePad
  else if (k === "ArrowDown") transposeSel(e.shiftKey ? -7 : -1);
  else if (k === "ArrowLeft") e.shiftKey ? extendSel(-1) : moveSel(-1);
  else if (k === "ArrowRight") e.shiftKey ? extendSel(1) : moveSel(1);
  else if (k === ";" || k === "9") toggleTuplet();
  else if ((k === "Delete" || k === "Backspace") && state.armed.grace && state.sel) clearGrace();
  else if (k === "Delete" || k === "Backspace") deleteSel();
  else if (k === "Escape" && state.armed.grace) graceMode(false);
  else if (k === "Escape") { endDrag(); state.sel = null; state.selEnd = null; refresh(); }
  else if (k === " ") togglePlay();
  else if (k === "?") $("help").showModal();
  else if (k === "ContextMenu" || (e.shiftKey && k === "F10")) ctxFromKeyboard();
  else if (k === "v" || k === "V") setTool(state.tool === "select" ? "entry" : "select");
  else handled = false;
  if (handled) e.preventDefault();
}

// Drum notes up or down a line or space, same drum (DESIGN §28).
function moveDrums(steps) {
  const s = state.sel, r = range().filter((p) => lb(s.staff)[p.bar][p.idx].pitches.length);
  if (!r.length) { message("Rests have no drum", true); return; }
  edit((sc) => { for (const p of r) { const e = M.moveDrumNote(sc, s.staff, p.bar, p.idx, steps); if (e) return e; } return null; });
}

function transposeSel(steps) {
  const s = state.sel;
  if (!s) { message("Select a note first", true); return; }
  const r = range().filter((p) => lb(s.staff)[p.bar][p.idx].pitches.length);
  if (!r.length) { message("Rests have no pitch", true); return; }
  if (!edit((sc) => { for (const p of r) M.transpose(sc, s.staff, p.bar, p.idx, steps); return null; })) return;
  if (r.length > 1) return;
  const ev = selEvent();
  if (ev && ev.pitches.length) { message(ev.pitches.map(M.pitchName).join(" ")); hear(ev); }
}

// ---------- playback ----------

function togglePlay() { isPlaying() ? stopPlay() : startPlay(); }

function startPlay() {
  const hl = $("play-hl"), sc = M.tracksOn(state.score);
  if (!sc) { message("Every track is off: turn one on in Tracks", true); return; }
  play(sc, state.caret.bar, (bar) => {
    if (bar === null) { hl.style.display = "none"; $("b-play").disabled = false; return; }
    place(hl, cellRect(state.hit.cells.filter((c) => c.bar === bar)));
    hl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, (text) => (text ? message(text, /couldn't/.test(text), text.endsWith("…")) : message(""))).catch((e) => { stopPlay(); message("Audio could not start: " + e.message, true); });
  $("b-play").disabled = true;
}

function stopPlay() {
  stop();
  if ($("status-msg").textContent === "Loading sounds…") message("");
  $("play-hl").style.display = "none";
  $("b-play").disabled = false;
}

// ---------- tracks (DESIGN §32) ----------
// Which parts play and export. Each change is an edit (saved with the score, undoable).

function openTracks() { fillTracks(); $("tracks").showModal(); }

function fillTracks() {
  $("track-rows").replaceChildren(...M.tracks(state.score).map((t) => {
    const row = document.createElement("div"), box = document.createElement("input"), lab = document.createElement("label"), only = document.createElement("button");
    row.className = "track";
    box.type = "checkbox"; box.checked = t.on; box.id = "trk-" + t.staves[0];
    box.onchange = () => setTracks((sc) => M.setTrackOn(sc, t.staves[0], box.checked));
    lab.htmlFor = box.id; lab.textContent = t.name + (t.staves.length > 1 ? " (2 staves)" : "");
    only.type = "button"; only.className = "btn"; only.textContent = "Only this";
    only.onclick = () => setTracks((sc) => { for (const u of M.tracks(sc)) M.setTrackOn(sc, u.staves[0], u.staves[0] === t.staves[0]); return null; });
    row.append(box, lab, only);
    return row;
  }));
}

function setTracks(fn) {
  edit(fn);
  fillTracks();
  if (isPlaying()) message("Track changes apply the next time you press Play");
}

function updateTracksButton() {
  const ts = M.tracks(state.score), on = ts.filter((t) => t.on).length, b = $("b-tracks");
  b.textContent = on === ts.length ? "Tracks: all" : `Tracks: ${on} of ${ts.length}`;
  b.classList.toggle("some", on < ts.length);
}

// The score an export uses: the tracks that are on. Throws when none are.
function exportScore() {
  const sc = M.tracksOn(state.score);
  if (!sc) throw new Error("every track is off: turn one on in Tracks");
  return sc;
}
// Said after an export that left parts out.
const leftOut = () => {
  const off = M.tracks(state.score).filter((t) => !t.on).map((t) => t.name);
  return off.length ? `Left out (track off): ${off.join(", ")}.` : "";
};

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
  if (isNew) $("f-sound").value = $("f-preset").value === "satb" ? 52 : 0;
  d.dataset.mode = isNew ? "new" : "edit";
  if (!M.parseTime($("f-time").value)) $("f-time").value = "4/4"; // hidden in Score details, where a bad value would block Apply
  d.returnValue = "";
  d.showModal();
  $("f-title").select();
}

function closeSetup() {
  const d = $("setup");
  if (d.returnValue !== "ok") return;
  const title = $("f-title").value.trim() || "Untitled";
  const composer = $("f-composer").value.trim();
  const tempo = M.clampBpm(+$("f-tempo").value);
  if (d.dataset.mode === "new") {
    const t = M.parseTime($("f-time").value);
    if (!t) { message(`"${$("f-time").value}" isn't a time signature (try 7/8, 5/4, C or C|)`, true); return; }
    const sc = M.newScore({
      title, composer, tempo, preset: $("f-preset").value, key: +$("f-key").value,
      ...t, bars: +$("f-bars").value || 16, program: +$("f-sound").value,
    });
    const pick = +$("f-pickup").value; // a pickup bar (DESIGN §33), as in a setup wizard
    if (pick > 0 && pick < t.time[0] && M.setBarLen(sc, 0, Math.round((pick * 1920) / t.time[1]))) message("That pickup isn't a length a bar can have, so bar 1 is full", true);
    replaceScore(sc, { save: false });
  } else {
    edit((sc) => { sc.title = title; sc.composer = composer; return M.setTempo(sc, 0, tempo); });
  }
}

// A <select> of the 128 General MIDI sounds, grouped by family (DESIGN §13.3).
function fillSounds(sel, value) {
  sel.textContent = "";
  for (const fam of FAMILIES) {
    const g = document.createElement("optgroup");
    g.label = fam;
    for (const it of GM.filter((x) => x.family === fam)) g.appendChild(new Option(it.name, it.program));
    sel.appendChild(g);
  }
  sel.value = value;
}

// ---------- instruments (DESIGN §13.3) ----------

// A part's sound menu value: the GM program number, or "u:<id>" for one of your sounds.
const soundValue = (st) => (st.sound ? "u:" + st.sound : String(st.program ?? 0));

// Your sounds as an extra group in each part's menu; `picks` keeps choices made before a refresh.
async function fillOwnSounds(picks = null) {
  const own = await usnd.listSounds();
  for (const sel of $("inst-rows").querySelectorAll("select.snd:not(:disabled)")) {
    const keep = picks?.get(sel) ?? sel.value;
    sel.querySelector("optgroup.own")?.remove();
    const g = document.createElement("optgroup");
    g.className = "own"; g.label = "Your sounds";
    for (const u of own) g.appendChild(new Option(u.name, "u:" + u.id));
    if (keep.startsWith("u:") && !own.some((u) => "u:" + u.id === keep)) g.appendChild(new Option("(sound no longer in this browser)", keep));
    if (g.children.length) sel.prepend(g);
    sel.value = keep;
  }
}

// Transposition presets (DESIGN §21): [chromatic, diatonic] from written to sounding.
const TRANSPOSITIONS = [
  ["0,0", "Concert pitch"], ["-2,-1", "B♭ (clarinet, trumpet, soprano sax)"], ["-3,-2", "A (clarinet)"],
  ["-7,-4", "F (horn, English horn)"], ["-9,-5", "E♭ (alto sax, alto clarinet)"], ["3,2", "E♭ (E♭ clarinet, sounds higher)"],
  ["-14,-8", "B♭ low (tenor sax, bass clarinet)"], ["-21,-12", "E♭ low (baritone sax)"],
  ["-12,-7", "Octave lower (guitar, bass)"], ["12,7", "Octave higher (piccolo, glockenspiel)"],
];
const trValue = (st) => (st.transpose ? st.transpose.join(",") : "0,0");

const KIND_LABEL = { treble: "Treble staff", bass: "Bass staff", alto: "Alto staff", tenor: "Tenor staff", grand: "Grand staff", percussion: "Drum staff" };

// One row of the parts list (DESIGN §20). The rows are the draft: Apply reads them in order.
function partRow({ from, kind, name, value, tr = "0,0" }) {
  const row = document.createElement("div"), nm = document.createElement("input"), sel = document.createElement("select");
  const trs = document.createElement("select");
  trs.className = "tr"; trs.setAttribute("aria-label", "Transposition"); trs.title = "Transposition: written notes keep sounding the same";
  for (const [v, label] of TRANSPOSITIONS) trs.appendChild(new Option(label, v));
  const other = (v) => new Option(`Other (${v.replace(",", " semitones, ")} steps)`, v);
  if (!TRANSPOSITIONS.some(([v]) => v === tr)) trs.appendChild(other(tr));
  trs.appendChild(new Option("Other…", "?"));
  trs.value = tr;
  trs.dataset.was = tr;
  // any interval a file can carry can be typed here too (DESIGN §21)
  trs.onchange = async () => {
    if (trs.value !== "?") { trs.dataset.was = trs.value; return; }
    const t = M.parseTranspose(await ask("Transposition", "Semitones, letter steps from written to sounding (B♭: -2, -1; F: -7, -4)", trs.dataset.was.replace(",", ", ")) ?? "");
    const v = t ? t.join(",") : trs.dataset.was;
    if (t && ![...trs.options].some((o) => o.value === v)) trs.insertBefore(other(v), trs.lastChild);
    trs.value = trs.dataset.was = v;
  };
  row.className = "part-row"; row.setAttribute("role", "listitem");
  row.dataset.from = from ?? ""; row.dataset.kind = kind;
  nm.className = "nm"; nm.maxLength = 60; nm.value = name; nm.placeholder = "Part name"; nm.setAttribute("aria-label", "Part name");
  sel.className = "snd"; sel.setAttribute("aria-label", "Sound");
  fillSounds(sel, 0);
  sel.dataset.want = value;
  if (kind === "percussion") { // the built-in kit (DESIGN §27): no instrument or transposition to choose
    sel.replaceChildren(new Option("Drum kit (built in)", "0")); sel.disabled = true; trs.disabled = true;
  }
  const btn = (text, label, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.textContent = text; b.title = label; b.setAttribute("aria-label", label);
    b.onclick = () => { fn(); updatePartButtons(); };
    return b;
  };
  const up = btn("↑", "Move up", () => row.previousElementSibling?.before(row));
  const down = btn("↓", "Move down", () => row.nextElementSibling?.after(row));
  const del = btn("✕", "Remove part", () => row.remove());
  const k = document.createElement("div");
  k.className = "kind";
  k.textContent = KIND_LABEL[kind] + (from === null ? " (new)" : "");
  row.append(nm, sel, up, down, del, trs, k);
  return row;
}
const updatePartButtons = () => {
  const rows = [...$("inst-rows").children];
  rows.forEach((r, i) => {
    const [up, down, del] = r.querySelectorAll("button");
    up.disabled = i === 0; down.disabled = i === rows.length - 1; del.disabled = rows.length === 1;
  });
};
const kindOf = (sc, g) => (g.length > 1 ? "grand" : sc.staves[g[0]].clef);

function openInstruments() {
  const sc = state.score, box = $("inst-rows");
  box.replaceChildren(...M.partGroups(sc).map((g) => partRow({
    from: g[0], kind: kindOf(sc, g), name: sc.staves[g[0]].name || "", value: soundValue(sc.staves[g[0]]), tr: trValue(sc.staves[g[0]]) })));
  const want = new Map([...box.querySelectorAll("select.snd")].map((x) => [x, x.dataset.want]));
  updatePartButtons();
  $("instruments").returnValue = "";
  $("instruments").showModal();
  fillOwnSounds(want);
}

function addPartRow() {
  const kind = $("inst-kind").value, row = partRow({ from: null, kind, name: "", value: "0" });
  $("inst-rows").appendChild(row);
  fillOwnSounds(new Map([[row.querySelector("select.snd"), "0"]]));
  updatePartButtons();
  row.querySelector("input").focus();
}

function closeInstruments() {
  if ($("instruments").returnValue !== "ok") return;
  const sc = state.score, groups = M.partGroups(sc);
  const rows = [...$("inst-rows").children].map((r) => ({
    from: r.dataset.from === "" ? null : +r.dataset.from, kind: r.dataset.kind,
    name: r.querySelector("input.nm").value, value: r.querySelector("select.snd").value, tr: r.querySelector("select.tr").value }));
  const same = rows.length === groups.length && rows.every((r, i) => r.from === groups[i][0] &&
    r.name.trim() === (sc.staves[r.from].name || "") && r.value === soundValue(sc.staves[r.from]) && r.tr === trValue(sc.staves[r.from]));
  if (same) return;
  // removed parts that hold notes (any layer): ask first, as Delete bar does
  const kept = new Set(rows.map((r) => r.from));
  const lost = groups.filter((g) => !kept.has(g[0]) && g.some((s) => M.allLayers(sc.staves[s]).some((bars) => bars.some((b) => b.length))));
  if (lost.length && !confirm(`Remove ${lost.length === 1 ? `"${sc.staves[lost[0][0]].name || "a part"}"` : `${lost.length} parts`} and the notes in ${lost.length === 1 ? "it" : "them"}? (Undo brings ${lost.length === 1 ? "it" : "them"} back.)`)) return;
  state.sel = null; state.selEnd = null; // the selection's staff index may not survive
  const ok = edit((score) => {
    const e = M.arrangeParts(score, rows.map((r) => ({ from: r.from, kind: r.kind, name: r.name })));
    if (e) return e;
    // sounds, by position in the new order
    let s = 0;
    for (const r of rows) {
      if (r.kind === "percussion") { s++; continue; }
      const err = r.value.startsWith("u:") ? M.setStaffSound(score, s, r.value.slice(2))
        : M.setStaffSound(score, s, null) || M.setStaffProgram(score, s, +r.value);
      if (err) return err;
      // keeps the sound: the written notes move (DESIGN §21)
      if (r.tr !== trValue(score.staves[s])) { const e2 = M.setStaffTranspose(score, s, r.tr.split(",").map(Number)); if (e2) return e2; }
      s += r.kind === "grand" ? 2 : 1;
    }
    return null;
  });
  if (ok) prefetch(state.score);
}

// ---------- your own sounds (DESIGN §18) ----------

function fillNoteSelect(sel, value) {
  sel.textContent = "";
  for (let m = 21; m <= 108; m++) sel.appendChild(new Option(noteName(m) + (m === 60 ? " (middle C)" : ""), m));
  sel.value = value;
}

async function listOwnSounds() {
  const list = $("us-list");
  const own = await usnd.listSounds();
  list.replaceChildren(...own.map((u) => {
    const li = document.createElement("li"), name = document.createElement("span"), del = document.createElement("button");
    name.textContent = `${u.name} — recorded at ${noteName(u.root)}, plays ${noteName(u.low)}–${noteName(u.high)}`;
    del.type = "button"; del.className = "btn"; del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete "${u.name}" from this browser? Parts using it will play their instrument instead.`)) return;
      await usnd.removeSound(u.id);
      forgetUserSound(u.id);
      listOwnSounds();
    };
    li.append(name, del);
    return li;
  }));
  if (!own.length) { const li = document.createElement("li"); li.textContent = "No sounds yet."; list.appendChild(li); }
}

function openOwnSounds() {
  fillNoteSelect($("us-root"), 60); fillNoteSelect($("us-low"), 36); fillNoteSelect($("us-high"), 84);
  $("us-file").value = ""; $("us-name").value = "";
  const msg = $("us-msg");
  msg.dataset.text ||= msg.textContent;
  msg.textContent = msg.dataset.text;
  listOwnSounds();
  $("usounds").showModal();
}

async function addOwnSound() {
  const say = (t) => { $("us-msg").textContent = t; };
  const file = $("us-file").files[0];
  if (!file) { say("Choose an audio file first."); return; }
  if (file.size > usnd.MAX_BYTES) { say(`That file is too big (the limit is ${usnd.MAX_BYTES / 1048576} MB).`); return; }
  const bytes = await file.arrayBuffer();
  try { await usnd.checkAudio(bytes); } catch { say("This browser can't play that file. Try WAV, MP3 or OGG."); return; }
  const name = $("us-name").value.trim() || file.name.replace(/\.[^.]+$/, "") || "Sound";
  try {
    await usnd.addSound(bytes, file.type, { name, root: +$("us-root").value, low: +$("us-low").value, high: +$("us-high").value });
  } catch { say("Couldn't store the sound (browser storage may be full or blocked)."); return; }
  say(`Added "${name}". Pick it for a part in the Instruments list.`);
  $("us-file").value = ""; $("us-name").value = "";
  listOwnSounds();
}

// ---------- drum sound (DESIGN §27) ----------

function openDrum() {
  const s = state.sel;
  if (!s || !M.isPerc(state.score.staves[s.staff])) { message("Select notes in a drum part first", true); return; }
  const pick = $("drum-pick");
  if (!pick.options.length) for (const d of DRUMS.values()) pick.appendChild(new Option(`${d.name} (${d.n})`, d.n));
  const top = selEvent()?.pitches.slice(-1)[0];
  if (top) pick.value = top.drum;
  $("drum").returnValue = "";
  $("drum").showModal();
}

function closeDrum() {
  if ($("drum").returnValue !== "ok" || !state.sel) return;
  const s = state.sel, n = +$("drum-pick").value, r = range().filter((p) => lb(s.staff)[p.bar][p.idx].pitches.length);
  if (!r.length) { message("Rests have no drum", true); return; }
  if (edit((sc) => { for (const p of r) { const e = M.setDrum(sc, s.staff, p.bar, p.idx, n); if (e) return e; } return null; })) hear(selEvent());
}

// ---------- tuplets (DESIGN §14.4) ----------

function openTuplet() {
  const has = !!state.sel;
  $("t-ratio").value = state.lastTup.join(":");
  $("tuplet-ok").textContent = has ? "Apply to selection" : "Use for next notes";
  $("tuplet").returnValue = "";
  $("tuplet").showModal();
}

function closeTuplet() {
  if ($("tuplet").returnValue !== "ok") return;
  const tup = M.parseTuplet($("t-ratio").value);
  if (!tup) { message(`"${$("t-ratio").value}" isn't a group: type it as 5:3 (5 notes in the space of 3)`, true); return; }
  state.lastTup = tup;
  if (state.sel) { tupletSel(tup); return; }
  state.armed.tup = tup;
  updatePalette(); updateStatus();
  if (!M.tupletOk(state.armed.dur, state.armed.dots, tup)) message(`A ${tup[0]}:${tup[1]} tuplet doesn't fit that note value`, true);
}

// Set (or with null, remove) a tuplet ratio on every selected event, all or nothing.
function tupletSel(tup) {
  const s = state.sel;
  if (!s) { message("Select notes first", true); return; }
  const r = range();
  edit((sc) => {
    for (const p of r) { const e = M.setTuplet(sc, s.staff, p.bar, p.idx, tup); if (e) return e; }
    // a group cut short mid-bar can't be written to a file correctly (DESIGN §14.4)
    for (const b of new Set(r.map((p) => p.bar))) {
      const bar = sc.staves[s.staff].bars[b];
      if (M.tupletRuns(bar).some((run) => run.ticks % run.unit && run.idx[run.idx.length - 1] !== bar.length - 1))
        return tup ? `Select a whole group: ${tup[0]} notes of the same value, or the same total length` : "That would leave part of a tuplet group";
    }
    return null;
  });
}

// ---------- key / time change at a bar (DESIGN §11.3) ----------

function openAttrs() {
  const b = state.caret.bar, sc = state.score;
  const at = M.attrsAt(sc, b);
  const m = sc.measures[b];
  $("attrs-head").textContent = `Key and time from bar ${b + 1}`;
  $("a-key").value = at.key;
  $("a-key").previousElementSibling.textContent = sc.staves.some((st) => st.transpose) ? "Key (concert)" : "Key";
  $("a-time").value = M.timeLabel(at);
  $("attrs-remove").hidden = b === 0 || (m.key === undefined && !m.time);
  $("attrs").returnValue = "";
  $("attrs").showModal();
}

function closeAttrs() {
  const how = $("attrs").returnValue, b = state.caret.bar;
  if (how === "remove") edit((sc) => M.clearAttrs(sc, b));
  else if (how === "ok") {
    const t = M.parseTime($("a-time").value);
    if (!t) { message(`"${$("a-time").value}" isn't a time signature (try 7/8, 5/4, C or C|)`, true); return; }
    const changed = M.timeLabel(t) !== M.timeLabel(M.attrsAt(state.score, b));
    // only pass time when it changes, so a key change never trips the bar-fit check
    edit((sc) => M.setAttrs(sc, b, changed ? { key: +$("a-key").value, ...t } : { key: +$("a-key").value }));
  }
}

// A one-line question in a dialog (window.prompt is blocked in some embedded browsers).
// Resolves to the text, or null when cancelled.
function ask(head, label, value) {
  const d = $("ask");
  if (d.open) return Promise.resolve(null); // one question at a time
  $("ask-head").textContent = head; $("ask-label").textContent = label; $("ask-in").value = value;
  d.returnValue = "";
  d.showModal();
  $("ask-in").select();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok" ? $("ask-in").value : null), { once: true }));
}

// ---------- repeats and navigation (DESIGN §28) ----------
// Marks go on the caret bar, like the rest of the Score menu; an ending covers the selected range
// of bars (or the caret bar).

const repBar = () => state.caret.bar;
function barMark(k, val) {
  const b = repBar(), m = state.score.measures[b], on = val === true ? !m[k] : m[k] !== val;
  if (edit((sc) => M.setBarMark(sc, b, k, on && val))) message(`${on ? "" : "Removed: "}${k === "jump" ? M.JUMPS[val] : document.getElementById("r-" + k).textContent} at bar ${b + 1}`);
}
// text above a note and rehearsal marks (DESIGN §30): empty removes
async function noteText() {
  const s = state.sel, ev = selEvent();
  if (!ev) { message("Select a note or rest first", true); return; }
  const v = await ask(`Text above bar ${s.bar + 1}`, "Text, such as dolce or pizz. (empty to remove)", ev.text || "");
  if (v === null) return;
  edit((sc) => M.setText(sc.staves[s.staff].bars[s.bar][s.idx], v)); // inside edit, bars is the current layer
}
async function rehearsal() {
  const b = repBar(), sc = state.score;
  const v = await ask(`Rehearsal mark at bar ${b + 1}`, `Up to ${M.MAX_REHEARSAL} letters or digits (empty to remove)`, sc.measures[b].rehearsal || M.nextRehearsal(sc, b));
  if (v === null) return;
  edit((x) => M.setRehearsal(x, b, v));
}
// tempo changes (DESIGN §29): empty, or the tempo before, removes the change
async function tempoFrom() {
  const b = repBar(), sc = state.score;
  const v = await ask(`Tempo from bar ${b + 1}`, "Quarter notes a minute (20–400)" + (b ? "; empty for no change" : ""), M.tempoAt(sc, b));
  if (v === null) return;
  const bpm = v.trim() === "" && b ? M.tempoAt(sc, b - 1) : +v;
  if (!M.okBpm(bpm)) { message("A tempo is a whole number from 20 to 400", true); return; }
  if (edit((s) => M.setTempo(s, b, bpm))) message(`Tempo ${bpm} from bar ${b + 1}`);
}
// short bars (DESIGN §33): a pickup, or the bar that completes it at the end
async function barLength() {
  const b = repBar(), sc = state.score, { time } = M.attrsAt(sc, b), beat = 1920 / time[1];
  const v = await ask(`Length of bar ${b + 1}`, `Beats, counting in the time signature's ${time[0]}/${time[1]} (empty for a full bar)`, M.barLen(sc, b) / beat);
  if (v === null) return;
  const n = v.trim() === "" ? time[0] : +v;
  if (!(n > 0) || n > time[0]) { message(`A bar holds from a part of a beat up to ${time[0]} beats`, true); return; }
  if (edit((s) => M.setBarLen(s, b, Math.round(n * beat)))) message(n < time[0] ? `Bar ${b + 1} is ${n} beat${n === 1 ? "" : "s"} long` : `Bar ${b + 1} is a full bar`);
}
async function repeatTimes() {
  const b = repBar(), v = await ask(`End repeat at bar ${b + 1}`, `Times the section plays (2–${M.MAX_REPEAT})`, state.score.measures[b].repEnd || 3);
  if (v === null) return;
  if (!(+v >= 2 && +v <= M.MAX_REPEAT && Number.isInteger(+v))) { message(`Play a section 2 to ${M.MAX_REPEAT} times`, true); return; }
  edit((sc) => M.setBarMark(sc, b, "repEnd", +v));
}
async function ending(nums) {
  const a = state.sel && state.selEnd ? state.sel.bar : repBar(), z = state.sel && state.selEnd ? state.selEnd.bar : a;
  if (nums === "?") {
    const v = await ask("Ending", "Numbers, such as 1, 2 or 1-3", state.score.measures[a].volta?.join(", ") || "1, 2");
    if (v === null) return;
    nums = M.parseVolta(v);
    if (!nums) { message(`Type ending numbers from 1 to ${M.MAX_REPEAT}, such as 1, 2`, true); return; }
  }
  if (edit((sc) => M.setVolta(sc, a, z, nums))) message(nums ? `Ending ${M.voltaLabel(nums)} over bar${a === z ? ` ${a + 1}` : `s ${Math.min(a, z) + 1}–${Math.max(a, z) + 1}`}` : "Ending removed");
}

// ---------- commands (DESIGN §14.1) ----------
// One table for the menu bar, the context menu and modifier shortcuts, keyed by menu item id.

const hasSel = () => !!state.sel;
const CMD = {
  "b-new": { run: () => openSetup(true) },
  "b-open": { run: () => $("file").click() },
  "b-lib": { run: () => openLibrary() },
  "b-save": { run: () => saveFile() },
  "x-pdf": { run: () => { if (leftOut()) message("Print and PDF show every part; tracks that are off only leave playback and exports."); window.print(); } },
  "b-print": { run: () => window.print() },
  "m-tracks": { run: () => openTracks() },
  ...Object.fromEntries(["x-musicxml", "x-mxl", "x-mscz", "x-midi", "x-wav", "x-mp3", "x-audio"].map((id) => [id, { run: () => exportAs(id), on: () => !exporting && (id !== "x-audio" || !!recordType()) }])),
  "b-undo": { run: () => undo(), on: () => state.undo.length > 0 },
  "b-redo": { run: () => redo(), on: () => state.redo.length > 0 },
  "m-cut": { run: () => copySel(true), on: hasSel },
  "m-copy": { run: () => copySel(false), on: hasSel },
  "m-paste": { run: () => paste(), on: () => !!state.clip },
  "m-delete": { run: () => deleteSel(), on: hasSel },
  "m-zoomin": { run: () => setZoom(zoom * 1.2) },
  "m-zoomout": { run: () => setZoom(zoom / 1.2) },
  "m-zoom1": { run: () => setZoom(1) },
  "n-selall": { run: () => selectAll() },
  "n-up": { run: () => transposeSel(1), on: hasSel },
  "n-down": { run: () => transposeSel(-1), on: hasSel },
  "n-octup": { run: () => transposeSel(7), on: hasSel },
  "n-octdown": { run: () => transposeSel(-7), on: hasSel },
  "n-tie": { run: () => tie(), on: hasSel },
  "n-gliss": { run: () => glide(), on: hasSel },
  "n-dsharp": { run: () => accidental(2) },
  "n-dflat": { run: () => accidental(-2) },
  ...Object.fromEntries(M.MARKS.map((m) => ["n-" + m, { run: () => mark(m), on: hasSel }])),
  ...Object.fromEntries(M.DYNS.map((d) => ["d-" + d, { run: () => dynamic(d), on: hasSel }])),
  "d-none": { run: () => dynamic(null), on: hasSel },
  "n-slur": { run: () => span("slur", true), on: hasSel },
  "n-lyrics": { run: () => openLyrics(), on: hasSel },
  "n-grace": { run: () => graceMode(!state.armed.grace) },
  "n-nograce": { run: () => clearGrace(), on: hasSel },
  "n-cresc": { run: () => span("hp", "<"), on: hasSel },
  "n-dim": { run: () => span("hp", ">"), on: hasSel },
  "n-layer1": { run: () => setLayer(0) },
  "n-layer2": { run: () => setLayer(1) },
  "n-layer3": { run: () => setLayer(2) },
  "n-layer4": { run: () => setLayer(3) },
  "n-tuplet": { run: () => openTuplet() },
  "n-drum": { run: () => openDrum(), on: () => hasSel() && M.isPerc(state.score.staves[state.sel.staff]) },
  ...Object.fromEntries([["n-drumup", 1], ["n-drumdown", -1]].map(([id, d]) => [id, { run: () => moveDrums(d), on: () => hasSel() && M.isPerc(state.score.staves[state.sel.staff]) }])),
  "n-untup": { run: () => tupletSel(null), on: () => range().some((p) => lb(state.sel.staff)[p.bar][p.idx].tup) },
  ...Object.fromEntries(M.CLEFS.map((c) => ["c-" + c, { run: () => edit((sc) => M.setClef(sc, state.caret.staff, state.caret.bar, c)) }])),
  "b-addbar": { run: () => edit((sc) => { M.addMeasure(sc, state.caret.bar); state.caret.bar++; return null; }) },
  "b-delbar": { run: () => {
    const b = state.caret.bar;
    const has = state.score.staves.some((s) => M.allLayers(s).some((bars) => bars[b].length));
    if (has && !confirm(`Delete bar ${b + 1} and its notes?`)) return;
    edit((sc) => M.deleteMeasure(sc, b));
  }, on: () => state.score.measures.length > 1 },
  "b-attrs": { run: () => openAttrs() },
  ...Object.fromEntries(M.BAR_FLAGS.map((k) => ["r-" + k, { run: () => barMark(k, true) }])),
  "r-repEnd": { run: () => barMark("repEnd", 2) },
  "r-times": { run: () => repeatTimes() },
  "b-tempo": { run: () => tempoFrom() },
  "b-len": { run: () => barLength() },
  "b-rehearsal": { run: () => rehearsal() },
  "n-text": { run: () => noteText(), on: hasSel },
  ...Object.fromEntries(Object.keys(M.JUMPS).map((j) => ["r-" + j, { run: () => barMark("jump", j) }])),
  "r-volta1": { run: () => ending([1]) },
  "r-volta2": { run: () => ending([2]) },
  "r-volta": { run: () => ending("?") },
  "r-novolta": { run: () => ending(null), on: () => !!state.score.measures[repBar()].volta },
  "m-details": { run: () => openSetup(false) },
  "m-instruments": { run: () => openInstruments() },
  "b-help": { run: () => $("help").showModal() },
  "m-about": { run: () => $("about").showModal() },
};

// "mod+Shift+Z" style names, from each menu item's data-short.
const SHORTS = {};
function setupCommands() {
  for (const [id, c] of Object.entries(CMD)) $(id).onclick = () => c.run();
  for (const b of document.querySelectorAll('#menubar [data-short^="mod+"]')) SHORTS[b.dataset.short.toUpperCase()] = b.id;
}

// Run the command bound to a modifier shortcut. True when one ran.
function runShortcut(e) {
  const id = SHORTS[("mod+" + (e.shiftKey ? "Shift+" : "") + e.key).toUpperCase()];
  const c = id && CMD[id];
  if (!c || (c.on && !c.on())) return false;
  e.preventDefault();
  c.run();
  return true;
}

function enableItems(list) {
  for (const b of list.querySelectorAll("button")) {
    const c = CMD[b.dataset.cmd || b.id];
    b.disabled = !!(c && c.on && !c.on());
  }
}


function selectAll() {
  const s = state.sel ? state.sel.staff : state.caret.staff, sc = state.score;
  const v = state.layer, n = sc.measures.length;
  const first = M.nextEventPos(sc, s, 0, -1, v), last = M.prevEventPos(sc, s, n - 1, lb(s)[n - 1].length, v);
  if (!first) { message("This staff is empty", true); return; }
  state.sel = { staff: s, ...first };
  state.selEnd = last && (last.bar !== first.bar || last.idx !== first.idx) ? last : null;
  refresh();
}

// ---------- context menu (DESIGN §14.3) ----------

const CTX_NOTE = ["m-cut", "m-copy", "m-paste", "m-delete", "-", "n-up", "n-down", "n-tie", "n-tuplet", "n-untup", "n-drum", "-", "n-fermata", "n-staccato", "n-accent", "-", "b-attrs", "m-instruments"];
const CTX_STAFF = ["m-paste", "-", "b-addbar", "b-delbar", "-", "b-attrs", "m-instruments"];

function openCtx(x, y, ids) {
  closeMenus();
  const box = $("ctx");
  box.replaceChildren();
  for (const id of ids) {
    if (id === "-") { box.appendChild(document.createElement("hr")); continue; }
    const b = $(id).cloneNode(true); // same label and shortcut as the menu bar
    b.removeAttribute("id");
    b.dataset.cmd = id;
    b.onclick = () => { box.hidden = true; CMD[id].run(); };
    box.appendChild(b);
  }
  enableItems(box);
  box.hidden = false;
  box.style.left = Math.max(4, Math.min(x, innerWidth - box.offsetWidth - 4)) + "px";
  box.style.top = Math.max(4, Math.min(y, innerHeight - box.offsetHeight - 4)) + "px";
  box.querySelector("button:not(:disabled)")?.focus();
}

function onContext(e) {
  const L = locate(e);
  if (!L) return; // off the staves: the browser's own menu
  e.preventDefault();
  state.caret = { staff: L.staff, bar: L.bar };
  const idx = L.near ? L.near.idx : null;
  if (idx !== null && !(state.sel && state.sel.staff === L.staff && range().some((p) => p.bar === L.bar && p.idx === idx))) {
    state.sel = { staff: L.staff, bar: L.bar, idx };
    state.selEnd = null;
  }
  refresh();
  openCtx(e.clientX, e.clientY, idx !== null ? CTX_NOTE : CTX_STAFF);
}

// Shift+F10 or the Menu key: open it at the caret bar.
function ctxFromKeyboard() {
  const r = $("caret-hl").getBoundingClientRect();
  openCtx(r.left + 8, r.bottom, state.sel ? CTX_NOTE : CTX_STAFF);
}

function setupCtx() {
  const box = $("ctx");
  box.onkeydown = (e) => {
    const items = [...box.querySelectorAll("button:not(:disabled)")], at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); box.hidden = true; }
  };
  $("systems").addEventListener("contextmenu", onContext);
  addEventListener("scroll", () => (box.hidden = true), true);
  addEventListener("resize", () => (box.hidden = true));
}

// ---------- menu bar (DESIGN §13.1) ----------

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// top-level lists only: a submenu is shown by CSS, never by the hidden attribute
const openMenu = () => document.querySelector("#menubar .menu > .mlist:not([hidden]), #ctx:not([hidden])");

function closeMenus(focusButton = false) {
  const list = openMenu();
  if (!list) return;
  if (list.id === "ctx") { list.hidden = true; return; }
  list.hidden = true;
  const mb = list.previousElementSibling;
  mb.setAttribute("aria-expanded", "false");
  if (focusButton) mb.focus();
}

function showMenu(mb, focusFirst) {
  closeMenus();
  const list = mb.nextElementSibling;
  enableItems(list);
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
      // arrows move within the submenu while focus is in it, else among the top-level items
      const sub = document.activeElement?.closest(".sub");
      const inSub = document.activeElement?.closest(".submenu");
      const items = [...(inSub || list).querySelectorAll("button:not(:disabled):not([hidden])")].filter((b) => inSub || !b.closest(".submenu"));
      const at = items.indexOf(document.activeElement);
      if (e.key === "ArrowRight" && document.activeElement?.matches("[aria-haspopup]")) {
        e.preventDefault(); sub.querySelector(".submenu button:not(:disabled):not([hidden])")?.focus(); return;
      }
      if (e.key === "ArrowLeft" && sub && document.activeElement.closest(".submenu")) {
        e.preventDefault(); sub.querySelector("[aria-haspopup]").focus(); return;
      }
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
      if (!e.target.closest("button") || e.target.closest("[aria-haspopup]")) return;
      closeMenus();
      if (document.activeElement?.closest?.("#menubar")) document.activeElement.blur();
    });
  });
  // capture pointerdown: the Selection tool cancels pointerdown, which would swallow mousedown
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#menubar, #ctx")) closeMenus(); }, true);
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

const fileBase = () => (state.score.title || "score").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100);

// ---------- export (DESIGN §19) ----------
// id -> how to make the file. `note` is said after saving, for formats that leave things out.
const EXPORTS = {
  "x-musicxml": { ext: "musicxml", mime: "application/vnd.recordare.musicxml+xml", make: async () => (await import("./io/musicxml.js")).exportMusicXML(exportScore()) },
  "x-mxl": { ext: "mxl", mime: "application/vnd.recordare.musicxml", make: async () => (await import("./io/musicxml.js")).exportMXL(exportScore()) },
  "x-mscz": { ext: "mscz", mime: "application/zip", make: async () => (await import("./io/mscz.js")).exportMSCZ(exportScore()) },
  "x-midi": { ext: "mid", mime: "audio/midi", make: async () => (await import("./io/midi.js")).exportMIDI(exportScore()),
    note: "MIDI keeps notes, tempo, key, time and instruments; note spellings, marks and layers are not kept." },
  "x-wav": { ext: "wav", mime: "audio/wav", audio: true, make: async () => wavBytes((await audioBuffer()).buffer) },
  "x-mp3": { ext: "mp3", mime: "audio/mpeg", audio: true, make: async () => (await import("./mp3.js"))
    .mp3Blob((await audioBuffer()).buffer, (f) => message(`Encoding MP3… ${Math.round(f * 100)}%`, false, true)) },
  "x-audio": { audio: true, make: async () => {
    const { buffer } = await audioBuffer();
    return recordCompressed(buffer, (f) => message(`Recording audio… ${Math.round(f * 100)}% (it takes as long as the piece; Stop cancels)`, false, true));
  } },
};
let exporting = false, audioNote = "";
async function audioBuffer() {
  const r = await renderAudio(exportScore(), (t) => message(t || "Rendering audio…", false, true));
  audioNote = r.status;
  return r;
}

async function exportAs(id) {
  const x = EXPORTS[id];
  if (exporting) return;
  exporting = true; audioNote = "";
  if (x.audio) stopPlay();
  try {
    const data = await x.make();
    const ext = x.ext || { "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a" }[data.type] || "audio";
    const name = `${fileBase()}.${ext}`;
    download(data instanceof Blob ? data : new Blob([data], { type: x.mime }), name);
    message([`Exported ${name}.`, leftOut(), x.note, audioNote].filter(Boolean).join(" "));
  } catch (e) {
    if (e.message === "Stopped") message("Export stopped");
    else { console.error(e); message("Export failed: " + (e.message || e), true); }
  } finally { exporting = false; }
}

async function saveFile() {
  try {
    const { exportMusicXML } = await import("./io/musicxml.js");
    const xml = exportMusicXML(state.score);
    const name = fileBase() + ".musicxml";
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
    prefetch(score);
    showReport(file.name, report);
  } catch (e) {
    console.error(e);
    // a module that won't load is almost always old and new files mixed in the cache just after an update
    const stale = /dynamically imported module|Importing a module script failed|does not provide an export named/i.test(e.message);
    showReport(file.name, { error: stale ? "Part of Coda didn't load, probably because it was just updated. Reload the page and try again." : e.message || String(e) });
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
  $("attrs").addEventListener("close", closeAttrs);
  $("attrs-cancel").onclick = () => $("attrs").close("cancel");
  $("attrs-remove").onclick = () => $("attrs").close("remove");
  $("title").onclick = $("composer").onclick = () => openSetup(false);
  $("setup").addEventListener("close", closeSetup);
  $("setup-cancel").onclick = () => $("setup").close("cancel");
  $("file").onchange = (e) => { openFile(e.target.files[0]); e.target.value = ""; };
  $("b-play").onclick = startPlay;
  $("b-stop").onclick = stopPlay;
  $("instruments").addEventListener("close", closeInstruments);
  $("inst-cancel").onclick = () => $("instruments").close("cancel");
  $("inst-own").onclick = () => openOwnSounds();
  $("inst-add").onclick = () => addPartRow();
  $("us-add").onclick = () => addOwnSound();
  $("usounds").addEventListener("close", () => fillOwnSounds());
  fillSounds($("f-sound"), 0);
  $("f-preset").onchange = (e) => { $("f-sound").value = e.target.value === "satb" ? 52 : 0; $("f-sound").disabled = e.target.value === "drums"; };
  setupCommands();
  document.querySelectorAll("#layers button").forEach((b, i) => (b.onclick = () => setLayer(i)));
  setupCtx();
  $("tuplet").addEventListener("close", closeTuplet);
  $("tuplet-cancel").onclick = () => $("tuplet").close("cancel");
  $("drum").addEventListener("close", closeDrum);
  $("b-tracks").onclick = openTracks;
  $("tracks-all").onclick = () => setTracks((sc) => { for (const t of M.tracks(sc)) M.setTrackOn(sc, t.staves[0], true); return null; });
  $("drum-cancel").onclick = () => $("drum").close("cancel");
  $("ask-cancel").onclick = () => $("ask").close("cancel");
  setupMenus();
  { // compressed audio: whatever this browser can record, or no item at all
    const t = recordType();
    $("x-audio").hidden = !t;
    if (t) $("x-audio").textContent = `Audio, compressed (.${{ "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a" }[t.split(";")[0]]})`;
  }
  $("report-close").onclick = () => ($("report").style.display = "none");
  $("tempo").onchange = (e) => {
    const v = M.clampBpm(+e.target.value);
    edit((sc) => M.setTempo(sc, 0, v));
  };
  const systems = $("systems");
  systems.addEventListener("click", onClick);
  systems.addEventListener("mousemove", onMove);
  systems.addEventListener("mouseleave", () => ($("ghost").style.display = "none"));
  $("sheet").addEventListener("pointerdown", onDown); // the whole page, so a box can start in the margin
  $("sheet").addEventListener("click", (e) => { if (dragged) { dragged = false; e.stopPropagation(); e.preventDefault(); } }, true);
  document.addEventListener("pointermove", onDrag);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", onKey);
  $("lyric-box").addEventListener("keydown", onLyricKey);
  $("lyric-box").addEventListener("blur", () => { if (!$("lyric-box").hidden) { commitLyric(hyphOf()); closeLyrics(); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawCaret, 100); });
  refresh();
  window.coda = { state, edit, M, locate }; // debugging aid
}

init();
