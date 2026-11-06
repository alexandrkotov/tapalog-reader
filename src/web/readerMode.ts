/**
 * Reading mode: the page alone, without the top bar, the library panel and the book's title bar.
 * It is a class on <body> that the style sheet reacts to; the reader that turned it on keeps its own
 * toolbar on screen, so there is always a button to leave (Esc works too), and it switches the mode off
 * when it goes away so the next screen never opens bare.
 */
const CLASS = "reading-mode";

export const readerMode = (): boolean => document.body.classList.contains(CLASS);

export function setReaderMode(on: boolean): void {
  document.body.classList.toggle(CLASS, on);
}
