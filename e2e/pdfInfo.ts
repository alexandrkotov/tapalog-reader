import type * as Pdfjs from "pdfjs-dist";

export interface PdfInfo {
  title: string | null;
  /** One entry per sheet. */
  pages: { width: number; height: number; text: string[]; images: number }[];
}

/** Reads a PDF back the way a reader would: the size of every sheet, the pieces of text on it and how many pictures it draws. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs" as string)) as typeof Pdfjs;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const pages: PdfInfo["pages"] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const text = (await page.getTextContent()).items.flatMap((item) => ("str" in item && item.str ? [item.str] : []));
    const ops = await page.getOperatorList();
    const images = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length;
    pages.push({ width: x1 - x0, height: y1 - y0, text, images });
  }
  const info = (await doc.getMetadata()).info as { Title?: string };
  await task.destroy();
  return { title: info.Title ?? null, pages };
}
