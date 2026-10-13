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
 *  - Leading `#` on a line: would start a heading, letting a note fake a new
 *    "## 7. Screenshot" entry.
 *  - Backslash itself, first, so input like `\]` cannot cancel our escape.
 * Emphasis characters (`*`, `_`) are left alone: the worst they can do is
 * make text bold, and escaping them makes notes much harder to read raw.
 *
 * URLs used as link *destinations* are handled separately by `safeUrl`.
 */

// C0 control characters except tab and newline, plus DEL. They have no
// business in notes and can corrupt terminals or editors that display them.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
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
 * Render text as a blockquote, escaping every line. Each line gets its own
 * `> ` prefix, so a blank line in the middle of a note cannot end the quote
 * and let the rest of the note escape into the document.
 */
export function blockquote(text: string): string {
  return splitLines(text)
    .map((line) => (line.trim() === "" ? ">" : `> ${escapeLine(line)}`))
    .join("\n");
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
    .replace(/^(\s*)#/, "$1\\#");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
}
