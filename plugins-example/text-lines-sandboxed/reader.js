// An example ISOLATED reader plugin (MIT): shows a ".slines" text file, one numbered line per row, like text-lines does for ".lines".
//
// An isolated plugin (API 2, "isolated": true in plugin.json) runs in a sandboxed frame: it cannot read the program's page,
// cookies or login. It draws into `host` (the body of its own document) and gets the book's bytes from `await context.file()`
// (an ArrayBuffer; there is no `context.url`). Everything else is as for a plugin in the page: `onView`, `onError`, `theme`,
// `onTheme`, and the returned `{ destroy, getView?, getLabel? }`. See guide/plugins.md.

const decode = (buffer) => new TextDecoder().decode(buffer);

// Optional: draw the book's cover. Return a canvas, an ImageBitmap or an image Blob; throw if the file has nothing to show.
// A TypeError (a failed fetch, here a failed `file()`) is tried again later.
export async function cover(context) {
  const first = decode(await context.file()).split(/\r?\n/).slice(0, 8);
  const canvas = document.createElement("canvas");
  canvas.width = context.width;
  canvas.height = context.height;
  const draw = canvas.getContext("2d");
  draw.fillStyle = "#e8f1fd";
  draw.fillRect(0, 0, canvas.width, canvas.height);
  draw.fillStyle = "#333";
  draw.font = "16px monospace";
  first.forEach((text, i) => draw.fillText(`${i + 1}  ${text}`.slice(0, 24), 12, 28 + i * 24));
  return canvas;
}

export async function mount(host, context) {
  let lines;
  try {
    lines = decode(await context.file()).split(/\r?\n/);
  } catch (err) {
    context.onError("Could not open this file", err instanceof Error ? err.message : String(err));
    return { destroy() {} };
  }

  const list = document.createElement("ol");
  list.className = "text-lines";
  list.dataset.api = String(context.api);
  list.style.cssText = "margin:0;padding:1rem 1rem 1rem 3.5rem;overflow:auto;height:100%;box-sizing:border-box;font:15px/1.5 monospace";
  const colours = (theme) => (list.style.color = theme === "dark" ? "#ddd" : "#222");
  colours(context.theme);
  const stopTheme = context.onTheme(colours);
  for (const text of lines) {
    const row = document.createElement("li");
    row.textContent = text;
    list.append(row);
  }
  host.replaceChildren(list);

  const line = () => Math.floor(list.scrollTop / (list.firstElementChild?.offsetHeight || 1)) + 1;
  let timer;
  list.addEventListener("scroll", () => {
    clearTimeout(timer);
    timer = setTimeout(() => context.onView({ line: line() }), 200);
  });
  const start = Number(context.view?.line);
  if (start > 1) list.scrollTop = (start - 1) * (list.firstElementChild?.offsetHeight || 0);

  return {
    destroy: () => (clearTimeout(timer), stopTheme(), list.remove()),
    getView: () => ({ line: line() }),
    getLabel: () => `line ${line()}`,
  };
}
