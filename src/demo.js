// Demo score used by `?demo` and by the rendering checks in docs/PLAN.md Phase 1.
const P = (name) => {
  // "F#5" -> {step, oct, alter}
  const m = /^([A-G])(#{1,2}|b{1,2}|n)?(-?\d)$/.exec(name);
  const alter = !m[2] || m[2] === "n" ? 0 : m[2][0] === "#" ? m[2].length : -m[2].length;
  return { step: "CDEFGAB".indexOf(m[1]), oct: +m[3], alter };
};
const n = (dur, names, opts = {}) => ({
  dur, dots: opts.dots || 0, tie: !!opts.tie,
  pitches: names ? names.split(" ").map(P) : [],
  ...(opts.tup ? { tup: opts.tup } : {}),
});
const r = (dur, dots = 0) => n(dur, null, { dots });

export function demoScore() {
  const rh = [
    [n("q", "D5"), n("q", "F#5"), n("q", "A5")],
    [n("8", "A5"), n("8", "G5"), n("8", "F#5"), n("8", "E5"), n("q", "D5")],
    [n("h", "D4 F#4 A4", { dots: 1 })],
    [n("q", "D5", { tie: true }), n("q", "D5"), r("q")],                    // tie within a bar
    [n("q", "E5", { dots: 1 }), n("8", "F#5"), n("q", "G5", { tie: true })], // tie across a barline
    [n("q", "G5"), n("16", "A5"), n("16", "B5"), n("16", "C#6"), n("16", "D6"), n("q", "Fn5")],
    [],                                                                      // empty bar
    [n("q", "E5")],                                                          // underfull
    [n("h", "A5"), n("h", "B5")],                                            // overfull
    [n("q", "G5"), n("q", "F#5"), n("q", "E5")],                             // key change (G)
    [n("8", "E5", { tup: [3, 2] }), n("8", "F#5", { tup: [3, 2] }), n("8", "G5", { tup: [3, 2] }),
      n("q", "A5"), n("h", "B5")],                                           // time change (4/4) + triplet
  ];
  const lh = [
    [n("h", "D3", { dots: 1 })],
    [n("q", "D3"), n("q", "A2"), n("q", "F#2")],
    [n("h", "D3 A3", { dots: 1 })],
    [n("h", "D3 A3", { dots: 1 })],
    [n("q", "A2"), n("q", "C#3"), n("q", "E3")],
    [n("h", "G2 D3", { dots: 1 })],
    [],
    [n("h", "A2 E3", { dots: 1 })],
    [n("h", "D3", { dots: 1 })],
    [n("q", "G2"), r("q"), n("q", "D3")],
    [n("w", "G2 D3")],
  ];
  // bars 11..21: whole notes tied bar to bar, so at least one tie crosses a system break
  const line = ["B4", "C5", "D5", "D5", "E5", "E5", "D5", "C5", "B4", "A4", "G4"];
  line.forEach((p, i) => {
    rh.push([n("w", p, { tie: line[i + 1] === p })]);
    lh.push([n("h", "G2 D3"), n("h", i % 2 ? "B2 D3" : "G2 D3")]);
  });
  const N = rh.length;
  const measures = Array.from({ length: N }, () => ({}));
  measures[0] = { key: 2, time: [3, 4] };
  measures[9] = { key: 1 };
  measures[10] = { time: [4, 4] };
  return {
    title: "Demo in D", composer: "Coda", tempo: 100, measures,
    staves: [
      { name: "Piano", clef: "treble", brace: true, bars: rh },
      { name: "Piano", clef: "bass", brace: false, bars: lh },
    ],
  };
}
