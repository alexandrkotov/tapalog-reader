/** How much of a download has arrived; `total` is null when the server did not say how big the file is. */
export interface Progress {
  loaded: number;
  total: number | null;
}

/** The size the server announced for a body that arrives as it is (it would be wrong for one that is compressed on the way). */
function announcedSize(res: Response): number | null {
  if (res.headers.get("content-encoding")) return null;
  const n = Number(res.headers.get("content-length"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Reads a response body to the end, telling how much has come; the same bytes `res.blob()` gives. */
export async function readWithProgress(res: Response, onProgress?: (p: Progress) => void): Promise<Blob> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.body || !onProgress) return res.blob();
  const total = announcedSize(res);
  const reader = res.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  onProgress({ loaded, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array<ArrayBuffer>);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  return new Blob(parts, { type });
}

/** Fetches a file of the library or of a share link as a Blob, telling how much has come. */
export async function fetchBlob(url: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return readWithProgress(res, onProgress);
}
