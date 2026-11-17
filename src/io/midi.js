// Standard MIDI File import. See docs/DESIGN.md §9.4.
// MIDI holds performance data, not notation, so the result is a transcription.
import { barCapacity, splitTicks, spellMidi, padBars, noteCount, PPQ } from "../model.js";
import { Report } from "./util.js";

const GRID = 120; // 16th note

export function parseSMF(bytes) {
  let off = 0;
  // RIFF-wrapped MIDI (.rmi): find the MThd chunk
  if (bytes[0] === 0x52) {
    for (let i = 0; i < Math.min(bytes.length - 4, 64); i++) {
      if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) { off = i; break; }
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n) => { if (off + n > bytes.length) throw new Error("This MIDI file is incomplete or damaged."); };
  const str4 = () => { need(4); const s = String.fromCharCode(...bytes.subarray(off, off + 4)); off += 4; return s; };
  const u32 = () => { need(4); const v = dv.getUint32(off); off += 4; return v; };
  const u16 = () => { need(2); const v = dv.getUint16(off); off += 2; return v; };

  if (str4() !== "MThd") throw new Error("This isn't a MIDI file.");
  const hlen = u32();
  const format = u16(), ntrks = u16(), division = u16();
  off += hlen - 6;
  if (division & 0x8000) throw new Error("This MIDI file uses SMPTE timing, which Coda can't read yet.");
  if (format === 2) throw new Error("This is a format 2 MIDI file (independent patterns), which Coda can't read.");
  if (!division) throw new Error("This MIDI file is damaged (zero time division).");

  const tracks = [];
  for (let t = 0; t < ntrks && off + 8 <= bytes.length; t++) {
    const id = str4(), len = u32();
    const end = Math.min(off + len, bytes.length);
    if (id !== "MTrk") { off = end; t--; continue; }
    const events = [];
    let tick = 0, status = 0;
    const vlq = () => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        if (off >= end) throw new Error("This MIDI file is incomplete or damaged.");
        const b = bytes[off++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
      return v;
    };
    while (off < end) {
      tick += vlq();
      let b = bytes[off];
      if (b & 0x80) { off++; if (b < 0xf0) status = b; } else b = status; // running status
      if (!(b & 0x80)) throw new Error("This MIDI file is damaged (bad running status).");
      if (b === 0xff) {
        const type = bytes[off++], len2 = vlq();
        const data = bytes.subarray(off, Math.min(off + len2, end));
        off += len2;
        events.push({ tick, meta: type, data });
        if (type === 0x2f) break;
      } else if (b === 0xf0 || b === 0xf7) {
        const n = vlq(); // read the length first: `off += vlq()` would add to the old offset
        off += n;
      } else {
        const hi = b & 0xf0, ch = b & 0x0f;
        const d1 = bytes[off++];
        const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[off++];
        if (hi === 0x90 && d2 > 0) events.push({ tick, on: true, ch, note: d1 });
        else if (hi === 0x80 || hi === 0x90) events.push({ tick, on: false, ch, note: d1 });
      }
    }
    off = end;
    tracks.push(events);
  }
  return { format, division, tracks };
}

export function importMIDI(bytes, fileName = "") {
  const report = new Report("MIDI");
  report.add("MIDI files contain performance data, not notation, so this is an automatic transcription and may need tidying.");
  const { format, division, tracks } = parseSMF(bytes);
  const scale = (t) => (t * PPQ) / division;
  const q = (t) => Math.round(scale(t) / GRID) * GRID;

  // meta: first of each kind wins
  let tempo = null, time = null, key = null;
  let extraMeta = false;
  const names = [];
  tracks.forEach((evs, ti) => evs.forEach((e) => {
    if (e.meta === undefined) return;
    if (e.meta === 0x51 && e.data.length >= 3) {
      const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
      if (tempo === null) tempo = Math.round(60e6 / us); else if (e.tick > 0) extraMeta = true;
    } else if (e.meta === 0x58 && e.data.length >= 2) {
      const t = [e.data[0], 2 ** e.data[1]];
      if (time === null) time = t; else if (e.tick > 0) extraMeta = true;
    } else if (e.meta === 0x59 && e.data.length >= 1) {
      const sf = e.data[0] > 127 ? e.data[0] - 256 : e.data[0];
      if (key === null) key = Math.max(-7, Math.min(7, sf)); else if (e.tick > 0) extraMeta = true;
    } else if (e.meta === 0x03 && !names[ti]) {
      names[ti] = new TextDecoder("latin1").decode(e.data).trim();
    }
  }));
  if (extraMeta) report.add("Only the first tempo, time signature and key signature were used.");
  if (!time || ![1, 2, 4, 8, 16, 32].includes(time[1]) || time[0] < 1) time = [4, 4];
  key = key ?? 0;
  tempo = Math.max(20, Math.min(400, tempo || 120));

  // collect notes per source (track for format 1, channel for format 0)
  const sources = new Map();
  tracks.forEach((evs, ti) => {
    const open = new Map(); // ch:note -> [start ticks]
    for (const e of evs) {
      if (e.meta !== undefined) continue;
      if (e.ch === 9) { if (e.on) report.count("Percussion notes skipped (channel 10)"); continue; }
      const k = e.ch * 128 + e.note;
      if (e.on) { if (!open.has(k)) open.set(k, []); open.get(k).push(e.tick); continue; }
      const starts = open.get(k);
      if (!starts || !starts.length) continue;
      const start = starts.shift();
      const src = format === 0 ? `c${e.ch}` : `t${ti}`;
      if (!sources.has(src)) sources.set(src, { name: format === 0 ? `Channel ${e.ch + 1}` : names[ti], notes: [] });
      sources.get(src).notes.push({ start: q(start), end: q(e.tick), midi: e.note });
    }
    let hanging = 0;
    open.forEach((v) => (hanging += v.length));
    if (hanging) report.count("Notes without a note-off skipped", hanging);
  });

  const L = barCapacity(time);
  const score = { title: fileName.replace(/\.[^.]+$/, "") || "Untitled", composer: "", tempo,
    measures: [{ key, time }], staves: [] };
  let n = 0;
  for (const src of sources.values()) {
    n++;
    const notes = src.notes.map((x) => ({ ...x, end: Math.max(x.end, x.start + GRID) }));
    if (!notes.length) continue;
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    // one line of chords: group by start; a group's end is its shortest note, clipped to the next group
    const groups = [];
    for (const x of notes) {
      const g = groups[groups.length - 1];
      if (g && g.start === x.start) { g.midis.add(x.midi); g.end = Math.min(g.end, x.end); g.max = Math.max(g.max, x.end); }
      else groups.push({ start: x.start, end: x.end, max: x.end, midis: new Set([x.midi]) });
    }
    let cut = 0;
    groups.forEach((g, i) => {
      const next = groups[i + 1];
      if (next && g.end > next.start) { g.end = next.start; cut++; }
      else if (g.max > g.end) cut++;
    });
    if (cut) report.count("Overlapping notes shortened to fit one voice", cut);

    const staff = { name: src.name || `Track ${n}`, clef: "treble", brace: false, bars: [] };
    const pitchesOf = (g) => [...g.midis].sort((a, b) => a - b).map((m) => spellMidi(m, key));
    const emit = (a, b, pitches) => {
      // split [a,b) at barlines, then into note values; tie all note pieces together
      const pieces = [];
      while (a < b) {
        const barEnd = (Math.floor(a / L) + 1) * L;
        const segEnd = Math.min(b, barEnd);
        for (const d of splitTicks(segEnd - a)) pieces.push({ bar: Math.floor(a / L), d });
        a = segEnd;
      }
      pieces.forEach((p, i) => {
        while (staff.bars.length <= p.bar) staff.bars.push([]);
        staff.bars[p.bar].push({ dur: p.d.dur, dots: p.d.dots, tie: !!pitches && i < pieces.length - 1,
          pitches: pitches ? pitches.map((x) => ({ ...x })) : [] });
      });
    };
    let cursor = 0;
    let sum = 0, cnt = 0;
    for (const g of groups) {
      if (g.start > cursor) emit(cursor, g.start, null);
      emit(g.start, g.end, pitchesOf(g));
      cursor = g.end;
      g.midis.forEach((m) => { sum += m; cnt++; });
    }
    if (cnt && sum / cnt < 60) staff.clef = "bass";
    score.staves.push(staff);
  }
  if (!score.staves.length) throw new Error("This MIDI file has no notes Coda can show.");
  const bars = Math.max(...score.staves.map((s) => s.bars.length));
  while (score.measures.length < bars) score.measures.push({});
  padBars(score);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}
