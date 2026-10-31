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
declare module "foliate-js/overlayer.js" {
  export const Overlayer: { highlight: unknown };
}
