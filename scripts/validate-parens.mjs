// Unit test for the stripParentheticals paren-blanking guard in
// src/lib/text/segment.ts (blankBalancedParens). PDF-INDEPENDENT: drives the real
// segment() with a synthetic mock CharMap so it runs anywhere. This is the
// regression guard for the Figure-2 fix — validate-extract.mjs does NOT pass
// stripParentheticals, so it never exercises this path. A long or newline-crossing
// balanced (...) span (a mis-paired caption opener whose closer was dropped with the
// skipped figure graphic) must NOT be blanked, or it collapses a whole column into
// one giant segment (half-page highlight + skipped narration).
//
//   node scripts/validate-parens.mjs

import { segment } from "../src/lib/text/segment.ts";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// Minimal CharMap stub: segment() only needs text, offsetToPage, rangeToBBoxes.
const mockMap = (text) => ({
  text,
  offsetToPage: () => 1,
  rangeToBBoxes: () => [],
});

const segsOf = (text) => segment(mockMap(text), { stripParentheticals: true });
const speak = (text) => segsOf(text).map((s) => s.text).join("  ");

// 1. A short aside IS blanked (narrator reads straight through, not spoken).
{
  const spoken = speak("The result was good (see Fig. 2) overall.");
  ok(!/see Fig/.test(spoken), `short aside blanked: ${JSON.stringify(spoken)}`);
}

// 2a. Balanced span of length 200 (<= cap) IS blanked.
{
  const t = "Pre. (" + "z".repeat(198) + ") Post."; // span "(" + 198z + ")" = 200
  ok(!/z/.test(speak(t)), "200-char aside blanked (boundary <=200)");
}
// 2b. Balanced span of length 201 (> cap) is NOT blanked.
{
  const t = "Pre. (" + "z".repeat(199) + ") Post."; // span = 201
  ok(/zzz/.test(speak(t)), "201-char span NOT blanked (boundary >200)");
}

// 3. A balanced span CONTAINING a newline is NOT blanked (the runaway shape).
{
  const t = "Left one. Two. (open aside \n more text in next column. Final.) tail.";
  ok(/more text in next column/.test(speak(t)), "newline-crossing span NOT blanked");
}

// 4. Nested: inner short aside still blanks even when the outer span is rejected.
{
  const t = "X. (" + "y".repeat(210) + " (tiny) " + "z".repeat(10) + ") W.";
  const spoken = speak(t);
  ok(
    !/tiny/.test(spoken) && /yyy/.test(spoken),
    "nested: inner aside blanked, oversized outer left intact",
  );
}

// 5. Multiple short asides on one line each blank independently.
{
  const spoken = speak("Foo (one) bar (two) baz (three) end.");
  ok(
    !/one|two|three/.test(spoken) && /Foo/.test(spoken) && /end/.test(spoken),
    `multiple short asides all blanked: ${JSON.stringify(spoken)}`,
  );
}

// 6. Figure-2 simulation: caption opener + newline + long span before the next ")".
//    Must NOT collapse — the interior body sentences keep their boundaries.
{
  const t =
    "Figure 2: Left panel (D Right: legend \n " +
    "Body sentence A is here. Body sentence B is here. Body sentence C is here. " +
    "five 6-8B models). However defenses differ.";
  const spoken = speak(t);
  const n = segsOf(t).length;
  ok(
    /Body sentence A/.test(spoken) &&
      /Body sentence B/.test(spoken) &&
      /Body sentence C/.test(spoken),
    "figure runaway NOT collapsed: interior body sentences survive",
  );
  ok(n >= 4, `figure region splits into many sentences (got ${n}, want >=4)`);
}

console.log(`\n${failures ? "FAIL" : "ALL PASS"}: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
