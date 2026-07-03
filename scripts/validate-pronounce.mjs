// Unit checks for normalizeForSpeech (the spoken-dot filename fix).
//   node --experimental-strip-types scripts/validate-pronounce.mjs
// Asserts real filenames from the steganography paper gain a spoken "dot" while
// decimals / abbreviations / domains stay untouched.

import { normalizeForSpeech } from "../src/lib/text/pronounce.ts";

let failures = 0;
const eq = (input, expected) => {
  const got = normalizeForSpeech(input);
  const pass = got === expected;
  console.log(
    pass
      ? "PASS  " + JSON.stringify(input) + " -> " + JSON.stringify(got)
      : "FAIL  " + JSON.stringify(input) + " -> " + JSON.stringify(got) +
        "  (expected " + JSON.stringify(expected) + ")",
  );
  if (!pass) failures++;
};

// Core goal + real filenames present in the paper.
eq("Read CLAUDE.md now.", "Read CLAUDE dot md now.");
eq("files (AGENTS.md, CLAUDE.md, .cursorrules)", "files (AGENTS dot md, CLAUDE dot md, .cursorrules)");
eq("see token_tracker.py and prov_check.py", "see token_tracker dot py and prov_check dot py");
eq("requirements.txt", "requirements dot txt");
eq("pyproject.toml", "pyproject dot toml");
eq("__init__.py", "__init__ dot py");
eq("appendix/agents-evolved.md", "appendix/agents-evolved dot md");
eq("config.test.json", "config dot test dot json");
eq("CHANGELOG.md.", "CHANGELOG dot md.");

// Must NOT change (false-positive guards).
eq("convention files e.g., AGENTS.md.", "convention files e.g., AGENTS dot md.");
eq("i.e. this", "i.e. this");
eq("Google Gemini 3.1 Pro", "Google Gemini 3.1 Pro");
eq("Sonnet 4.6 and Opus 4.7", "Sonnet 4.6 and Opus 4.7");
eq("see github.com here", "see github.com here");
eq("arxiv.org/abs", "arxiv.org/abs");
eq("value is 0.9 here", "value is 0.9 here");

console.log("\n" + (failures === 0 ? "ALL PRONOUNCE CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
