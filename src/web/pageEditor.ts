import type { EditorOptions, Format, Formula, PageEditor } from "./editor/bundle";

export type { EditorOptions, Format, Formula, PageEditor };

/**
 * The visual editor of a page's text. It is not imported: the program's page is one piece, and Milkdown and KaTeX would put about
 * 0.7 MB into every visit. It comes as a script and a style sheet the server holds at /editor/ (see scripts/gen-editor-assets.ts),
 * added to the page on the first use.
 */
interface Factory {
  create: (root: HTMLElement, text: string, options: EditorOptions) => Promise<PageEditor>;
  render: (target: HTMLElement, latex: string, block: boolean) => void;
}

let loading: Promise<Factory> | null = null;

/** The editor, fetched once; when that fails the next try fetches again. */
function loadEditor(): Promise<Factory> {
  loading ??= new Promise<Factory>((resolve, reject) => {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "/editor/katex.css";
    document.head.append(style);
    const script = document.createElement("script");
    script.src = "/editor/editor.js";
    script.onload = () => {
      const found = (globalThis as unknown as { TapalogEditor?: Factory }).TapalogEditor;
      if (found) resolve(found);
      else reject(new Error("the editor did not start"));
    };
    script.onerror = () => reject(new Error("the editor could not be loaded"));
    document.head.append(script);
  }).catch((e: unknown) => {
    loading = null;
    document.querySelector('link[href="/editor/katex.css"]')?.remove();
    document.querySelector('script[src="/editor/editor.js"]')?.remove();
    throw e;
  });
  return loading;
}

export async function createPageEditor(root: HTMLElement, text: string, options: EditorOptions): Promise<PageEditor> {
  return (await loadEditor()).create(root, text, options);
}

/** Draws a formula into `target`, as the editor draws it. */
export async function renderFormula(target: HTMLElement, latex: string, block: boolean): Promise<void> {
  (await loadEditor()).render(target, latex, block);
}
