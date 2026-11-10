// An example reader plugin (MIT): shows a ".lines" text file, one numbered line per row.
// A plugin is an ES module that exports `mount(host, context)`; see guide/plugins.md.

// Optional: draw the book's cover for the library. Return a canvas, an ImageBitmap or an image Blob (it is scaled to fit);
// throw an error if the file has nothing to show. A network failure (a TypeError from fetch) is tried again later.
export async function cover(context) {
  const response = await fetch(context.url, { credentials: "include" });
  if (!response.ok) throw new TypeError(`The server answered ${response.status}`);
  const first = (await response.text()).split(/\r?\n/).slice(0, 8);
  const canvas = document.createElement("canvas");
  canvas.width = context.width;
  canvas.height = context.height;
  const draw = canvas.getContext("2d");
  draw.fillStyle = "#fdf6e3";
  draw.fillRect(0, 0, canvas.width, canvas.height);
  draw.fillStyle = "#333";
  draw.font = "16px monospace";
  first.forEach((text, i) => draw.fillText(`${i + 1}  ${text}`.slice(0, 24), 12, 28 + i * 24));
  return canvas;
}

export async function mount(host, context) {
  const response = await fetch(context.url, { credentials: "include" });
  if (!response.ok) {
    context.onError("Could not open this file", `The server answered ${response.status}`);
    return { destroy() {} };
  }
  const lines = (await response.text()).split(/\r?\n/);

  const list = document.createElement("ol");
  list.className = "text-lines";
  list.style.cssText = "margin:0;padding:1rem 1rem 1rem 3.5rem;overflow:auto;height:100%;box-sizing:border-box;font:15px/1.5 monospace";
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
    destroy: () => (clearTimeout(timer), list.remove()),
    getView: () => ({ line: line() }),
    getLabel: () => `line ${line()}`,
  };
}
