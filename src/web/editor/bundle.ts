/**
 * The visual editor of a page's text, built into one script (see scripts/gen-editor-assets.ts) that the program's page adds when
 * somebody opens the window for checking the text; it is not part of the page itself. It sets `window.TapalogEditor`.
 * The text goes in and out as Markdown, and what the editor does to it is kept small by the rules in textRules.ts.
 */
import { defaultValueCtx, Editor, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark, hardbreakSchema, imageSchema } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, Selection } from "@milkdown/kit/prose/state";
import { $prose, $view, insert, replaceAll } from "@milkdown/kit/utils";
import { katexOptionsCtx, math } from "@milkdown/plugin-math";
import { fromEditor, toEditor } from "./textRules";

export interface EditorOptions {
  /** Where the picture written as `images/p008-1.png` really is. */
  resolveImage: (src: string) => string;
  /** The text after a change made by the person (not after `set`). */
  onChange: (text: string) => void;
}

export interface PageEditor {
  /** The text as the page keeps it. */
  text: () => string;
  /** Replaces the text without telling `onChange`. */
  set: (text: string) => void;
  /** Puts Markdown at the cursor as a paragraph of its own (at the end of the text when nobody has put a cursor there yet). */
  insert: (markdown: string) => void;
  focus: () => void;
  destroy: () => Promise<void>;
}

const textOf = (ctx: Ctx): string => fromEditor(ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));

async function create(root: HTMLElement, text: string, options: EditorOptions): Promise<PageEditor> {
  let quiet = true; // nothing is reported while the editor is being filled
  let editor: Editor | null = null;

  const watch = $prose((ctx) =>
    new Plugin({
      view: () => ({
        update: (view, before) => {
          if (quiet || !editor || view.state.doc.eq(before.doc)) return;
          options.onChange(editor.action(textOf));
        },
      }),
      props: {
        // a line break in this text is a plain one, not the "hard break" that is written with a backslash
        handleKeyDown: (view, event) => {
          if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
          view.dispatch(view.state.tr.replaceSelectionWith(hardbreakSchema.type(ctx).create({ isInline: true })).scrollIntoView());
          return true;
        },
      },
    }),
  );

  // pictures are written `images/...` in the text and kept elsewhere
  const pictures = $view(imageSchema.node, () => (node: Node) => {
    const img = document.createElement("img");
    const paint = (n: Node) => {
      const src = options.resolveImage(String(n.attrs.src));
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      img.alt = String(n.attrs.alt ?? "");
      img.title = String(n.attrs.title || n.attrs.alt || "");
    };
    paint(node);
    return {
      dom: img,
      update: (next: Node) => {
        if (next.type !== node.type) return false;
        node = next;
        paint(next);
        return true;
      },
    };
  });

  // a line break of the text is drawn as an ordinary break of the line, so a click beside the end of a line puts the cursor at its end
  const breaks = $view(hardbreakSchema.node, () => (node: Node) => {
    const br = document.createElement("br");
    br.dataset.type = "hardbreak";
    br.dataset.isInline = String(node.attrs.isInline);
    return { dom: br };
  });

  const made = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, toEditor(text));
      ctx.set(katexOptionsCtx.key, { throwOnError: false });
    })
    .use(commonmark)
    .use(history)
    .use(math)
    .use(pictures)
    .use(breaks)
    .use(watch)
    .create();
  editor = made;
  quiet = false;
  let cursor = false; // has the person put a cursor in the text
  made.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dom.addEventListener("focus", () => (cursor = true));
    view.dom.addEventListener("pointerdown", () => (cursor = true));
  });

  return {
    text: () => made.action(textOf),
    set: (next) => {
      quiet = true;
      try {
        made.action(replaceAll(toEditor(next)));
      } finally {
        quiet = false;
      }
    },
    insert: (markdown) => {
      if (!cursor) {
        made.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
        });
      }
      made.action(insert(markdown));
    },
    focus: () => made.action((ctx) => ctx.get(editorViewCtx).focus()),
    destroy: async () => void (await made.destroy()),
  };
}

(globalThis as unknown as { TapalogEditor: unknown }).TapalogEditor = { create };
