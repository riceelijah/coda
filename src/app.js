// Coda — UI wiring. Phase 1: render the demo score.
import { render } from "./render.js";
import { demoScore } from "./demo.js";
import { newScore } from "./model.js";

const score = new URLSearchParams(location.search).has("demo") ? demoScore() : newScore();
const sheet = document.getElementById("sheet");
const hit = render(score, sheet, null);
if (hit.errors.length) console.warn(hit.errors);
window.coda = { score, hit };
