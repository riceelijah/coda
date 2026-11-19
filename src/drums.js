// General MIDI drums (DESIGN §27): number -> name, default staff position, notehead.
// Positions follow MuseScore's drum kits: `line` counts half-spaces down from the top line (F5).
// Heads: "" normal, "x", "cx" (circled x), "d" (diamond), "t" (triangle). Pure data, no DOM.

const ROWS = [
  [35, "Bass Drum 2", 8, ""], [36, "Bass Drum", 7, ""], [37, "Side Stick", 3, "x"], [38, "Snare", 3, ""],
  [39, "Hand Clap", 4, "x"], [40, "Electric Snare", 3, ""], [41, "Low Floor Tom", 6, ""], [42, "Closed Hi-Hat", -1, "x"],
  [43, "High Floor Tom", 5, ""], [44, "Pedal Hi-Hat", 9, "x"], [45, "Low Tom", 4, ""], [46, "Open Hi-Hat", -1, "cx"],
  [47, "Low-Mid Tom", 2, ""], [48, "High-Mid Tom", 2, ""], [49, "Crash Cymbal", -2, "x"], [50, "High Tom", 1, ""],
  [51, "Ride Cymbal", 0, "x"], [52, "China Cymbal", -3, "cx"], [53, "Ride Bell", 0, "d"], [54, "Tambourine", 6, "d"],
  [55, "Splash Cymbal", -4, "x"], [56, "Cowbell", 0, "t"], [57, "Crash Cymbal 2", -3, "x"], [58, "Vibraslap", 1, "t"],
  [59, "Ride Cymbal 2", -2, "cx"], [60, "High Bongo", -1, ""], [61, "Low Bongo", 0, ""], [62, "Mute High Conga", 1, "x"],
  [63, "Open High Conga", 1, ""], [64, "Low Conga", 2, ""], [65, "High Timbale", 5, ""], [66, "Low Timbale", 7, ""],
  [67, "High Agogô", -2, "t"], [68, "Low Agogô", -1, "t"], [69, "Cabasa", 2, "d"], [70, "Maracas", 4, "d"],
  [71, "Short Whistle", -3, ""], [72, "Long Whistle", -4, ""], [73, "Short Güiro", -1, "x"], [74, "Long Güiro", -2, ""],
  [75, "Claves", 0, ""], [76, "High Wood Block", 5, "t"], [77, "Low Wood Block", 7, "t"], [78, "Mute Cuíca", 8, "x"],
  [79, "Open Cuíca", 8, ""], [80, "Mute Triangle", -3, "t"], [81, "Open Triangle", -4, "t"],
];
const TOP = 5 * 7 + 3; // F5 as a diatonic number (oct*7 + step)
export const DRUMS = new Map(ROWS.map(([n, name, line, head]) => {
  const d = TOP - line;
  return [n, { n, name, step: d % 7, oct: Math.floor(d / 7), head }];
}));
export const isDrum = (n) => DRUMS.has(n);
export const drumName = (n) => DRUMS.get(n)?.name || `Drum ${n}`;
// The pitch (staff position) a drum is written at by default.
export const drumPitch = (n) => { const d = DRUMS.get(n); return { step: d.step, oct: d.oct, alter: 0, drum: n }; };

// What a click or a typed letter at each position enters, bottom to top (DESIGN §27).
const ENTRY = [44, 35, 36, 41, 43, 45, 38, 47, 50, 51, 42, 49, 57, 55];
const dia = (p) => p.oct * 7 + p.step;
// The entry drum nearest a staff position: {step, oct, alter: 0, drum}.
export function drumNear(p) {
  const n = ENTRY.reduce((best, k) => (Math.abs(dia(drumPitch(k)) - dia(p)) < Math.abs(dia(drumPitch(best)) - dia(p)) ? k : best));
  return drumPitch(n);
}
// The entry drum dir (+1/-1) positions above/below p, or null past the ends.
export function drumStep(p, dir) {
  const at = dia(p), xs = ENTRY.map((k) => [dia(drumPitch(k)), k]).filter(([d]) => (dir > 0 ? d > at : d < at));
  if (!xs.length) return null;
  const [, k] = xs.reduce((a, b) => (dir > 0 ? (b[0] < a[0] ? b : a) : (b[0] > a[0] ? b : a)));
  return drumPitch(k);
}
