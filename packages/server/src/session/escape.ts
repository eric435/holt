/**
 * Markdown escaping for user-provided text (page titles, URLs, notes,
 * transcripts).
 *
 * Threat (docs/SECURITY.md, "Markdown injection"): a web page controls its
 * own <title> and URL. Without escaping, a title like
 * `](http://evil.example) ![x](http://evil.example/pixel.png` would close our
 * link early and inject a link or tracking image into your notes.
 *
 * Approach: targeted backslash escapes, not a full markdown sanitizer.
 *  - `[` `]`: the building blocks of links and images. With brackets
 *    escaped, `](http://evil)` is inert, so parentheses are left alone.
 *    Backticks are left alone too: an inline code span cannot inject a link
 *    or image, and developers want to write `code` in their notes.
 *  - `<` `>`: raw HTML (`<img src=...>`), autolinks (`<http://...>`) and,
 *    at line start, blockquotes.
 *  - Leading `#` on a line: would start a heading in the middle of the
 *    notes.
 *  - Leading ``` or ~~~: would open a code fence that never closes,
 *    swallowing every later entry into one code block. Escaping the first
 *    character is enough; inline code spans elsewhere stay usable.
 *  - A line made only of `=`, `-`, `*`, `_` and spaces: depending on
 *    context it turns the line above into a heading (`===`, `---`) or draws
 *    a horizontal rule (`***`, `- - -`). The first such character is
 *    escaped. A list item like `- buy milk` has other text and is left alone.
 *  - Backslash itself, first, so input like `\]` cannot cancel our escape.
 *
 * Invisible and bidirectional-override characters (U+200B-200F, U+202A-202E,
 * U+2066-2069, U+FEFF) are removed: they can make text display differently
 * from what it contains ("Trojan Source"), e.g. a URL that reads one way and
 * points another. Removing U+200D (zero-width joiner) also splits combined
 * emoji like family emoji into their parts; an acceptable cost.
 * Emphasis characters (`*`, `_`) are left alone: the worst they can do is
 * make text bold, and escaping them makes notes much harder to read raw.
 *
 * URLs used as link *destinations* are handled separately by `safeUrl`.
 */

// C0 control characters except tab and newline, plus DEL: they have no
// business in notes and can corrupt terminals or editors that display them.
// Plus the invisible/bidi characters described above.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPECIAL = /[\\[\]<>]/g;

/** Escape text that must stay on one line (titles, link text). Newlines become spaces. */
export function escapeInline(text: string): string {
  const oneLine = text.replace(/\r\n?|\n/g, " ").replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  return escapeLine(oneLine);
}

/** Escape multi-line text, keeping its line breaks (and so its paragraphs). */
export function escapeBlock(text: string): string {
  return splitLines(text).map(escapeLine).join("\n");
}

/**
 * Render text as the body of a `- ` list item, escaping every line. Lines
 * after the first are indented two spaces so they stay inside the item, and
 * a blank line in the middle is followed by an indented one, so it cannot
 * end the item and let the rest of the note escape into the document.
 * Leading and trailing blank lines are dropped, and so is the first line's
 * indentation (it would turn the item into a code block).
 */
export function listItemBody(text: string): string {
  const lines = escapeBlock(text.replace(/^(\s*\n)+/, "")).split("\n");
  return lines
    .map((line, i) => {
      if (i === 0) return line.trim();
      const trimmed = line.trimEnd();
      return trimmed === "" ? "" : `  ${trimmed}`;
    })
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Return a URL that is safe to use as a markdown link destination, or null
 * if it should not be linked at all.
 *
 * Only http(s) is linked: `javascript:`, `data:` and friends are rendered as
 * plain text by the caller. Characters that could end the destination early
 * (`)`, `>`, whitespace, ...) are percent-encoded, which browsers treat as
 * the same URL.
 */
export function safeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href.replace(/[\s()[\]<>\\`"']/g, (c) => {
    return `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

function escapeLine(line: string): string {
  return line
    .replace(CONTROL_CHARS, "")
    .replace(SPECIAL, (c) => `\\${c}`)
    .replace(/^(\s*)#/, "$1\\#")
    .replace(/^(\s*)(```|~~~)/, "$1\\$2")
    .replace(/^(\s*)([=*_-])([=*_ \t-]*)$/, "$1\\$2$3");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}
