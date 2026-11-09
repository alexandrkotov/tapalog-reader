/**
 * The loop that reads a book's pages one after another, apart from everything that touches the browser:
 * what draws a page, what reads its picture and where the text goes are handed in, so the loop can be tried
 * with stand-ins. Several pages are in flight at once (as many as there are readers), a page that cannot be
 * read is tried once more and then set aside, and a failure of the upload ends the run: the server is gone.
 */

/** `Read` is what reading a picture gives: the text alone, or the text with whatever goes with it (the frames of its words). */
export interface OcrSteps<Image, Read = string> {
  /** Draws page `page` (1-based). */
  render(page: number): Promise<Image>;
  /** Reads the picture. */
  recognize(image: Image): Promise<Read>;
  /** Frees what `render` made, whether the page was read or not. */
  release?(image: Image): void;
  /** Gives what was read from a page to the server. A rejection ends the run. */
  upload(page: number, read: Read): Promise<void>;
}

export interface OcrRunOptions<Image, Read = string> extends OcrSteps<Image, Read> {
  pages: number;
  /** Pages the server already holds. */
  done: Iterable<number>;
  /** How many pages are worked on at once. */
  lanes: number;
  signal?: AbortSignal;
  onProgress?(progress: OcrProgress): void;
  /** Pages tried again after a failure (default 1). */
  retries?: number;
}

export interface OcrProgress {
  /** Pages the server holds now (those it had before included). */
  done: number;
  pages: number;
  /** Pages set aside because they could not be read. */
  failed: number[];
  /** Seconds left at the speed so far; null until there is a speed to go by. */
  etaSeconds: number | null;
}

export interface OcrOutcome {
  done: number;
  pages: number;
  failed: number[];
  /** The administrator stopped it before the end. */
  stopped: boolean;
  /** The upload failed: what the server said or the network said. */
  error?: unknown;
}

/** Seconds left, from the pages read in this run and the time they took; null when nothing has been read yet. */
export function etaSeconds(readNow: number, remaining: number, elapsedMs: number): number | null {
  if (readNow < 1 || elapsedMs <= 0) return null;
  return Math.round((remaining * elapsedMs) / readNow / 1000);
}

/** A time left in the parts people say it in: under a minute in seconds, under an hour in minutes, then hours and minutes. */
export function splitEta(seconds: number): { hours: number; minutes: number; seconds: number } {
  if (seconds < 60) return { hours: 0, minutes: 0, seconds: Math.max(1, Math.round(seconds)) };
  const minutes = Math.round(seconds / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: 0 };
}

export async function runOcr<Image, Read = string>(options: OcrRunOptions<Image, Read>): Promise<OcrOutcome> {
  const { pages, signal } = options;
  const have = new Set(options.done);
  const todo: number[] = [];
  for (let p = 1; p <= pages; p++) if (!have.has(p)) todo.push(p);
  const total = todo.length;
  const failed: number[] = [];
  const started = Date.now();
  let readNow = 0;
  let error: unknown;
  let failure = false;
  const retries = options.retries ?? 1;

  const report = () => options.onProgress?.({ done: have.size, pages, failed: [...failed], etaSeconds: etaSeconds(readNow, total - readNow - failed.length, Date.now() - started) });
  const halted = () => failure || signal?.aborted === true;

  async function work(page: number): Promise<Read | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (halted()) return null;
      let image: Image | undefined;
      try {
        image = await options.render(page);
        return await options.recognize(image);
      } catch {
        /* try again, then set the page aside */
      } finally {
        if (image !== undefined) options.release?.(image);
      }
    }
    failed.push(page);
    return null;
  }

  async function lane(): Promise<void> {
    while (!halted()) {
      const page = todo.shift();
      if (page === undefined) return;
      const read = await work(page);
      if (read === null) {
        report();
        continue;
      }
      if (failure) return; // the server is gone: nothing more can be handed over
      try {
        await options.upload(page, read);
      } catch (e) {
        failure = true;
        error = e;
        return;
      }
      have.add(page);
      readNow++;
      report();
    }
  }

  report();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.lanes, todo.length || 1)) }, lane));
  return { done: have.size, pages, failed: [...failed].sort((a, b) => a - b), stopped: signal?.aborted === true && !failure && have.size + failed.length < pages, ...(failure ? { error } : {}) };
}
