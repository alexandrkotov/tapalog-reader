/**
 * A project as a Markdown document: the reader's own words, the quotes, where each one came from and a
 * link that opens the book at the saved place. This is plain text with no browser dependencies, so it can
 * be tested without one; the words the file says in the reader's language come in as `labels`.
 */

export interface MarkdownItem {
  bookId: string | null;
  view: unknown;
  title: string;
  comment: string;
  quote: string;
  /** The book as the library knows it now; null for a note and for a book that left the library. */
  book: { name: string; ext: string } | null;
  missing: boolean;
}

export interface MarkdownProject {
  title: string;
  description: string;
}

export interface MarkdownLabels {
  /** The line under the title: when and from where the file was made, and that the links need that server. */
  intro: string;
  /** "Open at the saved place": the text of a link. */
  open: string;
  /** Said of a book that is no longer in the library. */
  missing: string;
  /** Said of an item that is not about a book. */
  note: string;
  /** Said when the project has nothing in it. */
  empty: string;
}

/** The address a link of the file opens: the server's own address with the same hash the app uses. */
export type Link = (bookId: string, view: unknown) => string;

const SPECIAL = /([\\`*_[\]<>#|])/g;
const escapeText = (text: string) => text.replace(/\s+/g, " ").trim().replace(SPECIAL, "\\$1");
// Parentheses would end a link early, and whitespace would end it at once.
const safeUrl = (url: string) => url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
const quoted = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trim()}` : ">"))
    .join("\n");

export function projectMarkdown(project: MarkdownProject, items: MarkdownItem[], labels: MarkdownLabels, link: Link): string {
  const out: string[] = [`# ${escapeText(project.title)}`];
  if (project.description.trim()) out.push(project.description.trim());
  out.push(`*${labels.intro}*`);
  if (!items.length) out.push(`_${labels.empty}_`);
  items.forEach((item, i) => {
    out.push(`## ${i + 1}. ${escapeText(item.title)}`);
    if (item.bookId === null) out.push(`_${labels.note}_`);
    else if (item.missing || !item.book) out.push(`_${labels.missing}_`);
    else out.push(`**${escapeText(item.book.name)}** (${item.book.ext.toUpperCase()}) — [${labels.open}](${safeUrl(link(item.bookId, item.view))})`);
    if (item.quote.trim()) out.push(quoted(item.quote));
    if (item.comment.trim()) out.push(item.comment.trim()); // the reader's own text, Markdown in it is theirs
  });
  return out.join("\n\n") + "\n";
}

/** A name for the file that every system takes: no path separators or reserved characters, not too long. */
export function markdownFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "project"}.md`;
}
