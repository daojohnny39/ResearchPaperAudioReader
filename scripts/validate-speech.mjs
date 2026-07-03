// Unit checks for normalizeForSpeech() — pp disambiguation + filename dots.
// Imports the REAL function (no mock) via Node's TS strip-types loader:
//   node --experimental-strip-types scripts/validate-speech.mjs
import { normalizeForSpeech } from "../src/lib/text/pronounce.ts";

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("ok:  ", msg); }
};
const eq = (got, want, msg) =>
  ok(got === want, msg + "  (got: " + JSON.stringify(got) + ")");

// Pages citations (the forms that actually occur in the target paper).
eq(normalizeForSpeech("see pp. 712–721 for"), "see pages 712 to 721 for", "pp. en-dash range -> pages");
eq(normalizeForSpeech("pp. 202–212."), "pages 202 to 212.", "pp. range, trailing dot");
eq(normalizeForSpeech("2018, pp. 7167–7177."), "2018, pages 7167 to 7177.", "pp. large range");
ok(!/percentage/.test(normalizeForSpeech("pp. 712–721")), "page citation never becomes percentage");
// Percentage-point measurements.
eq(normalizeForSpeech("trades 3.5 pp of TPR"), "trades 3.5 percentage points of TPR", "N.N pp -> percentage points");
eq(normalizeForSpeech("+2pp"), "+2 percentage points", "+2pp -> percentage points");
eq(normalizeForSpeech("up 5 pp"), "up 5 percentage points", "5 pp -> percentage points");
// No false positives on words containing "pp".
eq(normalizeForSpeech("application supplementary happening"), "application supplementary happening", "internal pp untouched");
// Existing filename behavior must survive.
eq(normalizeForSpeech("read CLAUDE.md now"), "read CLAUDE dot md now", "filename dot preserved");
// Idempotent.
const once = normalizeForSpeech("pp. 1–2 and 3 pp");
eq(normalizeForSpeech(once), once, "idempotent");

if (failures) { console.error("\n" + failures + " assertion(s) failed"); process.exit(1); }
console.log("\nall speech-normalization checks passed");
