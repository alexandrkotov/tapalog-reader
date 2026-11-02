import { api, ApiError } from "./ui";
import { pluginFor, pluginModule } from "./readers/plugins";

/**
 * Draws cover thumbnails for the library and uploads them. This runs in the administrator's
 * browser only: it already has pdf.js and the book readers, the server has no image decoder.
 * Each cover is a small JPEG; the server keeps one per book (by content id).
 */

const THUMB_W = 240;
const THUMB_H = 340;
const JPEG_QUALITY = 0.8;
/** Comics are zip files: reading one means downloading it whole, so huge ones get no cover. */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

interface Todo {
  id: string;
  ext: string;
  size: number;
}

/** Thrown for "this book has no cover we can draw", as opposed to a network or server failure. */
class NoCover extends Error {}

async function fromImage(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new NoCover("undecodable image");
    });
    return await scaled(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function scaled(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  if (!w || !h) throw new NoCover("empty image");
  const k = Math.min(1, THUMB_W / w, THUMB_H / h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // transparent covers would turn black in a JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new NoCover("could not encode");
  return blob;
}

async function pdfCover(url: string): Promise<Blob> {
  const pdfjs = await import("pdfjs-dist/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    url,
    withCredentials: true,
    wasmUrl: "/pdfjs/wasm/",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    iccUrl: "/pdfjs/iccs/",
  });
  task.onPassword = () => void task.destroy(); // a protected PDF has no cover for us
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(THUMB_W / base.width, THUMB_H / base.height) * 2 }); // drawn at 2x, then scaled down: crisper
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return await scaled(canvas, canvas.width, canvas.height);
  } catch (err) {
    if (err instanceof NoCover) throw err;
    if (err instanceof TypeError || (err as { name?: string }).name === "UnexpectedResponseException") throw err; // network: try again later
    throw new NoCover(err instanceof Error ? err.message : String(err)); // damaged or protected
  } finally {
    void task.destroy();
  }
}

async function foliateCover(url: string, ext: string, size: number): Promise<Blob> {
  if (ext === "cbz" && size > MAX_ZIP_BYTES) throw new NoCover("too large");
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const file = new File([await res.blob()], `book.${ext}`);
  const { makeBook } = (await import("foliate-js/view.js")) as { makeBook(file: File): Promise<{ getCover?(): Promise<Blob | null> }> };
  let cover: Blob | null | undefined;
  try {
    cover = await (await makeBook(file)).getCover?.();
  } catch {
    throw new NoCover("unreadable book");
  }
  if (!cover) throw new NoCover("no cover");
  return fromImage(cover);
}

async function catalogCover(id: string): Promise<Blob> {
  const res = await fetch(`/api/admin/covers/${id}/source`, { credentials: "same-origin" });
  if (res.status === 404) throw new NoCover("no picture");
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return fromImage(await res.blob());
}

/** A plugin draws the cover itself: it gets the file's address and hands back an image. */
async function pluginCover(book: Todo, plugin: NonNullable<ReturnType<typeof pluginFor>>): Promise<Blob> {
  try {
    const module = await pluginModule(plugin);
    if (typeof module.cover !== "function") throw new NoCover("the plugin draws no covers");
    const image = await module.cover({ url: `/api/file/${book.id}`, ext: book.ext, width: THUMB_W, height: THUMB_H });
    if (image instanceof Blob) return await fromImage(image);
    const size = image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
    return await scaled(image, size.width ?? size.videoWidth ?? 0, size.height ?? size.videoHeight ?? 0);
  } catch (err) {
    if (err instanceof NoCover || err instanceof ApiError || err instanceof TypeError) throw err; // network trouble: try again later
    throw new NoCover(err instanceof Error ? err.message : String(err)); // a file the plugin cannot read
  }
}

function makeCover(book: Todo): Promise<Blob> {
  const plugin = pluginFor(book.ext);
  if (plugin?.cover && !["pdf", "ecatm", "epub", "fb2", "mobi", "cbz"].includes(book.ext)) return pluginCover(book, plugin);
  if (book.ext === "pdf") return pdfCover(`/api/file/${book.id}`);
  if (book.ext === "ecatm") return catalogCover(book.id);
  return foliateCover(`/api/file/${book.id}`, book.ext, book.size);
}

let running = false;
let again = false;
let stopped = false;

/** Stops the loop after the cover in hand (sign-out, language switch, a new boot). */
export function stopCovers(): void {
  stopped = true;
}

/**
 * Works through the books that lack a cover, one at a time so the page stays responsive.
 * Calling it while it runs just asks for another pass once the current one ends.
 */
export async function makeCovers(progress: { onSaved(id: string): void; onState(remaining: number): void }): Promise<void> {
  if (running) {
    again = true;
    stopped = false; // a stop requested just before (a reboot of the page) is cancelled by this call
    return;
  }
  running = true;
  stopped = false;
  const tried = new Set<string>(); // a book that failed for a network reason must not make this pass loop forever
  try {
    do {
      again = false;
      for (;;) {
        const { todo, remaining } = await api<{ todo: Todo[]; remaining: number }>("/api/admin/covers/todo");
        const next = todo.filter((b) => !tried.has(b.id));
        if (!next.length) break;
        let left = remaining;
        for (const book of next) {
          if (stopped) return;
          tried.add(book.id);
          progress.onState(left--);
          let blob: Blob;
          try {
            blob = await makeCover(book);
          } catch (err) {
            if (err instanceof NoCover) await api(`/api/admin/covers/${book.id}`, {}).catch(() => undefined);
            continue; // anything else (network, deleted meanwhile) is retried on the next pass
          }
          const res = await fetch(`/api/admin/covers/${book.id}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "image/jpeg" }, body: blob });
          if (res.ok) progress.onSaved(book.id);
          else if (res.status === 400) await api(`/api/admin/covers/${book.id}`, {}).catch(() => undefined); // e.g. over the size limit
          else if (res.status === 401 || res.status === 403) return; // signed out: stop quietly
        }
      }
    } while (again && !stopped);
  } catch {
    /* the server went away: the next boot or scan starts it again */
  } finally {
    running = false;
    progress.onState(0);
  }
}
