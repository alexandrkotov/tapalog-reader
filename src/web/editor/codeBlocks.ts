/**
 * Blocks of code in the visual editor: a name of the language in the corner of the block (a click opens a list to choose from,
 * with a field to find one in), and the code coloured by what it is. The block is the editor's own code block, written in the text
 * as a fence (```python … ```), so the language lives in the text and any other program reads it. The colouring comes from the
 * stream parsers of CodeMirror's legacy modes (plain functions that read a line token by token); they are run here by a loop of
 * our own, because CodeMirror's own engine for them would bring its whole editor into the script.
 */
import { c, cpp, csharp, dart, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { css } from "@codemirror/legacy-modes/mode/css";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/legacy-modes/mode/go";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { javascript, json, typescript } from "@codemirror/legacy-modes/mode/javascript";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { python } from "@codemirror/legacy-modes/mode/python";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { html, xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";

/** The part of CodeMirror's `StringStream` that the legacy modes use. */
class Stream {
  pos = 0;
  start = 0;
  private lastColumnPos = 0;
  private lastColumnValue = 0;
  constructor(readonly string: string, readonly tabSize: number, readonly indentUnit: number) {}
  eol() {
    return this.pos >= this.string.length;
  }
  sol() {
    return this.pos === 0;
  }
  peek() {
    return this.string.charAt(this.pos) || undefined;
  }
  next() {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
    return undefined;
  }
  eat(match: string | RegExp | ((ch: string) => boolean)) {
    const ch = this.string.charAt(this.pos);
    const ok = typeof match === "string" ? ch === match : ch && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (ok) {
      this.pos++;
      return ch;
    }
    return undefined;
  }
  eatWhile(match: string | RegExp | ((ch: string) => boolean)) {
    const start = this.pos;
    while (this.eat(match));
    return this.pos > start;
  }
  eatSpace() {
    const start = this.pos;
    while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) this.pos++;
    return this.pos > start;
  }
  skipToEnd() {
    this.pos = this.string.length;
  }
  skipTo(ch: string) {
    const found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
    return undefined;
  }
  backUp(n: number) {
    this.pos -= n;
  }
  column() {
    if (this.lastColumnPos < this.start) {
      this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
      this.lastColumnPos = this.start;
    }
    return this.lastColumnValue;
  }
  indentation() {
    return countColumn(this.string, null, this.tabSize);
  }
  match(pattern: string | RegExp, consume?: boolean, caseInsensitive?: boolean) {
    if (typeof pattern === "string") {
      const cased = (str: string) => (caseInsensitive ? str.toLowerCase() : str);
      if (cased(this.string.substr(this.pos, pattern.length)) === cased(pattern)) {
        if (consume !== false) this.pos += pattern.length;
        return true;
      }
      return null;
    }
    const match = this.string.slice(this.pos).match(pattern);
    if (match && match.index! > 0) return null;
    if (match && consume !== false) this.pos += match[0].length;
    return match;
  }
  current() {
    return this.string.slice(this.start, this.pos);
  }
}

function countColumn(string: string, end: number | null, tabSize: number, startIndex = 0, startValue = 0): number {
  if (end === null) {
    end = string.search(/[^\s\u00a0]/);
    if (end === -1) end = string.length;
  }
  let n = startValue;
  for (let i = startIndex; i < end; i++) n += string.charCodeAt(i) === 9 ? tabSize - (n % tabSize) : 1;
  return n;
}

/** What a legacy mode is: it reads a line a token at a time and names each token ("keyword", "string" …) or leaves it unnamed. */
interface StreamParser {
  startState?: (indentUnit: number) => unknown;
  token: (stream: Stream, state: unknown) => string | null;
  blankLine?: (state: unknown, indentUnit: number) => void;
}

export interface CodeLanguage {
  /** What is written after the fence. */
  id: string;
  /** What the list and the corner of the block show. */
  name: string;
  /** Other names that mean the same (`py`, `js`, `c++`). */
  aliases: string[];
  parser: StreamParser;
}

const lang = (id: string, name: string, parser: unknown, aliases: string[] = []): CodeLanguage => ({ id, name, aliases, parser: parser as StreamParser });

/** The languages that are coloured, in the order of the list. */
export const CODE_LANGUAGES: CodeLanguage[] = [
  lang("bash", "Bash / Shell", shell, ["sh", "shell", "zsh", "console"]),
  lang("c", "C", c, ["h"]),
  lang("cpp", "C++", cpp, ["c++", "cc", "cxx", "hpp"]),
  lang("csharp", "C#", csharp, ["cs", "c#"]),
  lang("css", "CSS", css),
  lang("dart", "Dart", dart),
  lang("diff", "Diff", diff, ["patch"]),
  lang("dockerfile", "Dockerfile", dockerFile, ["docker"]),
  lang("go", "Go", go, ["golang"]),
  lang("haskell", "Haskell", haskell, ["hs"]),
  lang("html", "HTML", html),
  lang("java", "Java", java),
  lang("javascript", "JavaScript", javascript, ["js", "jsx", "node", "mjs"]),
  lang("json", "JSON", json),
  lang("kotlin", "Kotlin", kotlin, ["kt"]),
  lang("lua", "Lua", lua),
  lang("pascal", "Pascal", pascal, ["delphi"]),
  lang("perl", "Perl", perl, ["pl"]),
  lang("powershell", "PowerShell", powerShell, ["ps1", "pwsh"]),
  lang("python", "Python", python, ["py"]),
  lang("r", "R", r),
  lang("ruby", "Ruby", ruby, ["rb"]),
  lang("rust", "Rust", rust, ["rs"]),
  lang("scala", "Scala", scala),
  lang("sql", "SQL", standardSQL),
  lang("swift", "Swift", swift),
  lang("toml", "TOML", toml),
  lang("typescript", "TypeScript", typescript, ["ts", "tsx"]),
  lang("vb", "Visual Basic", vb, ["visualbasic", "vba", "vb.net"]),
  lang("vbscript", "VBScript", vbScript, ["vbs"]),
  lang("xml", "XML", xml, ["svg", "xhtml"]),
  lang("yaml", "YAML", yaml, ["yml"]),
];

/** The language a name in a fence stands for, or undefined when it is none the editor knows (the block is then shown as it is, uncoloured). */
export function codeLanguage(name: string): CodeLanguage | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return CODE_LANGUAGES.find((l) => l.id === key || l.aliases.includes(key) || l.name.toLowerCase() === key);
}

/** The class a token's name is shown with, or none; a name may have several words ("variable def"), the first one that means something is taken. */
const CLASSES: Record<string, string> = {
  keyword: "tok-keyword",
  builtin: "tok-keyword",
  qualifier: "tok-keyword",
  string: "tok-string",
  "string-2": "tok-string",
  link: "tok-string",
  number: "tok-number",
  atom: "tok-number",
  bool: "tok-number",
  comment: "tok-comment",
  def: "tok-name",
  "variable-2": "tok-name",
  "variable-3": "tok-name",
  property: "tok-name",
  attribute: "tok-name",
  type: "tok-type",
  tag: "tok-type",
  meta: "tok-meta",
  header: "tok-meta",
};

function classOf(style: string): string | undefined {
  for (const word of style.split(/\s+/)) if (CLASSES[word]) return CLASSES[word];
  return undefined;
}

/** The stretches of `code` that have a colour, as [from, to, class] (classes `tok-keyword`, `tok-string`, `tok-number`, `tok-comment`, `tok-type`, `tok-name`, `tok-meta`). */
export function highlightCode(code: string, name: string): [number, number, string][] {
  const language = codeLanguage(name);
  if (!language || !code) return [];
  const parser = language.parser;
  const out: [number, number, string][] = [];
  try {
    const state = parser.startState ? parser.startState(2) : true;
    let offset = 0;
    for (const line of code.split("\n")) {
      if (!line) parser.blankLine?.(state, 2);
      else {
        const stream = new Stream(line, 4, 2);
        while (!stream.eol()) {
          let style: string | null = null;
          for (let i = 0; i < 10; i++) {
            style = parser.token(stream, state);
            if (stream.pos > stream.start) break;
          }
          if (stream.pos <= stream.start) throw new Error("the mode did not advance");
          const cls = style ? classOf(style) : undefined;
          if (cls) out.push([offset + stream.start, offset + stream.pos, cls]);
          stream.start = stream.pos;
        }
      }
      offset += line.length + 1;
    }
  } catch {
    // a mode that stumbles on odd code leaves it plain
    return [];
  }
  return out;
}

const coloured = new WeakMap<PMNode, [number, number, string][]>();

/** Puts the colours on the code of every block of code in the document. */
export function codeColours(): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "code_block") return true;
          let ranges = coloured.get(node);
          if (!ranges) {
            ranges = highlightCode(node.textContent, String(node.attrs.language ?? ""));
            coloured.set(node, ranges);
          }
          for (const [from, to, cls] of ranges) decorations.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { class: cls }));
          return false;
        });
        return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
      },
    },
  });
}

export interface CodeStrings {
  /** What a block with no language is called. */
  plain: string;
  /** Hint of the field that finds a language. */
  find: string;
  /** The label for the button with the name of the language. */
  label: string;
  /** Said when nothing in the list matches. */
  none: string;
}

/** The node view of a block of code: the code itself, and a corner with the language to choose. */
export function codeBlockView(strings: () => CodeStrings) {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
    const dom = document.createElement("div");
    dom.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    head.contentEditable = "false";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-lang";
    head.append(button);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    dom.append(head, pre);

    let current = node;
    let popup: HTMLElement | null = null;
    const nameOf = (n: PMNode): string => {
      const name = String(n.attrs.language ?? "");
      return codeLanguage(name)?.name ?? (name || strings().plain);
    };
    const paint = () => {
      button.textContent = nameOf(current);
      button.title = strings().label;
      button.setAttribute("aria-label", `${strings().label}: ${nameOf(current)}`);
      dom.dataset.language = String(current.attrs.language ?? "");
    };
    paint();

    const choose = (id: string) => {
      const at = getPos();
      if (at !== undefined) view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...current.attrs, language: id }));
      closePopup();
      view.focus();
    };
    const away = (e: Event) => {
      if (popup && !popup.contains(e.target as Element) && e.target !== button) closePopup();
    };
    function closePopup() {
      popup?.remove();
      popup = null;
      document.removeEventListener("pointerdown", away, true);
    }
    const openPopup = () => {
      const find = document.createElement("input");
      find.type = "text";
      find.className = "code-find";
      find.placeholder = strings().find;
      find.setAttribute("aria-label", strings().find);
      const list = document.createElement("div");
      list.className = "code-list";
      list.setAttribute("role", "listbox");
      let shown: { id: string; name: string }[] = [];
      let at = 0;
      const draw = () => {
        const key = find.value.trim().toLowerCase();
        const all = [{ id: "", name: strings().plain }, ...CODE_LANGUAGES.map((l) => ({ id: l.id, name: l.name }))];
        shown = key ? all.filter((l) => l.name.toLowerCase().includes(key) || l.id.includes(key) || (codeLanguage(key)?.id === l.id)) : all;
        if (at >= shown.length) at = Math.max(0, shown.length - 1);
        list.replaceChildren(
          ...shown.map((l, i) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "code-item" + (i === at ? " on" : "") + (l.id === String(current.attrs.language ?? "") ? " current" : "");
            item.textContent = l.name;
            item.dataset.id = l.id;
            item.setAttribute("role", "option");
            item.addEventListener("click", () => choose(l.id));
            return item;
          }),
        );
        if (!shown.length) {
          const none = document.createElement("div");
          none.className = "code-none";
          none.textContent = strings().none;
          list.append(none);
        }
        list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
      };
      find.addEventListener("input", () => {
        at = 0;
        draw();
      });
      find.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // not the window the editor is in
          closePopup();
          view.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          at = Math.min(Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)), shown.length - 1);
          draw();
        } else if (e.key === "Enter") {
          e.preventDefault();
          const picked = shown[at];
          if (picked) choose(picked.id);
        }
      });
      popup = document.createElement("div");
      popup.className = "code-pop";
      popup.append(find, list);
      head.append(popup);
      document.addEventListener("pointerdown", away, true);
      at = Math.max(0, [{ id: "" }, ...CODE_LANGUAGES].findIndex((l) => l.id === String(current.attrs.language ?? "")));
      draw();
      find.focus();
    };
    button.addEventListener("click", () => (popup ? closePopup() : openPopup()));

    return {
      dom,
      contentDOM: code,
      update: (next: PMNode) => {
        if (next.type !== current.type) return false;
        current = next;
        paint();
        return true;
      },
      // what happens in the corner is not the text's business
      stopEvent: (e: Event) => head.contains(e.target as Element),
      ignoreMutation: (m: { target: Node }) => head.contains(m.target) || m.target === dom,
      destroy: closePopup,
    };
  };
}
