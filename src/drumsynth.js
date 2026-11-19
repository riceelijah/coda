// Synthesized General MIDI drums (DESIGN §27): no samples, so they work offline and in audio export.
// Each drum is a pitched tone and/or filtered noise with its own decay. Families share settings.

// tone: [type, start Hz, end Hz, decay s, level]; noise: [filter, Hz, Q, decay s, level]; am: Hz (rattle)
const KICK = (f) => ({ tone: ["sine", f * 3, f, 0.35, 1.4], noise: ["lowpass", 900, 1, 0.02, 0.5] });
const TOM = (f, d = 0.4) => ({ tone: ["sine", f * 1.6, f, d, 1], noise: ["bandpass", f * 4, 1, 0.05, 0.25] });
const HAND = (f, d = 0.25) => ({ tone: ["sine", f * 1.2, f, d, 0.8], noise: ["bandpass", f * 6, 2, 0.03, 0.3] });
const HAT = (d) => ({ noise: ["highpass", 7000, 0.7, d, 0.7] });
const CYM = (hz, d) => ({ noise: ["highpass", hz, 0.5, d, 0.6], tone: ["square", 520, 520, d * 0.4, 0.06] });
const BELL = (f, d) => ({ tone: ["square", f, f, d, 0.25], noise: ["bandpass", f * 2, 4, d * 0.5, 0.15] });
const WOOD = (f) => ({ tone: ["sine", f, f * 0.95, 0.06, 0.9], noise: ["bandpass", f * 2, 5, 0.02, 0.3] });
const SHAKE = (d, hz = 6000) => ({ noise: ["highpass", hz, 0.8, d, 0.5] });
const KIT = {
  35: KICK(50), 36: KICK(55), 37: { noise: ["bandpass", 1800, 3, 0.05, 1] , tone: ["triangle", 400, 380, 0.04, 0.5] },
  38: { tone: ["triangle", 200, 170, 0.12, 0.6], noise: ["bandpass", 2500, 0.8, 0.2, 0.9] },
  39: { noise: ["bandpass", 1300, 1.5, 0.15, 1], am: 90 },
  40: { tone: ["triangle", 230, 190, 0.1, 0.5], noise: ["highpass", 2000, 0.7, 0.18, 0.8] },
  41: TOM(80, 0.5), 43: TOM(95, 0.5), 45: TOM(115), 47: TOM(135), 48: TOM(155), 50: TOM(180, 0.35),
  42: HAT(0.06), 44: HAT(0.09), 46: HAT(0.45), 49: CYM(5000, 1.6), 51: CYM(7000, 0.8), 52: CYM(3500, 1.3),
  53: BELL(780, 0.9), 54: { noise: ["highpass", 8000, 0.7, 0.25, 0.6], am: 25 }, 55: CYM(6000, 0.7), 56: BELL(560, 0.3),
  57: CYM(4500, 1.8), 58: { noise: ["bandpass", 3000, 2, 0.7, 0.7], am: 30 }, 59: CYM(8000, 0.9),
  60: HAND(420, 0.15), 61: HAND(300, 0.2), 62: HAND(330, 0.08), 63: HAND(330), 64: HAND(240),
  65: TOM(400, 0.3), 66: TOM(280, 0.35), 67: BELL(920, 0.25), 68: BELL(690, 0.25), 69: SHAKE(0.1), 70: SHAKE(0.06, 7000),
  71: { tone: ["sine", 2400, 2300, 0.15, 0.5] }, 72: { tone: ["sine", 2400, 2300, 0.6, 0.5] },
  73: { noise: ["bandpass", 3500, 2, 0.12, 0.8], am: 40 }, 74: { noise: ["bandpass", 3500, 2, 0.4, 0.8], am: 30 },
  75: WOOD(2500), 76: WOOD(1100), 77: WOOD(800), 78: { tone: ["sine", 700, 500, 0.12, 0.6] }, 79: { tone: ["sine", 400, 700, 0.3, 0.6] },
  80: { tone: ["sine", 4200, 4200, 0.12, 0.25] }, 81: { tone: ["sine", 4200, 4200, 1.4, 0.25] },
};

const noiseFor = new WeakMap(); // context -> 1 s of white noise
function noise(c) {
  if (!noiseFor.has(c)) {
    const b = c.createBuffer(1, c.sampleRate, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseFor.set(c, b);
  }
  return noiseFor.get(c);
}

// One hit of drum n into `dest` at `start`; level 1 = mf. The length of the written note doesn't matter.
export function drumHit(c, dest, n, start, level = 1) {
  const k = KIT[n] || TOM(200);
  const out = c.createGain();
  out.gain.value = 0.35 * level;
  out.connect(dest);
  const env = (node, decay, peak) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    let src = node;
    if (k.am) { // a rattle: a wobbling stage before the envelope, so the wobble fades with it
      const lfo = c.createOscillator(), depth = c.createGain(), wob = c.createGain();
      lfo.frequency.value = k.am; depth.gain.value = 0.7; wob.gain.value = 0.7; // 0.7 ± 0.7: from silent to a little louder
      lfo.connect(depth).connect(wob.gain);
      lfo.start(start); lfo.stop(start + decay + 0.05);
      src = node.connect(wob);
    }
    src.connect(g).connect(out);
    return decay;
  };
  if (k.tone) {
    const [type, f0, f1, decay, peak] = k.tone, o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, start);
    o.frequency.exponentialRampToValueAtTime(f1, start + Math.min(decay, 0.15));
    env(o, decay, peak);
    o.start(start); o.stop(start + decay + 0.05);
  }
  if (k.noise) {
    const [type, hz, q, decay, peak] = k.noise, src = c.createBufferSource(), f = c.createBiquadFilter();
    src.buffer = noise(c); src.loop = true;
    f.type = type; f.frequency.value = hz; f.Q.value = q;
    src.connect(f);
    env(f, decay, peak);
    src.start(start); src.stop(start + decay + 0.05);
  }
}
