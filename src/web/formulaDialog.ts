import { t } from "./i18n";
import { renderFormula, type Formula } from "./pageEditor";
import { el, openModal } from "./ui";
import { formulaLook, withLook } from "../shared/markup";

/** Pieces of LaTeX for people who do not write it by heart: a label, the text put at the cursor, and where the cursor goes in it (counted from its end). */
const SNIPPETS: { label: string; tip: string; text: string; back: number }[] = [
  { label: "a⁄b", tip: "\\frac{a}{b}", text: "\\frac{}{}", back: 3 },
  { label: "√", tip: "\\sqrt{x}", text: "\\sqrt{}", back: 1 },
  { label: "xⁿ", tip: "x^{n}", text: "^{}", back: 1 },
  { label: "xₙ", tip: "x_{n}", text: "_{}", back: 1 },
  { label: "∑", tip: "\\sum_{i=1}^{n}", text: "\\sum_{i=1}^{n} ", back: 0 },
  { label: "∫", tip: "\\int_{a}^{b}", text: "\\int_{a}^{b} ", back: 0 },
  { label: "αβπ", tip: "\\alpha \\beta \\pi", text: "\\alpha \\beta \\pi ", back: 0 },
  { label: "≤ ≠ ≈", tip: "\\le \\ne \\approx", text: "\\le \\ne \\approx ", back: 0 },
];

/**
 * The window for a formula: LaTeX in a field, a drawing of it below that follows what is typed, a few pieces to put in, and the
 * choice of a line of its own. Answers with the formula, "delete" (only when one is being edited) or null for cancel; Esc cancels
 * this window and leaves the one under it.
 */
export function askFormula(current: Formula & { editing?: boolean }): Promise<Formula | "delete" | null> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (answer: Formula | "delete" | null) => {
      if (answered) return;
      answered = true;
      removeEventListener("keydown", onKey, true);
      modal.close();
      resolve(answer);
    };
    const modal = openModal(t(current.editing ? "formula.titleEdit" : "formula.title"), () => finish(null));
    modal.body.closest(".modal")?.classList.add("formula");
    // size and weight are written into the LaTeX itself (\Large, \boldsymbol{…}); the field shows the formula without them
    const look = formulaLook(current.latex);
    const field = el("textarea", { class: "formula-latex", value: look.body, rows: 3, spellcheck: false, placeholder: "E = mc^2" });
    field.setAttribute("aria-label", t("formula.latex"));
    const block = el("input", { type: "checkbox", checked: current.block });
    const size = el("select", { class: "formula-size" }, ...(["formula.size.0", "formula.size.1", "formula.size.2", "formula.size.3"] as const).map((key, i) => el("option", { value: String(i), textContent: t(key), selected: i === look.size })));
    size.setAttribute("aria-label", t("formula.size"));
    const bold = el("input", { type: "checkbox", checked: look.bold, class: "formula-bold" });
    const latexOf = () => withLook({ body: field.value.trim(), size: Number(size.value), bold: bold.checked });
    const preview = el("div", { class: "formula-preview" });
    const draw = () => {
      const latex = latexOf();
      const empty = field.value.trim() === "";
      preview.classList.toggle("empty", empty);
      if (empty) preview.replaceChildren();
      else void renderFormula(preview, latex, block.checked).catch(() => (preview.textContent = latex));
    };
    field.addEventListener("input", draw);
    block.addEventListener("change", draw);
    size.addEventListener("change", draw);
    bold.addEventListener("change", draw);
    const pieces = el(
      "div",
      { class: "formula-pieces" },
      ...SNIPPETS.map((piece) => {
        const button = el("button", { type: "button", class: "btn small", textContent: piece.label, title: piece.tip });
        button.addEventListener("mousedown", (e) => e.preventDefault()); // the cursor stays in the field
        button.addEventListener("click", () => {
          const at = field.selectionStart;
          field.setRangeText(piece.text, at, field.selectionEnd, "end");
          const caret = at + piece.text.length - piece.back;
          field.setSelectionRange(caret, caret);
          field.focus();
          draw();
        });
        return button;
      }),
    );
    const ok = el("button", { type: "button", class: "btn primary", textContent: t(current.editing ? "formula.apply" : "formula.insert") });
    const cancel = el("button", { type: "button", class: "btn", textContent: t("common.cancel") });
    const remove = el("button", { type: "button", class: "btn", textContent: t("common.delete"), hidden: !current.editing });
    const submit = () => {
      const latex = field.value.trim();
      if (latex === "") field.focus();
      else finish({ latex: latexOf(), block: block.checked });
    };
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", () => finish(null));
    remove.addEventListener("click", () => finish("delete"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation(); // not the window under this one
        finish(null);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    };
    addEventListener("keydown", onKey, true);
    modal.body.replaceChildren(
      el("p", { class: "muted small", textContent: t("formula.hint") }),
      field,
      pieces,
      el("div", { class: "formula-look" }, el("label", { class: "formula-size-label" }, t("formula.size"), size), el("label", { class: "choice" }, bold, t("formula.bold"))),
      el("label", { class: "choice" }, block, t("formula.block")),
      el("div", { class: "formula-preview-label muted small", textContent: t("formula.preview") }),
      preview,
      el("div", { class: "row formula-actions" }, ok, cancel, remove),
    );
    draw();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
}
