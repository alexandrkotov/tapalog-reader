/** How every PDF in the page is opened: the same credentials and the helper files the server hands out under /pdfjs. */
export function pdfDocumentOptions(url: string) {
  return {
    url,
    withCredentials: true,
    wasmUrl: "/pdfjs/wasm/",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    iccUrl: "/pdfjs/iccs/",
  };
}
