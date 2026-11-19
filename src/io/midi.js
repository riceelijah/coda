// Standard MIDI File import. See docs/DESIGN.md §9.4.
// MIDI holds performance data, not notation, so the result is a transcription.
import { barCapacity, barLen, splitTicks, spellMidi, padBars, noteCount, PPQ, isPerc, attrsAt, tempoAt, setTempo, clampBpm } from "../model.js";
import { isDrum, drumPitch } from "../drums.js";
import { Report } from "./util.js";
import { schedule } from "../play.js";

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
        else if (hi === 0xc0) events.push({ tick, program: d1 & 0x7f, ch });
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
  let extraMeta = false, second = null; // second: the time signature after a pickup
  const names = [], tempos = []; // tempos: [tick, bpm] after the first

  tracks.forEach((evs, ti) => evs.forEach((e) => {
    if (e.meta === undefined) return;
    if (e.meta === 0x51 && e.data.length >= 3) {
      const us = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
      if (tempo === null) tempo = Math.round(60e6 / us); else tempos.push([q(e.tick), 60e6 / us]);
    } else if (e.meta === 0x58 && e.data.length >= 2) {
      const t = [e.data[0], 2 ** e.data[1]];
      if (time === null) time = t;
      else if (e.tick > 0 && !second) second = { at: q(e.tick), t };
      else if (e.tick > 0) extraMeta = true;
    } else if (e.meta === 0x59 && e.data.length >= 1) {
      const sf = e.data[0] > 127 ? e.data[0] - 256 : e.data[0];
      if (key === null) key = Math.max(-7, Math.min(7, sf)); else if (e.tick > 0) extraMeta = true;
    } else if (e.meta === 0x03 && !names[ti]) {
      names[ti] = new TextDecoder("latin1").decode(e.data).trim();
    }
  }));
  if (!time || ![1, 2, 4, 8, 16, 32].includes(time[1]) || time[0] < 1) time = [4, 4];
  // a first time signature one short bar long, then the real one: a pickup (DESIGN §33), as Coda writes it
  let P = 0;
  const okT = (t) => [1, 2, 4, 8, 16, 32].includes(t[1]) && t[0] >= 1;
  if (second && okT(second.t) && second.at === barCapacity(time) && second.at < barCapacity(second.t) && second.at % 60 === 0) { P = second.at; time = second.t; }
  else if (second) extraMeta = true;
  if (extraMeta) report.add("Only the first time signature and key signature were used.");
  key = key ?? 0;
  tempo = Math.max(20, Math.min(400, tempo || 120));

  // collect notes per source (track for format 1, channel for format 0)
  const sources = new Map();
  const programs = new Map(); // first program change per source
  let extraPrograms = 0;
  tracks.forEach((evs, ti) => {
    const open = new Map(); // ch:note -> [start ticks]
    for (const e of evs) {
      if (e.meta !== undefined) continue;
      if (e.program !== undefined) {
        if (e.ch === 9) continue;
        const src = format === 0 ? `c${e.ch}` : `t${ti}`;
        if (!programs.has(src)) programs.set(src, e.program); else extraPrograms++;
        continue;
      }
      if (e.ch === 9 && e.on && !isDrum(e.note)) { report.count("Drums outside the General MIDI kit skipped"); continue; }
      const k = e.ch * 128 + e.note;
      if (e.on) { if (!open.has(k)) open.set(k, []); open.get(k).push(e.tick); continue; }
      const starts = open.get(k);
      if (!starts || !starts.length) continue;
      const start = starts.shift();
      const src = e.ch === 9 ? "drums" : format === 0 ? `c${e.ch}` : `t${ti}`; // every channel-10 note: one drum staff
      if (!sources.has(src)) sources.set(src, { name: e.ch === 9 ? "Drums" : format === 0 ? `Channel ${e.ch + 1}` : names[ti], notes: [] });
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
  for (const [key0, src] of sources) {
    n++;
    const perc = key0 === "drums";
    const notes = src.notes.map((x) => ({ ...x, end: perc ? x.start + PPQ : Math.max(x.end, x.start + GRID) })); // a drum hit lasts to the next one, a beat at most
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
    if (cut && !perc) report.count("Overlapping notes shortened to fit one voice", cut);

    const staff = { name: src.name || `Track ${n}`, clef: perc ? "percussion" : "treble", brace: false, bars: [],
      ...(programs.has(key0) && !perc ? { program: programs.get(key0) } : {}) };
    const pitchesOf = (g) => (perc ? [...g.midis].map(drumPitch).sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step) || a.drum - b.drum)
      : [...g.midis].sort((a, b) => a - b).map((m) => spellMidi(m, key)));
    const emit = (a, b, pitches) => {
      // split [a,b) at barlines, then into note values; tie all note pieces together
      const pieces = [];
      while (a < b) {
        const bar = a < P ? 0 : Math.floor((a - P) / L) + (P ? 1 : 0);
        const barEnd = a < P ? P : P + (Math.floor((a - P) / L) + 1) * L;
        const segEnd = Math.min(b, barEnd);
        for (const d of splitTicks(segEnd - a)) pieces.push({ bar, d });
        a = segEnd;
      }
      pieces.forEach((p, i) => {
        while (staff.bars.length <= p.bar) staff.bars.push([]);
        const on = pitches && (i === 0 || !perc); // a drum hit isn't tied over: the rest of it is rests
        staff.bars[p.bar].push({ dur: p.d.dur, dots: p.d.dots, tie: !!on && !perc && i < pieces.length - 1,
          pitches: on ? pitches.map((x) => ({ ...x })) : [] });
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
    if (cnt && sum / cnt < 60 && !perc) staff.clef = "bass";
    score.staves.push(staff);
  }
  if (extraPrograms) report.count("Instrument changes mid-track (first one used)", extraPrograms);
  if (!score.staves.length) throw new Error("This MIDI file has no notes Coda can show.");
  const bars = Math.max(...score.staves.map((s) => s.bars.length));
  while (score.measures.length < bars) score.measures.push({});
  padBars(score);
  if (P) score.measures[0].len = P;
  // tempo changes (DESIGN §29): one per bar, at its start
  tempos.sort((a, b) => a[0] - b[0]);
  // a dip inside a bar that comes back to the tempo before it by the barline: a held note (Coda
  // writes fermatas this way, DESIGN §34). Counted, not read as the bar's tempo.
  const barEnd = (t) => (t < P ? P : P + (Math.floor((t - P) / L) + 1) * L);
  const kept = [];
  for (let i = 0, prev = tempo; i < tempos.length; i++) {
    const [t, bpm] = tempos[i], nx = tempos[i + 1];
    if (t !== barEnd(t) - L && t !== 0 && nx && nx[0] <= barEnd(t) && Math.round(nx[1]) === Math.round(prev) && bpm < prev) {
      report.count("Held notes (short tempo dips inside a bar) played at the bar's tempo");
      i++; continue;
    }
    kept.push(tempos[i]); prev = bpm;
  }
  const seen = new Set([0]); // bar 1 has the first tempo
  for (const [t, bpm] of kept) {
    const b = t < P ? 0 : Math.floor((t - P) / L) + (P ? 1 : 0);
    if (b < score.measures.length && clampBpm(bpm) === tempoAt(score, b)) continue; // the same again, e.g. in another track
    if (b >= score.measures.length || seen.has(b)) { report.count("Tempo changes skipped (one per bar is kept)"); continue; }
    seen.add(b);
    if (t % L) report.count("Tempo changes inside a bar moved to the bar's start");
    setTempo(score, b, clampBpm(bpm));
  }
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

// ---------- export (DESIGN §19) ----------
// Format 1: a conductor track (tempo, time and key at the bars where they change), then one track
// per staff with its name and instrument. MIDI is performance data: marks, spellings and the
// split into layers are not kept.
export function exportMIDI(score) {
  const { notes, barStart, fermatas } = schedule(score);
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const track = (evs) => { // evs: [{tick, bytes}], sorted
    const out = [];
    let last = 0;
    for (const e of evs) { out.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    out.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, out.length >>> 24, (out.length >> 16) & 255, (out.length >> 8) & 255, out.length & 255, ...out];
  };
  const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
  const text = (s) => [...String(s)].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63)); // latin1, else "?"

  const cond = [];
  if (score.title) cond.push({ tick: 0, bytes: meta(0x03, text(score.title)) });
  let was = null, bpm = 0; // bars play unrolled (DESIGN §28): after a repeat the key, time or tempo may differ with no change marked
  for (const { bar, tick } of barStart) {
    const a = attrsAt(score, bar), tp = tempoAt(score, bar);
    if (tp !== bpm) { const us = Math.round(60000000 / tp); cond.push({ tick, bytes: meta(0x51, [us >> 16, (us >> 8) & 255, us & 255]) }); bpm = tp; }
    // a short bar (DESIGN §33) gets a time signature of its own length, e.g. 1/4 for a one-beat pickup
    const len = barLen(score, bar);
    let ts = a.time;
    if (len < barCapacity(a.time)) { let d = a.time[1]; while ((len * d) % 1920 && d < 32) d *= 2; ts = [(len * d) / 1920, d]; }
    if (!was || ts.join() !== was.ts.join()) cond.push({ tick, bytes: meta(0x58, [ts[0], Math.log2(ts[1]), 24, 8]) });
    if (!was || a.key !== was.key) cond.push({ tick, bytes: meta(0x59, [a.key & 255, 0]) });
    was = { ...a, ts };
  }
  // fermatas (DESIGN §34): half the tempo while the held note lasts
  const tempoAtTick = (t) => { let b = barStart[0]; for (const x of barStart) { if (x.tick > t) break; b = x; } return tempoAt(score, b.bar); };
  const usOf = (bpm) => { const us = Math.round(60000000 / bpm); return meta(0x51, [us >> 16, (us >> 8) & 255, us & 255]); };
  for (const [f, l] of [...fermatas].sort((a, b) => a[0] - b[0])) {
    cond.push({ tick: f, bytes: usOf(tempoAtTick(f) / 2) }, { tick: f + l, bytes: usOf(tempoAtTick(f + l)) });
  }
  cond.sort((a, b) => a.tick - b.tick);
  const tracks = [track(cond)];
  score.staves.forEach((st, s) => {
    const perc = isPerc(st), ch = perc ? 9 : s % 15 < 9 ? s % 15 : s % 15 + 1; // drums on channel 10 (DESIGN §27); others skip it
    const evs = [{ tick: 0, bytes: meta(0x03, text(st.name || `Staff ${s + 1}`)) }, ...(perc ? [] : [{ tick: 0, bytes: [0xc0 | ch, st.program ?? 0] }])];
    const ons = [];
    for (const n of notes) if (n.staff === s) {
      ons.push({ tick: n.start, on: 1, bytes: [0x90 | ch, n.midi, n.vel ?? 80] }, { tick: n.end, on: 0, bytes: [0x80 | ch, n.midi, 0] });
    }
    ons.sort((a, b) => a.tick - b.tick || a.on - b.on); // note-offs first at equal ticks
    tracks.push(track(evs.concat(ons)));
  });
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, tracks.length >> 8, tracks.length & 255, PPQ >> 8, PPQ & 255];
  return new Uint8Array(head.concat(...tracks));
}
