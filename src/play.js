// Coda playback with WebAudio oscillators. See docs/DESIGN.md §7.
import { attrsAt, barCapacity, eventTicks, midi, PPQ } from "./model.js";

let ctx = null;
let current = null;

// Flatten the score into notes and bar start times, starting at bar `from`.
export function schedule(score, from = 0) {
  const barStart = [];
  let t = 0;
  for (let b = from; b < score.measures.length; b++) {
    barStart.push({ bar: b, tick: t });
    t += barCapacity(attrsAt(score, b).time);
  }
  const total = t;
  const notes = [];
  score.staves.forEach((st) => {
    const open = new Map(); // midi -> note awaiting a tie continuation
    barStart.forEach(({ bar, tick }) => {
      let at = tick;
      for (const ev of st.bars[bar]) {
        const len = eventTicks(ev);
        const nextOpen = new Map();
        for (const p of ev.pitches) {
          const m = midi(p);
          let n = open.get(m);
          if (n && n.end === at) n.end = at + len;
          else { n = { start: at, end: at + len, midi: m }; notes.push(n); }
          if (ev.tie) nextOpen.set(m, n);
        }
        open.clear();
        nextOpen.forEach((v, k) => open.set(k, v));
        at += len;
      }
    });
  });
  return { notes, barStart, total };
}

export function isPlaying() { return !!current; }

// One triangle-wave note into `dest`.
function voice(dest, m, start, len) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.15, start + 0.01);
  g.gain.setValueAtTime(0.15, start + len - 0.05);
  g.gain.linearRampToValueAtTime(0, start + len);
  osc.connect(g).connect(dest);
  osc.start(start);
  osc.stop(start + len + 0.02);
}

// Sound a chord briefly while editing (DESIGN §11.2). Silent during playback.
export function audition(midis) {
  if (current || !midis.length) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime + 0.02;
    for (const m of midis) voice(ctx.destination, m, t, 0.35);
  } catch { /* audio unavailable: editing still works */ }
}

// Start playback. `onBar(barIndex|null)` is called as each bar starts, and with null at the end.
export async function play(score, from, onBar) {
  stop();
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  const { notes, barStart, total } = schedule(score, from);
  const secPerTick = 60 / (score.tempo || 100) / PPQ;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.1;
  // ponytail: schedules every note up front; fine for a few thousand notes. Switch to a
  // look-ahead scheduler if long scores stutter.
  for (const n of notes) {
    const start = t0 + n.start * secPerTick;
    const len = Math.max(0.06, (n.end - n.start) * secPerTick);
    voice(master, n.midi, start, len);
  }
  const me = { master, raf: 0, lastBar: -1 };
  current = me;
  const tick = () => {
    if (current !== me) return;
    const now = (ctx.currentTime - t0) / secPerTick;
    if (now >= total) { stop(); onBar(null); return; }
    let bar = barStart[0].bar;
    for (const b of barStart) if (b.tick <= now) bar = b.bar;
    if (bar !== me.lastBar) { me.lastBar = bar; onBar(bar); }
    me.raf = requestAnimationFrame(tick);
  };
  me.raf = requestAnimationFrame(tick);
}

export function stop() {
  if (!current) return;
  cancelAnimationFrame(current.raf);
  try { current.master.disconnect(); } catch { /* already gone */ }
  current = null;
}
