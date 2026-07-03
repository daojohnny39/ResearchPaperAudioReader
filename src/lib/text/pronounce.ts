// Spoken-text normalization (PLAN-adjacent helper). Converts dotted *filename*
// tokens so the intra-filename "." is spoken aloud: "CLAUDE.md" -> "CLAUDE dot md".
// Applied ONLY to text handed to the TTS engines in the player controller; it
// MUST NOT touch Segment.text (the displayed/sidebar string and its stable
// charStart/charEnd offsets that drive highlight + click-to-read).

// Known file extensions whose preceding "." should be spoken as "dot". Tokens
// whose final segment is NOT one of these (decimals like "3.14", abbreviations
// like "e.g.", domains like "github.com") are left untouched so they read naturally.
const FILE_EXT =
  /^(md|markdown|mdx|txt|rst|py|js|mjs|cjs|jsx|ts|tsx|json|jsonl|yaml|yml|toml|cfg|conf|ini|env|lock|sh|bash|zsh|rs|go|rb|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|css|scss|less|html|htm|xml|svg|csv|tsv|pdf|png|jpg|jpeg|gif|webp|log|sql|ipynb)$/i;

// A dotted token: alphanumeric/underscore/hyphen runs joined by ".", >= 1 dot.
const DOTTED_TOKEN = /[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;

/**
 * Speak intra-filename dots: "CLAUDE.md" -> "CLAUDE dot md",
 * "config.test.json" -> "config dot test dot json". A token is only rewritten
 * when its FINAL segment is a known file extension; everything else (decimals,
 * "e.g.", "github.com", version strings) is returned unchanged. Spoken-text only.
 */
export function normalizeForSpeech(text: string): string {
  let out = text;
  // "pp" disambiguation (spoken-text only). Pages forms (which REQUIRE the "."
  // plus page numbers) run FIRST so a reference citation like "pp. 712-721"
  // becomes "pages 712 to 721" and never "percentage points". Then the numeric
  // percentage-point form ("3.5 pp", "+2pp", "5 pp") -> "N percentage points".
  out = out
    .replace(/\bpp\.\s*(\d+)\s*[–—-]\s*(\d+)/gi, "pages $1 to $2")
    .replace(/\bpp\.\s*(\d+)/gi, "pages $1")
    .replace(/(\d+(?:\.\d+)?)\s*pp\b/gi, "$1 percentage points");
  // Speak intra-filename dots (existing behavior): "CLAUDE.md" -> "CLAUDE dot md".
  out = out.replace(DOTTED_TOKEN, (tok) => {
    const parts = tok.split(".");
    const ext = parts[parts.length - 1];
    if (!FILE_EXT.test(ext)) return tok;
    return parts.join(" dot ");
  });
  return out;
}
