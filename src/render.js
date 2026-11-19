// Coda renderer: score model -> SVG systems via VexFlow. See docs/DESIGN.md §5.
import { attrsAt, barLen, barCapacity, barNumber, partGroups, keyAt, nextEventPos, tupletRuns, allLayers, timeLabel, SPAN_KINDS, ONE_NOTE, melismas, OTT_SHIFT, clefAt, isPerc, sameVolta, voltaLabel, BOTTOM_LINE, diatonic, RAMPS } from "./model.js";
import { DRUMS } from "./drums.js";

const VF = () => Vex.Flow;

export const SHEET_W = 1020;
const STAFF_GAP = 95;
const SYS_TOP = 10;      // VexFlow already leaves 40 units above the top line
const SYS_BOTTOM = 50;
const LEFT_PAD = 20;
const RIGHT_PAD = 4;     // keeps the closing barline inside the drawing, which print clips to
const KEY_NAMES = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const BRASS = new Set(["scoop", "fall", "doit"]); // VexFlow jazz ornaments of the same names
const MARK_VF = { fermata: "a@", staccato: "a.", accent: "a>", tenuto: "a-", marcato: "a^" };
// DESIGN §34. VexFlow's "mordent" has no stroke, so it draws Coda's invMordent, and the other way round.
const ORN_VF = { trill: "tr", mordent: "mordent_inverted", invMordent: "mordent", turn: "turn" };
const AFTER_VF = { breath: "breathMarkComma", caesura: "caesura" }; // SMuFL glyphs, drawn after the note
const REST_KEY = { treble: "b/4", bass: "d/3", alto: "c/4", tenor: "a/3", percussion: "b/4" };
// rests above / below the middle when two layers share a bar
const REST_KEY_LAYER = { treble: ["e/5", "f/4"], bass: ["g/3", "a/2"], alto: ["f/4", "g/3"], tenor: ["d/4", "e/3"], percussion: ["e/5", "f/4"] };
// drum noteheads (DESIGN §27) as VexFlow key suffixes
const HEAD = { x: "/X", cx: "/CX", d: "/D", t: "/TU" };
const keyOf = (p) => "cdefgab"[p.step] + (p.drum ? "" : ACC[p.alter]) + "/" + p.oct + (p.drum ? HEAD[DRUMS.get(p.drum)?.head] || "" : "");
const ACC = { "-2": "bb", "-1": "b", 0: "n", 1: "#", 2: "##" };
const ACCENT = "#2563eb";
const DIM = "#9aa0a6"; // layers other than the one being edited (screen only)
// Draw with the grey of an inactive layer: beams, tuplets and ties don't take a note's style.
function tinted(ctx, on, draw) {
  if (!on) { draw(); return; }
  ctx.save(); ctx.setFillStyle(DIM); ctx.setStrokeStyle(DIM);
  try { draw(); } finally { ctx.restore(); }
}

export function keyName(k) { return KEY_NAMES[k + 7]; }

function minWidth(score, b) {
  // 30 per note, more under a long lyric (DESIGN §24)
  const longest = (e) => Math.max(0, ...(e.lyrics || []).map((l) => l?.text.length || 0));
  const need = (bar) => bar.reduce((w, e) => w + Math.max(30, longest(e) * 8.5 + 12) + (e.grace ? 6 + 10 * e.grace.length : 0), 0);
  return Math.max(barLen(score, b) < barCapacity(attrsAt(score, b).time) ? 80 : 150, 50 + Math.max(30, ...score.staves.flatMap((s) => allLayers(s).map((bars) => need(bars[b])))));
}

// Top of each staff in a system: a staff with lyrics leaves a line for them below it.
const LYRIC_ROOM = 30;
export const LYRIC_LINE = 20;
const verses = (st) => Math.max(0, ...allLayers(st).flatMap((bars) => bars.flatMap((bar) => bar.map((e) => e.lyrics?.length || 0))));
function staffTops(score) {
  const y = [SYS_TOP];
  for (let s = 1; s < score.staves.length; s++) y.push(y[s - 1] + STAFF_GAP + (verses(score.staves[s - 1]) ? LYRIC_ROOM + LYRIC_LINE * (verses(score.staves[s - 1]) - 1) : 0));
  return y;
}

function prefixW(key) { return 55 + 13 * Math.abs(key) + 35; }
// The most accidentals any staff's key shows at bar b (staves can differ: DESIGN §21).
const widestKey = (score, b) => Math.max(...score.staves.map((_, s) => Math.abs(keyAt(score, s, b))));

// Extra width for a mid-system key/time change.
function changeW(score, b) {
  const m = score.measures[b];
  let w = 0;
  if (b > 0 && m.key !== undefined) w += 13 * Math.max(widestKey(score, b), widestKey(score, b - 1)) + 10;
  if (b > 0 && m.time) w += 35;
  return w;
}

// Part names before the first system (DESIGN §36): its indent, 0 when there are no names to show
// (a lone part with the default name shows none).
const partNames = (score) => {
  const gs = partGroups(score).map((g) => ({ g, name: (score.staves[g[0]].name || "").trim() }));
  return gs.length === 1 && gs[0].name === "Staff" ? [] : gs.filter((x) => x.name);
};
const x0Names = (score) => LEFT_PAD + nameIndent(score) - 20; // clear of a brace
let meter = null;
const textW = (t) => { meter ||= document.createElement("canvas").getContext("2d"); meter.font = "13px Georgia"; return meter.measureText(t).width; };
export function nameIndent(score) {
  const n = partNames(score);
  return n.length ? Math.min(170, 30 + Math.max(...n.map((x) => textW(x.name)))) : 0;
}

// Greedy system breaking + justification (DESIGN §5.2).
export function layout(score) {
  const full = SHEET_W - LEFT_PAD - RIGHT_PAD, ind = nameIndent(score);
  const room = () => (systems.length ? full : full - ind); // the first system is indented for part names
  const systems = [];
  let cur = null;
  for (let b = 0; b < score.measures.length; b++) {
    const first = !cur;
    const pre = prefixW(widestKey(score, b));
    const w = minWidth(score, b) + (first ? pre : changeW(score, b)) + (score.staves.some((st) => st.clefs?.[b + 1]) ? 24 : 0);
    const avail = room();
    if (cur && cur.used + w > avail) {
      systems.push(cur);
      cur = null;
      b--; // re-measure this bar as the first of a new system
      continue;
    }
    if (!cur) cur = { bars: [], widths: [], used: 0 };
    cur.bars.push(b);
    cur.widths.push(w);
    cur.used += w;
  }
  if (cur) systems.push(cur);
  systems.forEach((sys, i) => {
    const last = i === systems.length - 1, avail = i ? full : full - ind;
    if (last && sys.used < avail * 0.6) return;
    const f = avail / sys.used;
    sys.widths = sys.widths.map((w) => w * f);
  });
  return systems;
}

// stem: 0 = automatic, 1 = up, -1 = down (when layers share a bar, DESIGN §15)
function makeNote(ev, clef, stem = 0) {
  const VFl = VF();
  const rest = !ev.pitches.length;
  const keys = rest ? [stem ? REST_KEY_LAYER[clef][stem > 0 ? 0 : 1] : REST_KEY[clef]]
    : ev.pitches.map(keyOf);
  const duration = ev.dur + "d".repeat(ev.dots || 0) + (rest ? "r" : "");
  const note = stem ? new VFl.StaveNote({ clef, keys, duration, stem_direction: stem })
    : new VFl.StaveNote({ clef, keys, duration, auto_stem: true });
  if (ev.dots) VFl.Dot.buildAndAttach([note], { all: true });
  if (ev.grace) { // DESIGN §26: one is a slashed eighth, more are beamed sixteenths; accidentals come from applyAccidentals
    const one = ev.grace.length === 1;
    const gs = ev.grace.map((p) => new VFl.GraceNote({ keys: [keyOf(p)], duration: one ? "8" : "16", slash: one, clef }));
    const group = new VFl.GraceNoteGroup(gs, true);
    if (!one) group.beamNotes();
    note.addModifier(group, 0);
  }
  if (ev.marks) {
    // Layers sharing a bar: every mark on the stem side, away from the other layer. Otherwise a
    // fermata goes above and the rest on the notehead side.
    const down = note.getStemDirection() < 0, P = VFl.ModifierPosition;
    for (const m of ev.marks) {
      if (rest && m !== "fermata") continue;
      if (BRASS.has(m)) { keys.forEach((_, k) => note.addModifier(new VFl.Ornament(m), k)); continue; } // beside each notehead (DESIGN §31)
      if (ORN_VF[m]) { note.addModifier(new VFl.Ornament(ORN_VF[m]), 0); continue; }
      if (m === "tremolo") { note.addModifier(new VFl.Tremolo(3), 0); continue; }
      if (m === "arpeggio") { if (keys.length > 1) note.addModifier(new VFl.Stroke(VFl.Stroke.Type.ARPEGGIO_DIRECTIONLESS), 0); continue; }
      if (AFTER_VF[m]) { note.addModifier(new VFl.Articulation(AFTER_VF[m]).setPosition(P.ABOVE).setXShift(18), 0); continue; }
      const above = stem ? stem > 0 : m === "fermata" || down;
      note.addModifier(new VFl.Articulation(MARK_VF[m]).setPosition(above ? P.ABOVE : P.BELOW), 0);
    }
  }
  if (!rest) { // fingering (DESIGN §34): above a single note, beside each notehead of a chord
    const fs = ev.pitches.map((p, k) => [p.finger, k]).filter(([f]) => f);
    for (const [f, k] of fs) {
      const m = new VFl.FretHandFinger(f).setPosition(keys.length > 1 ? VFl.ModifierPosition.LEFT : VFl.ModifierPosition.ABOVE);
      note.addModifier(m, k);
    }
  }
  if (ev.dyn) { // dynamics: bold italic text under the note (DESIGN §22)
    const a = new VFl.Annotation(ev.dyn).setFont("Georgia", 14, "bold", "italic");
    note.addModifier(a.setVerticalJustification(VFl.Annotation.VerticalJustify.BOTTOM), 0);
  }
  return note;
}

/**
 * Draw the score into `container`. Returns the hit map:
 * { cells: [{sys, staff, bar, svg, x0, x1, yTop, yBottom, spacing, notes:[{idx,x,ys}]}],
 *   systems: [{svg, el, bars, height}], errors: [string] }
 */
// opts.layer: the layer being edited (hit map and selection); opts.dim: grey the other layers.
export function render(score, container, sel, opts = {}) {
  const VFl = VF();
  container.textContent = "";
  const systems = layout(score);
  const cells = [];
  const errors = [];
  const noteRef = score.staves.map((st) => allLayers(st).map(() => [])); // [staff][layer][bar][idx] = {note, sys}
  const ctxs = [];
  const nStaves = score.staves.length;
  const tops = staffTops(score);
  const height = tops[nStaves - 1] + 80 + SYS_BOTTOM;
  const lastBar = score.measures.length - 1;

  systems.forEach((sys, si) => {
    const el = document.createElement("div");
    el.className = "system";
    container.appendChild(el);
    const renderer = new VFl.Renderer(el, VFl.Renderer.Backends.SVG);
    renderer.resize(SHEET_W, height);
    const ctx = renderer.getContext();
    const svg = ctx.svg;
    svg.setAttribute("viewBox", `0 0 ${SHEET_W} ${height}`);
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.width = "100%";
    svg.style.height = "auto";
    ctxs[si] = ctx;
    sys.svg = svg; sys.el = el; sys.height = height;
    sys.x = [];

    try {
      drawSystem(score, sys, si, ctx, svg, cells, noteRef, sel, lastBar, opts);
    } catch (e) {
      console.error(e);
      errors.push(`Could not draw bars ${sys.bars[0] + 1}–${sys.bars[sys.bars.length - 1] + 1}`);
      try {
        ctx.clear?.();
        while (svg.lastChild) svg.removeChild(svg.lastChild);
        let x = LEFT_PAD + (si ? 0 : nameIndent(score));
        sys.bars.forEach((b, k) => {
          score.staves.forEach((st, s) => new VFl.Stave(x, tops[s], sys.widths[k]).setContext(ctx).draw());
          x += sys.widths[k];
        });
      } catch { /* nothing more we can do */ }
    }
  });

  // Ties, after all systems exist (DESIGN §5.4).
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => {
    bars.forEach((bar, b) => bar.forEach((ev, i) => {
      if (!ev.tie || !ev.pitches.length) return;
      const n = nextEventPos(score, s, b, i, v);
      if (!n) return;
      const ne = bars[n.bar][n.idx];
      const a = noteRef[s][v][b]?.[i], z = noteRef[s][v][n.bar]?.[n.idx];
      if (!a || !z) return;
      const fi = [], li = [];
      ev.pitches.forEach((p, pi) => {
        const qi = ne.pitches.findIndex((q) => q.step === p.step && q.oct === p.oct && q.drum === p.drum);
        if (qi >= 0) { fi.push(pi); li.push(qi); }
      });
      if (!fi.length) return;
      try { tinted(ctxs[a.sys], opts.dim && v !== (opts.layer || 0), () => tinted(ctxs[z.sys], opts.dim && v !== (opts.layer || 0) && a.sys !== z.sys, () => {
        if (a.sys === z.sys) {
          new VFl.StaveTie({ first_note: a.note, last_note: z.note, first_indices: fi, last_indices: li })
            .setContext(ctxs[a.sys]).draw();
        } else {
          new VFl.StaveTie({ first_note: a.note, last_note: null, first_indices: fi, last_indices: fi })
            .setContext(ctxs[a.sys]).draw();
          new VFl.StaveTie({ first_note: null, last_note: z.note, first_indices: li, last_indices: li })
            .setContext(ctxs[z.sys]).draw();
        }
      })); } catch (e) { console.error(e); }
    }));
  }));

  // Slides (DESIGN §31): a straight line from each notehead to its partner in the next note,
  // or to the system's end and on from the next system's start.
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    if (!ev.gliss) return;
    const n = nextEventPos(score, s, b, i, v), a = noteRef[s][v][b]?.[i], z = n && noteRef[s][v][n.bar]?.[n.idx];
    if (!a || !z) return;
    const ya = a.note.getYs(), yz = z.note.getYs(), x0 = a.note.getNoteHeadEndX() + 4, x1 = z.note.getNoteHeadBeginX() - (z.note.getMetrics().modLeftPx || 0) - 4; // clear of any accidental
    const line = (ctx, pts) => { ctx.beginPath(); for (const [x, y, x2, y2] of pts) { ctx.moveTo(x, y); ctx.lineTo(x2, y2); } ctx.stroke(); };
    try { tinted(ctxs[a.sys], opts.dim && v !== (opts.layer || 0), () => tinted(ctxs[z.sys], opts.dim && v !== (opts.layer || 0) && a.sys !== z.sys, () => {
      if (a.sys === z.sys) line(ctxs[a.sys], ya.map((y, k) => [x0, y, x1, yz[k] ?? y]));
      else {
        const xe = a.note.checkStave().getNoteEndX(), xs = z.note.checkStave().getNoteStartX();
        line(ctxs[a.sys], ya.map((y, k) => [x0, y, xe, (y + (yz[k] ?? y)) / 2]));
        line(ctxs[z.sys], yz.map((y, k) => [xs, (y + (ya[k] ?? y)) / 2, x1, y]));
      }
    })); } catch (e) { console.error(e); }
  }))));

  // Text and chord symbols above notes (DESIGN §30, §38): drawn after layout so it takes no room between notes; it starts
  // at the note and sits above the staff, or above the note when that's higher.
  // chord symbols in one row per staff and line, clear of the notes and of slurs over them
  const chordRow = {}, floor = {}; // floor["sys:staff"]: lowest thing drawn below the staff; floor["top:sys:staff"]: the chord row's top
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    const ref = noteRef[s][v][b]?.[i];
    if (!ev.harm || !ref) return;
    const bb = ref.note.getBoundingBox(), k = ref.sys + ":" + s;
    chordRow[k] = Math.min(chordRow[k] ?? Infinity, ref.note.checkStave().getYForLine(0) - 22, bb ? bb.y - 26 : Infinity);
  }))));
  for (const k in chordRow) floor["top:" + k] = chordRow[k] - 16; // octave lines go over them
  score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
    const ref = noteRef[s][v][b]?.[i];
    if ((!ev.text && !ev.harm) || !ref) return;
    const ctx = ctxs[ref.sys], note = ref.note, bb = note.getBoundingBox();
    let y = Math.min(note.checkStave().getYForLine(0) - 10, bb ? bb.y - 8 : Infinity) - (ev.marks?.some((m) => !BRASS.has(m)) ? 18 : 0); // over a fermata or accent (brass effects sit beside the note)
    const put = (t, font) => { // kept inside the system's right edge
      ctx.save(); ctx.setFont(...font);
      const w = ctx.measureText(t).width;
      ctx.fillText(t, Math.max(0, Math.min(note.getAbsoluteX() - 4, SHEET_W - 10 - w)), y);
      ctx.restore();
    };
    try {
      tintedAll([ctx], opts.dim && v !== (opts.layer || 0), () => {
        if (ev.harm) { y = chordRow[ref.sys + ":" + s]; drawChord(ctx, ev.harm, note.getAbsoluteX() - 4, y); y -= 20; } // chord symbols (DESIGN §38), text above them
        if (ev.text) put(ev.text, ["Georgia", 13, "normal", "italic"]);
      });
    } catch (e) { console.error(e); }
  }))));

  // rit., accel. and a tempo (DESIGN §39): over the bar's first staff, above its notes, chord symbols and text
  score.measures.forEach((m, b) => {
    const c = m.ramp && cells.find((x) => x.bar === b && x.staff === 0);
    if (!c) return;
    // the line's chord row and text can reach over from the bar before, so clear them across the line
    const line = cells.filter((x) => x.sys === c.sys && x.staff === 0).map((x) => x.bar);
    const refs = (noteRef[0] || []).flatMap((l) => l?.[b] || []), evs = allLayers(score.staves[0]).flatMap((bars) => line.flatMap((k) => bars[k]));
    let y = Math.min(c.yTop - 10, ...refs.map((r) => (r.note.getBoundingBox()?.y ?? Infinity) - 8));
    if (chordRow[c.sys + ":0"] !== undefined) y = Math.min(y, chordRow[c.sys + ":0"] - 20);
    if (evs.some((e) => e.text)) y -= 16;
    if (floor["top:" + c.sys + ":0"] !== undefined) y = Math.min(y, floor["top:" + c.sys + ":0"] - 6); // above an octave line
    const ctx = ctxs[c.sys];
    ctx.save(); ctx.setFont("Georgia", 13, "normal", "italic");
    ctx.fillText(RAMPS[m.ramp], c.notes[0]?.x - 4 || c.x0 + 8, y);
    ctx.restore();
  });

  // Slurs and hairpins (DESIGN §23)
  // Lyrics: a line per verse for each staff and system, below its notes and dynamics (DESIGN §24).
  // lyricY["sys:staff"] = verse 1's baseline, for the app's lyric box.
  // floor["sys:staff"] = lowest thing drawn so far below the staff; hairpins go under it.
  const lyricY = {}, mel = melismas(score), refOf = new Map();
  score.staves.forEach((st, s) => {
    const rows = {}, nv = verses(st); // sys -> [{ev, note}] in order
    allLayers(st).forEach((bars, v) => bars.forEach((bar, b) => bar.forEach((ev, i) => {
      const ref = noteRef[s][v][b]?.[i];
      if (ref) refOf.set(ev, ref);
      if (ev.lyrics && ref) (rows[ref.sys] ||= []).push({ ev, note: ref.note, v, b, i });
    })));
    for (const si in rows) {
      const ctx = ctxs[si], row = rows[si].sort((p, q) => p.b - q.b || p.note.getAbsoluteX() - q.note.getAbsoluteX());
      const stave = row[0].note.checkStave();
      let y = stave.getYForLine(4) + 32;
      for (const { ev, note } of row) {
        const bb = note.getBoundingBox();
        if (bb) y = Math.max(y, bb.y + bb.h + (ev.dyn ? 34 : 18));
      }
      try {
        tintedAll([ctx], opts.dim && row.every((r) => r.v !== (opts.layer || 0)), () => {
          ctx.save(); ctx.setFont("Georgia", 15);
          for (let vn = 0; vn < nv; vn++) {
            const vy = y + vn * LYRIC_LINE;
            const spans = row.filter(({ ev }) => ev.lyrics[vn]).map(({ ev, note }) => {
              const l = ev.lyrics[vn], w = ctx.measureText(l.text).width, x = note.getAbsoluteX() + 6 - w / 2;
              ctx.fillText(l.text, x, vy);
              if (l.ext) { // an extender to the last note held, or the line's end (DESIGN §37)
                const last = refOf.get(mel.get(ev)?.[vn]?.last), x2 = last?.sys === +si ? last.note.getAbsoluteX() + 12 : SHEET_W - 12;
                if (x2 > x + w + 6) ctx.fillRect(x + w + 2, vy + 1, x2 - x - w - 2, 1);
              }
              return { x, w, hyph: l.hyph };
            });
            spans.forEach((a, k) => { // hyphen halfway to the next syllable, or just after at a line end
              if (!a.hyph) return;
              const z = spans[k + 1], hx = z ? (a.x + a.w + z.x) / 2 - 3 : a.x + a.w + 4;
              ctx.fillText("-", hx, vy);
            });
          }
          ctx.restore();
        });
      } catch (e) { console.error(e); }
      floor[si + ":" + s] = y + (nv - 1) * LYRIC_LINE + 6;
      lyricY[si + ":" + s] = y;
    }
  });
  const slurs = [];
  for (const [kind, end] of SPAN_KINDS) score.staves.forEach((st, s) => allLayers(st).forEach((bars, v) => {
    let open = null;
    const first = ONE_NOTE.has(kind);
    bars.forEach((bar, b) => bar.forEach((ev, i) => {
      const ref = noteRef[s][v][b]?.[i];
      const start = () => { if (ev[kind] && ref) open = { kind, type: ev[kind], refs: [], evs: [], s, v, multi: allLayers(st).filter((L) => L[b].length).length > 1 }; };
      if (first) start();
      if (open && ref) { open.refs.push(ref); open.evs.push(ev); }
      if (ev[end] && open) {
        if (kind.startsWith("slur")) slurs.push(open);
        else try { tintedAll(ctxs, opts.dim && v !== (opts.layer || 0), () => (first ? drawLine : drawSpan)(ctxs, kind, open, s, floor)); } catch (e) { console.error(e); }
        open = null;
      }
      if (!first) { start(); if (open && !open.refs.length && ref) { open.refs.push(ref); open.evs.push(ev); } }
    }));
  }));
  // slurs inside out: one around another clears it (DESIGN §37)
  slurs.sort((p, q) => p.evs.length - q.evs.length).forEach((sl, k) => {
    const out = slurs.slice(0, k).filter((o) => o.s === sl.s && o.v === sl.v && sl.evs.includes(o.evs[0]) && sl.evs.includes(o.evs[o.evs.length - 1])).length;
    try { tintedAll(ctxs, opts.dim && sl.v !== (opts.layer || 0), () => drawSpan(ctxs, "slur", sl, sl.s, floor, out ? 10 : 0)); } catch (e) { console.error(e); }
  });

  systems.forEach((sys) => sys.svg && grow(sys.svg, sys));
  return { cells, systems, errors, lyricY };
}

// A chord symbol: letters in the text font, accidentals from the music font (text fonts draw ♭ wide).
const CHORD_ACC = { "-2": "accidentalDoubleFlat", "-1": "accidentalFlat", 1: "accidentalSharp", 2: "accidentalDoubleSharp" };
function drawChord(ctx, h, x, y) {
  const G = VF().Glyph, toks = [];
  const note = (p, pre = "") => { toks.push({ t: pre + "CDEFGAB"[p.step] }); if (p.alter) toks.push({ g: CHORD_ACC[p.alter] }); };
  note(h.root);
  if (h.kind) toks.push({ t: h.kind });
  if (h.bass) note(h.bass, "/");
  ctx.save(); ctx.setFont("Georgia", 16);
  const w = (k) => (k.t ? ctx.measureText(k.t).width : G.getWidth(k.g, 26) + 3);
  x = Math.max(0, Math.min(x, SHEET_W - 10 - toks.reduce((a, k) => a + w(k), 0)));
  for (const k of toks) {
    if (k.t) ctx.fillText(k.t, x, y); else G.renderGlyph(ctx, x + 1.5, y - 6, 26, k.g);
    x += w(k);
  }
  ctx.restore();
}

function tintedAll(ctxs, on, draw) {
  if (!on) return draw();
  ctxs.forEach((c) => { c.save(); c.setFillStyle(DIM); c.setStrokeStyle(DIM); });
  try { draw(); } finally { ctxs.forEach((c) => c.restore()); }
}

// One slur or hairpin over refs ({note, sys}, in order), split where the line breaks.
function drawSpan(ctxs, kind, { type, refs, evs, multi }, s, floor, lift = 0) {
  const segs = [];
  for (const r of refs) {
    if (!segs.length || segs[segs.length - 1].sys !== r.sys) segs.push({ sys: r.sys, notes: [] });
    segs[segs.length - 1].notes.push(r.note);
  }
  const first = refs[0].note, last = refs[refs.length - 1].note;
  // slurs go on the notehead side, or the stem side when layers share the bar
  const up = first.getStemDirection() > 0, dir = kind === "slur" ? (multi ? (up ? -1 : 1) : (up ? 1 : -1)) : 1;
  segs.forEach((seg, k) => {
    const ctx = ctxs[seg.sys], stave = seg.notes[0].checkStave();
    const n0 = seg.notes[0], n1 = seg.notes[seg.notes.length - 1];
    const x1 = k === 0 ? n0.getAbsoluteX() + 4 : stave.getTieStartX() - 4;
    const x2 = k === segs.length - 1 ? last.getAbsoluteX() + 6 : n1.checkStave().getTieEndX();
    const boxes = seg.notes.map((n) => n.getBoundingBox()).filter(Boolean);
    const edge = (bb) => (dir < 0 ? bb.y : bb.y + bb.h);
    const ext = (vals) => (dir < 0 ? Math.min(...vals) : Math.max(...vals));
    if (kind === "slur") {
      const ya = k === 0 ? edge(first.getBoundingBox()) + dir * 4 : null;
      const yz = k === segs.length - 1 ? edge(last.getBoundingBox()) + dir * 4 : null;
      const y1 = ya ?? yz ?? ext(boxes.map(edge)), y2 = yz ?? y1;
      const inner = boxes.length > 2 ? ext(boxes.slice(1, -1).map(edge)) + dir * 6 : null;
      const h = Math.min(22, 6 + Math.abs(x2 - x1) * 0.06);
      const mid = (inner === null ? (y1 + y2) / 2 + dir * h : ext([(y1 + y2) / 2 + dir * h, inner])) + dir * lift;
      const c = 2 * mid - (y1 + y2) / 2, cx = (x1 + x2) / 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, c, x2, y2);
      ctx.quadraticCurveTo(cx, c - dir * 3, x1, y1); ctx.closePath(); ctx.fill();
      if (dir > 0) floor[seg.sys + ":" + s] = Math.max(floor[seg.sys + ":" + s] || 0, mid);
    } else {
      const y = Math.max(stave.getYForLine(4) + 26, (floor[seg.sys + ":" + s] || 0) + 12, ...boxes.map((bb) => bb.y + bb.h + 14));
      // leave room for a dynamic at either end
      const xa = k === 0 && evs[0].dyn ? x1 + 22 : x1, xz = k === segs.length - 1 && evs[evs.length - 1].dyn ? x2 - 14 : x2;
      const open = [k === 0 ? 0 : 3, k === segs.length - 1 ? 6 : 3]; // half-opening at each end
      const [ha, hz] = type === "<" ? open : [6 - open[0], 6 - open[1]];
      ctx.beginPath();
      ctx.moveTo(xz, y - hz); ctx.lineTo(xa, y - ha); ctx.moveTo(xa, y + ha); ctx.lineTo(xz, y + hz);
      ctx.stroke();
      floor[seg.sys + ":" + s] = Math.max(floor[seg.sys + ":" + s] || 0, y + 8);
    }
  });
}

// An octave line or pedal mark (DESIGN §37), split where the line breaks: "8va" and a dashed line
// with a hook at the end, above the staff (below for 8vb and 15mb); "Ped." and a line under it,
// up at the end, where the pedal lifts.
function drawLine(ctxs, kind, { type, refs }, s, floor) {
  const segs = [];
  for (const r of refs) {
    if (!segs.length || segs[segs.length - 1].sys !== r.sys) segs.push({ sys: r.sys, notes: [] });
    segs[segs.length - 1].notes.push(r.note);
  }
  const below = kind === "ped" || OTT_SHIFT[type] < 0;
  const label = kind === "ped" ? "Ped." : type === "8va" || type === "8vb" ? "8" : "15", sup = kind === "ped" ? "" : { "8va": "va", "8vb": "vb", "15ma": "ma", "15mb": "mb" }[type];
  segs.forEach((seg, k) => {
    const ctx = ctxs[seg.sys], stave = seg.notes[0].checkStave(), lastSeg = k === segs.length - 1;
    const boxes = seg.notes.map((n) => n.getBoundingBox()).filter(Boolean);
    const x1 = k === 0 ? seg.notes[0].getAbsoluteX() - 2 : stave.getTieStartX() - 4;
    const x2 = lastSeg ? seg.notes[seg.notes.length - 1].getAbsoluteX() + 16 : seg.notes[seg.notes.length - 1].checkStave().getTieEndX();
    // ponytail: below the notes, not under lyrics elsewhere on the line; a pedal under lyrics in the same bars overlaps them
    const y = below ? Math.max(stave.getYForLine(4) + 30, ...boxes.map((bb) => bb.y + bb.h + 16))
      : Math.min(stave.getYForLine(0) - 16, floor["top:" + seg.sys + ":" + s] ?? Infinity, ...boxes.map((bb) => bb.y - 10));
    ctx.save();
    ctx.setFont("Georgia", kind === "ped" ? 14 : 13, kind === "ped" ? "bold italic" : "italic");
    const text = k === 0 ? label : kind === "ped" ? "" : `(${label})`;
    ctx.fillText(text, x1, y);
    let tx = x1 + (text ? ctx.measureText(text).width : 0);
    if (k === 0 && sup) { ctx.setFont("Georgia", 9, "italic"); ctx.fillText(sup, tx, y - 5); tx += ctx.measureText(sup).width; }
    const ly = kind === "ped" ? y + 2 : below ? y - 4 : y - 4; // the line at the text's middle (ped: just under)
    ctx.beginPath();
    if (kind !== "ped") ctx.setLineDash([4, 3]);
    const xe = Math.max(x2, tx + 10); // past the text, however short the note
    ctx.moveTo(tx + 3, ly); ctx.lineTo(xe, ly);
    if (lastSeg) ctx.lineTo(xe, kind === "ped" ? ly - 10 : below ? ly - 8 : ly + 8);
    ctx.stroke();
    ctx.restore();
    if (below) floor[seg.sys + ":" + s] = Math.max(floor[seg.sys + ":" + s] || 0, y + 6);
  });
}

// The drawing grows to hold whatever reaches above or below it (high or low notes, fermatas,
// clef tips, bar numbers, dynamics, lyrics): print clips each system to its drawing and splits
// pages between them. The viewBox top can go below 0; the app reads it for click positions.
function grow(svg, sys) {
  let bb;
  try { bb = svg.getBBox(); } catch { return; } // not laid out (hidden)
  const top = Math.min(0, Math.floor(bb.y - 4)), bottom = Math.max(sys.height, Math.ceil(bb.y + bb.height + 8));
  if (top < 0 || bottom > sys.height) { sys.height = bottom - top; svg.setAttribute("viewBox", `0 ${top} ${SHEET_W} ${bottom - top}`); }
}

// Repeat barlines on every staff; endings and D.C./segno/coda text on the top one (DESIGN §28).
const REP_VF = { segno: "SEGNO_LEFT", coda: "CODA_LEFT", toCoda: "TO_CODA", fine: "FINE",
  dc: "DC", dcFine: "DC_AL_FINE", dcCoda: "DC_AL_CODA", ds: "DS", dsFine: "DS_AL_FINE", dsCoda: "DS_AL_CODA" };
function repeatMarks(VFl, score, b, s, stave) {
  const m = score.measures[b], ms = score.measures;
  if (m.repStart) stave.setBegBarType(VFl.Barline.type.REPEAT_BEGIN);
  if (m.repEnd) stave.setEndBarType(VFl.Barline.type.REPEAT_END);
  if (s !== 0) return;
  // above the bar's highest note: 5 units per step past two steps over the top line
  const st = score.staves[0];
  const upOf = (i) => {
    const top = BOTTOM_LINE[clefAt(st, i)] + 8;
    const hi = Math.max(top, ...allLayers(st).flatMap((bars) => bars[i].flatMap((e) => [...e.pitches, ...(e.grace || [])].map(diatonic))));
    const has = (k) => allLayers(st).some((bars) => bars[i].some((e) => e[k]));
    const text = (has("text") ? 18 : 0) + (has("harm") ? 24 : 0); // above text and chord symbols on its notes (DESIGN §30, §38)
    return -Math.max(0, (hi - top - 2) * 5) - text;
  };
  const up = upOf(b);
  if (m.volta) {
    // a bracket carried onto a new line goes on as a plain line, without its number
    const T = VFl.Volta.type, begins = !sameVolta(ms[b - 1]?.volta, m.volta), ends = !sameVolta(ms[b + 1]?.volta, m.volta);
    let a = b, z = b; // one bracket, one height
    while (sameVolta(ms[a - 1]?.volta, m.volta)) a--;
    while (sameVolta(ms[z + 1]?.volta, m.volta)) z++;
    const vUp = Math.min(...ms.slice(a, z + 1).map((_, k) => upOf(a + k)));
    stave.setVoltaType(begins && ends ? T.BEGIN_END : begins ? T.BEGIN : ends ? T.END : T.MID, begins ? voltaLabel(m.volta) : "", vUp);
  }
  // signs at the bar's start go above an ending's number, the tempo beside them
  const lift = m.volta ? 25 : 0;
  // left to right at the bar's start: rehearsal mark, segno or coda, tempo
  const dx = m.rehearsal ? 18 + 8 * m.rehearsal.length : 0;
  for (const key of ["segno", "coda"]) if (m[key]) stave.setRepetitionType(VFl.Repetition.type[REP_VF[key]], up - lift).getModifiers().at(-1).setShiftX(dx);
  for (const key of ["toCoda", "fine"]) if (m[key]) stave.setRepetitionType(VFl.Repetition.type[REP_VF[key]], up);
  if (m.jump) stave.setRepetitionType(VFl.Repetition.type[REP_VF[m.jump]], up);
  // tempo changes (DESIGN §29); bar 1's tempo is shown only when the score has changes
  const bpm = b ? m.tempo : ms.some((x) => x.tempo) && score.tempo;
  const name = !b && score.swing ? "Swing" : ""; // DESIGN §39
  if (bpm || name) stave.setTempo({ ...(name && { name }), ...(bpm && { duration: "q", bpm }) }, up - (m.volta ? 42 : 0)).getModifiers().at(-1).setShiftX(dx + (m.segno ? 35 : m.coda ? 60 : 10));
  // a rehearsal mark (DESIGN §30): boxed, at the barline, above all of these
  if (m.rehearsal) stave.setSection(m.rehearsal, up - lift - (m.segno || m.coda || bpm || name ? 26 : m.volta ? 6 : 0), -6, 13);
}

// Is (b, i) selected? sel may carry `end` for a range (DESIGN §11.7).
function inSel(sel, b, i) {
  const a = [sel.bar, sel.idx], z = sel.end ? [sel.end.bar, sel.end.idx] : a;
  const [lo, hi] = a[0] < z[0] || (a[0] === z[0] && a[1] <= z[1]) ? [a, z] : [z, a];
  return (b > lo[0] || (b === lo[0] && i >= lo[1])) && (b < hi[0] || (b === hi[0] && i <= hi[1]));
}

function drawSystem(score, sys, si, ctx, svg, cells, noteRef, sel, lastBar, { layer = 0, dim = false } = {}) {
  const VFl = VF();
  // 1. staves
  const staves = []; // [k][s]
  let x = LEFT_PAD + (si ? 0 : nameIndent(score));
  sys.bars.forEach((b, k) => {
    const at = attrsAt(score, b);
    const m = score.measures[b];
    const firstInSys = k === 0;
    const row = score.staves.map((st, s) => {
      const stave = new VFl.Stave(x, staffTops(score)[s], sys.widths[k]);
      const key = keyAt(score, s, b);
      if (firstInSys) { stave.addClef(clefAt(st, b)); if (!isPerc(st)) stave.addKeySignature(keyName(key)); }
      if (firstInSys && si > 0 && s === 0) stave.setMeasure(barNumber(score, b)); // bar number (DESIGN §11.4)
      if (!firstInSys && m.key !== undefined && !isPerc(st)) stave.addKeySignature(keyName(key), keyName(keyAt(score, s, b - 1)));
      // a clef change is drawn small before the barline it starts at, also as the courtesy clef at a line end
      if (st.clefs?.[b + 1]) stave.setEndClef(st.clefs[b + 1], "small");
      if (b === 0 || (m.time && b > 0)) stave.addTimeSignature(timeLabel(at));
      if (b === lastBar) stave.setEndBarType(VFl.Barline.type.END);
      repeatMarks(VFl, score, b, s, stave);
      return stave;
    });
    const start = Math.max(...row.map((r) => r.getNoteStartX()));
    row.forEach((r) => r.setNoteStartX(start));
    staves.push(row);
    sys.x.push({ bar: b, x0: x, x1: x + sys.widths[k] });
    x += sys.widths[k];
  });
  staves.forEach((row) => row.forEach((st) => st.setContext(ctx).draw()));
  if (si === 0) { // part names, right-aligned before the first system, centred on a braced pair
    ctx.save(); ctx.setFont("Georgia", 13, "normal");
    for (const { g, name } of partNames(score)) {
      const top = staves[0][g[0]].getYForLine(0), bot = staves[0][g[g.length - 1]].getYForLine(4);
      let t = name; // cut to the indent, with an ellipsis
      while (t.length > 1 && textW(t) > nameIndent(score) - 30) t = t.slice(0, -2) + "…";
      ctx.fillText(t, x0Names(score) - textW(t), (top + bot) / 2 + 4);
    }
    ctx.restore();
  }
  // "×3" over a :| that plays more than twice (VexFlow draws only the dots)
  sys.bars.forEach((b, k) => {
    const n = score.measures[b].repEnd;
    if (n > 2) { ctx.save(); ctx.setFont("Georgia", 13, "italic"); ctx.fillText(`×${n}`, staves[k][0].getX() + sys.widths[k] - 26, staves[k][0].getYForLine(0) - 8); ctx.restore(); }
  });

  // 2. connectors
  const firstRow = staves[0];
  if (firstRow.length > 1) {
    new VFl.StaveConnector(firstRow[0], firstRow[firstRow.length - 1])
      .setType(VFl.StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
  }
  score.staves.forEach((st, s) => {
    if (st.brace && s + 1 < firstRow.length) {
      new VFl.StaveConnector(firstRow[s], firstRow[s + 1]).setType(VFl.StaveConnector.type.BRACE).setContext(ctx).draw();
      staves.forEach((row) => {
        new VFl.StaveConnector(row[s], row[s + 1]).setType(VFl.StaveConnector.type.SINGLE_RIGHT).setContext(ctx).draw();
      });
    }
  });

  // 3. notes, per bar across all staves
  sys.bars.forEach((b, k) => {
    const { time } = attrsAt(score, b);
    const voices = [], beams = [], tuplets = [], drawn = [];
    const fmt = new VFl.Formatter();
    score.staves.forEach((st, s) => {
      const stave = staves[k][s];
      // layers with notes draw; when none has any, layer 1 draws a whole rest
      let used = allLayers(st).map((bars, v) => ({ v, bar: bars[b] })).filter(({ bar }) => bar.length);
      if (!used.length) used = [{ v: 0, bar: [] }];
      const multi = used.length > 1, clef = clefAt(st, b);
      const staffVoices = [];
      for (const { v, bar } of used) {
        let notes;
        const stem = multi ? (v % 2 === 0 ? 1 : -1) : 0;
        if (!bar.length) {
          notes = [new VFl.StaveNote({ clef, keys: [REST_KEY[clef]], duration: "wr", align_center: !multi })];
        } else {
          notes = bar.map((ev) => makeNote(ev, clef, stem));
          bar.forEach((ev, i) => {
            if (v === layer && sel && sel.staff === s && inSel(sel, b, i))
              notes[i].setStyle({ fillStyle: ACCENT, strokeStyle: ACCENT });
            else if (dim && v !== layer) notes[i].setStyle({ fillStyle: DIM, strokeStyle: DIM });
          });
          const grey = dim && v !== layer;
          for (const run of tupletRuns(bar)) {
            tuplets.push(new VFl.Tuplet(run.idx.map((i) => notes[i]),
              { num_notes: run.tup[0], notes_occupied: run.tup[1], location: stem < 0 ? -1 : 1 }));
            tuplets[tuplets.length - 1].grey = grey;
          }
          if (bar.some((e) => e.pitches.length && ["8", "16", "32"].includes(e.dur))) {
            for (const bm of VFl.Beam.generateBeams(notes, { groups: VFl.Beam.getDefaultBeamGroups(`${time[0]}/${time[1]}`), maintain_stem_directions: !!stem })) {
              bm.grey = grey;
              beams.push(bm);
            }
          }
        }
        const voice = new VFl.Voice({ num_beats: time[0], beat_value: time[1] }).setMode(VFl.Voice.Mode.SOFT);
        voice.addTickables(notes);
        staffVoices.push(voice);
        drawn.push({ s, v, stave, voice, notes, empty: !bar.length });
      }
      // accidentals look across all layers of the staff
      const withNotes = staffVoices.filter((_, i) => used[i].bar.length);
      if (withNotes.length && !isPerc(st)) VFl.Accidental.applyAccidentals(withNotes, keyName(keyAt(score, s, b)));
      fmt.joinVoices(staffVoices);
      voices.push(...staffVoices);
    });
    const st0 = staves[k][0];
    const width = Math.max(10, st0.getNoteEndX() - st0.getNoteStartX() - 10);
    fmt.format(voices, width);
    drawn.forEach(({ stave, voice }) => voice.draw(ctx, stave));
    beams.forEach((bm) => tinted(ctx, bm.grey, () => bm.setContext(ctx).draw()));
    tuplets.forEach((t) => tinted(ctx, t.grey, () => t.setContext(ctx).draw()));

    drawn.forEach(({ s, v, notes, empty }) => { noteRef[s][v][b] = empty ? [] : notes.map((note) => ({ note, sys: si })); });
    // one hit cell per staff and bar; its notes are the edited layer's
    score.staves.forEach((st, s) => {
      const stave = staves[k][s];
      const d = drawn.find((x) => x.s === s && x.v === layer && !x.empty);
      cells.push({
        sys: si, staff: s, bar: b, svg,
        x0: stave.getX(), x1: stave.getX() + stave.getWidth(),
        yTop: stave.getYForLine(0), yBottom: stave.getYForLine(4),
        spacing: stave.getSpacingBetweenLines(),
        notes: d ? d.notes.map((n, idx) => ({ idx, x: n.getAbsoluteX(), ys: n.getYs?.() || [] })) : [],
      });
    });
  });
}
