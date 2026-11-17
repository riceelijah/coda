// Coda renderer: score model -> SVG systems via VexFlow. See docs/DESIGN.md §5.
import { attrsAt, nextEventPos, tupletRuns, allLayers } from "./model.js";

const VF = () => Vex.Flow;

export const SHEET_W = 1020;
const STAFF_GAP = 95;
const SYS_TOP = 10;      // VexFlow already leaves 40 units above the top line
const SYS_BOTTOM = 50;
const LEFT_PAD = 20;
const KEY_NAMES = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MARK_VF = { fermata: "a@", staccato: "a.", accent: "a>", tenuto: "a-", marcato: "a^" };
const REST_KEY = { treble: "b/4", bass: "d/3", alto: "c/4", tenor: "a/3" };
// rests above / below the middle when two layers share a bar
const REST_KEY_LAYER = { treble: ["e/5", "f/4"], bass: ["g/3", "a/2"], alto: ["f/4", "g/3"], tenor: ["d/4", "e/3"] };
const ACC = { "-2": "bb", "-1": "b", 0: "n", 1: "#", 2: "##" };
const ACCENT = "#2563eb";
const DIM = "#9aa0a6"; // layers other than the one being edited (screen only)

export function keyName(k) { return KEY_NAMES[k + 7]; }

function minWidth(score, b) {
  const n = Math.max(1, ...score.staves.flatMap((s) => allLayers(s).map((bars) => bars[b].length)));
  return Math.max(150, 50 + 30 * n);
}

function prefixW(key) { return 55 + 13 * Math.abs(key) + 35; }

// Extra width for a mid-system key/time change.
function changeW(score, b) {
  const m = score.measures[b];
  let w = 0;
  if (b > 0 && m.key !== undefined) w += 13 * Math.max(Math.abs(m.key), Math.abs(attrsAt(score, b - 1).key)) + 10;
  if (b > 0 && m.time) w += 35;
  return w;
}

// Greedy system breaking + justification (DESIGN §5.2).
export function layout(score) {
  const avail = SHEET_W - LEFT_PAD;
  const systems = [];
  let cur = null;
  for (let b = 0; b < score.measures.length; b++) {
    const first = !cur;
    const pre = prefixW(attrsAt(score, b).key);
    const w = minWidth(score, b) + (first ? pre : changeW(score, b));
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
    const last = i === systems.length - 1;
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
    : ev.pitches.map((p) => "cdefgab"[p.step] + ACC[p.alter] + "/" + p.oct);
  const duration = ev.dur + "d".repeat(ev.dots || 0) + (rest ? "r" : "");
  const note = stem ? new VFl.StaveNote({ clef, keys, duration, stem_direction: stem })
    : new VFl.StaveNote({ clef, keys, duration, auto_stem: true });
  if (ev.dots) VFl.Dot.buildAndAttach([note], { all: true });
  if (ev.marks) {
    // Layers sharing a bar: every mark on the stem side, away from the other layer. Otherwise a
    // fermata goes above and the rest on the notehead side.
    const down = note.getStemDirection() < 0, P = VFl.ModifierPosition;
    for (const m of ev.marks) {
      if (rest && m !== "fermata") continue;
      const above = stem ? stem > 0 : m === "fermata" || down;
      note.addModifier(new VFl.Articulation(MARK_VF[m]).setPosition(above ? P.ABOVE : P.BELOW), 0);
    }
  }
  return note;
}

/**
 * Draw the score into `container`. Returns the hit map:
 * { cells: [{sys, staff, bar, svg, x0, x1, yTop, yBottom, spacing, notes:[{idx,x}]}],
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
  const height = SYS_TOP + (nStaves - 1) * STAFF_GAP + 80 + SYS_BOTTOM;
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
        let x = LEFT_PAD;
        sys.bars.forEach((b, k) => {
          score.staves.forEach((st, s) => new VFl.Stave(x, SYS_TOP + s * STAFF_GAP, sys.widths[k]).setContext(ctx).draw());
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
        const qi = ne.pitches.findIndex((q) => q.step === p.step && q.oct === p.oct);
        if (qi >= 0) { fi.push(pi); li.push(qi); }
      });
      if (!fi.length) return;
      try {
        if (a.sys === z.sys) {
          new VFl.StaveTie({ first_note: a.note, last_note: z.note, first_indices: fi, last_indices: li })
            .setContext(ctxs[a.sys]).draw();
        } else {
          new VFl.StaveTie({ first_note: a.note, last_note: null, first_indices: fi, last_indices: fi })
            .setContext(ctxs[a.sys]).draw();
          new VFl.StaveTie({ first_note: null, last_note: z.note, first_indices: li, last_indices: li })
            .setContext(ctxs[z.sys]).draw();
        }
      } catch (e) { console.error(e); }
    }));
  }));

  return { cells, systems, errors };
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
  let x = LEFT_PAD;
  sys.bars.forEach((b, k) => {
    const { key, time } = attrsAt(score, b);
    const m = score.measures[b];
    const firstInSys = k === 0;
    const row = score.staves.map((st, s) => {
      const stave = new VFl.Stave(x, SYS_TOP + s * STAFF_GAP, sys.widths[k]);
      if (firstInSys) stave.addClef(st.clef).addKeySignature(keyName(key));
      if (firstInSys && si > 0 && s === 0) stave.setMeasure(b + 1); // bar number (DESIGN §11.4)
      else if (b > 0 && m.key !== undefined) stave.addKeySignature(keyName(key), keyName(attrsAt(score, b - 1).key));
      if (b === 0 || (m.time && b > 0)) stave.addTimeSignature(`${time[0]}/${time[1]}`);
      if (b === lastBar) stave.setEndBarType(VFl.Barline.type.END);
      return stave;
    });
    const start = Math.max(...row.map((r) => r.getNoteStartX()));
    row.forEach((r) => r.setNoteStartX(start));
    staves.push(row);
    sys.x.push({ bar: b, x0: x, x1: x + sys.widths[k] });
    x += sys.widths[k];
  });
  staves.forEach((row) => row.forEach((st) => st.setContext(ctx).draw()));

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
    const { key, time } = attrsAt(score, b);
    const voices = [], beams = [], tuplets = [], drawn = [];
    const fmt = new VFl.Formatter();
    score.staves.forEach((st, s) => {
      const stave = staves[k][s];
      // layers with notes draw; when none has any, layer 1 draws a whole rest
      let used = allLayers(st).map((bars, v) => ({ v, bar: bars[b] })).filter(({ bar }) => bar.length);
      if (!used.length) used = [{ v: 0, bar: [] }];
      const multi = used.length > 1;
      const staffVoices = [];
      for (const { v, bar } of used) {
        let notes;
        const stem = multi ? (v % 2 === 0 ? 1 : -1) : 0;
        if (!bar.length) {
          notes = [new VFl.StaveNote({ clef: st.clef, keys: [REST_KEY[st.clef]], duration: "wr", align_center: !multi })];
        } else {
          notes = bar.map((ev) => makeNote(ev, st.clef, stem));
          bar.forEach((ev, i) => {
            if (v === layer && sel && sel.staff === s && inSel(sel, b, i))
              notes[i].setStyle({ fillStyle: ACCENT, strokeStyle: ACCENT });
            else if (dim && v !== layer) notes[i].setStyle({ fillStyle: DIM, strokeStyle: DIM });
          });
          for (const run of tupletRuns(bar)) {
            tuplets.push(new VFl.Tuplet(run.idx.map((i) => notes[i]),
              { num_notes: run.tup[0], notes_occupied: run.tup[1], location: stem < 0 ? -1 : 1 }));
          }
          if (bar.some((e) => e.pitches.length && ["8", "16", "32"].includes(e.dur))) {
            beams.push(...VFl.Beam.generateBeams(notes, { groups: VFl.Beam.getDefaultBeamGroups(`${time[0]}/${time[1]}`), maintain_stem_directions: !!stem }));
          }
        }
        const voice = new VFl.Voice({ num_beats: time[0], beat_value: time[1] }).setMode(VFl.Voice.Mode.SOFT);
        voice.addTickables(notes);
        staffVoices.push(voice);
        drawn.push({ s, v, stave, voice, notes, empty: !bar.length });
      }
      // accidentals look across all layers of the staff
      const withNotes = staffVoices.filter((_, i) => used[i].bar.length);
      if (withNotes.length) VFl.Accidental.applyAccidentals(withNotes, keyName(key));
      fmt.joinVoices(staffVoices);
      voices.push(...staffVoices);
    });
    const st0 = staves[k][0];
    const width = Math.max(10, st0.getNoteEndX() - st0.getNoteStartX() - 10);
    fmt.format(voices, width);
    drawn.forEach(({ stave, voice }) => voice.draw(ctx, stave));
    beams.forEach((bm) => bm.setContext(ctx).draw());
    tuplets.forEach((t) => t.setContext(ctx).draw());

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
        notes: d ? d.notes.map((n, idx) => ({ idx, x: n.getAbsoluteX() })) : [],
      });
    });
  });
}
