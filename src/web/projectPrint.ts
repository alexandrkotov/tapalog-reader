import { loadDisplay } from "./display";
import { t } from "./i18n";
import { openPrintDialog, type PrintContext } from "./print";
import { el } from "./ui";

/** What a printed project needs of its items (the same data the screen has). */
export interface PrintItem {
  bookId: string | null;
  view: unknown;
  title: string;
  comment: string;
  quote: string;
  book: { name: string; ext: string } | null;
  missing: boolean;
}

export interface PrintProject {
  title: string;
  description: string;
}

/** A picture is drawn to fit this box (CSS pixels, about the width of a printed page) and is sharp enough for paper. */
const PICTURE = { w: 680, h: 420, dpr: 2 };

const CSS = `
  .project-title { margin: 0 0 4pt; font-size: 20pt; }
  .project-about { margin: 0 0 6pt; white-space: pre-wrap; }
  .project-made { margin: 0 0 14pt; color: #555; font-size: 9pt; }
  .entry { margin: 0 0 14pt; break-inside: avoid-page; }
  .entry h2 { margin: 0 0 2pt; font-size: 13pt; }
  .entry .source { margin: 0 0 4pt; color: #444; font-size: 9.5pt; }
  .entry .fragment { display: block; max-width: 100%; height: auto; margin: 4pt 0; border: 0.5pt solid #bbb; }
  .entry blockquote { margin: 4pt 0; padding-left: 8pt; border-left: 2pt solid #999; }
  .entry p { margin: 4pt 0; white-space: pre-wrap; }
`;

/** Where in the book the item points, in words, when the view says it. */
export function placeOf(view: unknown): string {
  const page = Math.round(Number((view as { page?: unknown } | null)?.page));
  return page >= 1 ? t("projects.printPage", { n: page }) : "";
}

const canBePictured = (item: PrintItem) => !!item.bookId && !item.missing && item.book?.ext === "pdf";

/**
 * A project on paper, through the same print window the books use: title, description, then each item with its
 * source, the picture of its area (PDFs only), its quote and its comment. The pictures are drawn here from the
 * files the reader may open anyway, so a printout shows nothing the screen would not.
 */
export function printProject(project: PrintProject, items: PrintItem[]): void {
  const withPictures = items.some(canBePictured);
  openPrintDialog({
    job: {
      choices: [...(withPictures ? [{ id: "pictures", label: t("projects.printPictures") }] : []), { id: "text", label: t("projects.printText") }],
      async render(choice, _range, ctx) {
        ctx.root.append(el("style", { textContent: CSS }));
        const sources = new Map<string, Promise<import("./readers/pdfRegion").PdfPictures>>();
        ctx.onCleanup(() => {
          for (const source of sources.values()) void source.then((s) => s.close());
        });
        ctx.root.append(
          el("h1", { class: "project-title", textContent: project.title }),
          ...(project.description ? [el("div", { class: "project-about", textContent: project.description })] : []),
          el("div", { class: "project-made", textContent: t("projects.printMade", { date: new Date().toLocaleDateString("sv") }) }),
        );
        for (const [i, item] of items.entries()) {
          ctx.progress(i, items.length);
          if (ctx.signal.aborted) return;
          const place = placeOf(item.view);
          const source =
            item.bookId === null ? t("projects.note") : item.missing || !item.book ? t("projects.printGone") : [`${item.book.name} (${item.book.ext.toUpperCase()})`, place].filter(Boolean).join(", ");
          const entry = el("div", { class: "entry" }, el("h2", { textContent: `${i + 1}. ${item.title}` }), el("div", { class: "source", textContent: source }));
          if (choice === "pictures" && canBePictured(item)) {
            const image = await pictureOf(item, sources, ctx);
            if (image) entry.append(image);
          }
          if (item.quote) entry.append(el("blockquote", { textContent: item.quote }));
          if (item.comment) entry.append(el("p", { textContent: item.comment }));
          ctx.root.append(entry);
        }
        ctx.progress(items.length, items.length);
      },
    },
  });
}

/** The area of an item as an image for the page, or null when it cannot be drawn (the page is gone, the file needs a password). */
async function pictureOf(item: PrintItem, sources: Map<string, Promise<import("./readers/pdfRegion").PdfPictures>>, ctx: PrintContext): Promise<HTMLImageElement | null> {
  const bookId = item.bookId!;
  let source = sources.get(bookId);
  if (!source) sources.set(bookId, (source = import("./readers/pdfRegion").then((m) => m.openPdfPictures(`/api/file/${bookId}`))));
  const turn = (await loadDisplay(true, bookId)).rotation ?? 0; // as the reader turned the book
  const canvas = await (await source).picture(item.view, turn, ctx.signal, PICTURE);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  ctx.onCleanup(() => URL.revokeObjectURL(url));
  return el("img", { class: "fragment", src: url, alt: item.title, width: canvas.width / PICTURE.dpr, height: canvas.height / PICTURE.dpr });
}
