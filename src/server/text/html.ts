const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", mdash: "—", ndash: "–", hellip: "…",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

const BLOCK = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|title|blockquote|pre|hr|body|empty-line|v|stanza|poem|cite|epigraph|annotation|text-author|subtitle)\b[^>]*>/gi;

/** Visible text of an HTML or XML document: tags dropped, block ends become line breaks. Not a parser, but enough to search. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|binary)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
