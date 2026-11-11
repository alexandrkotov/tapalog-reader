declare module "*.wasm" {
  const url: string;
  export default url;
}
declare module "*.ttf" {
  const url: string;
  export default url;
}
// The minified build is smaller; it has the same API as the package's main entry.
declare module "pdfjs-dist/build/pdf.min.mjs" {
  export * from "pdfjs-dist";
}
declare module "*.css";
declare module "foliate-js/view.js";
declare module "foliate-js/comic-book.js" {
  export function makeComicBook(loader: unknown, file: { name: string }): unknown;
}
declare module "foliate-js/vendor/zip.js" {
  export function configure(options: { useWebWorkers?: boolean }): void;
  export class ZipReader {
    constructor(reader: unknown);
    getEntries(): Promise<never>;
  }
  export class BlobWriter {
    constructor(type?: string);
  }
  export class TextWriter {}
}
declare module "foliate-js/overlayer.js" {
  export const Overlayer: { highlight: unknown };
}
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
