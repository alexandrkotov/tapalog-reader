// An example reader plugin (MIT): shows a ".lines" text file, one numbered line per row.
// A plugin is an ES module that exports `mount(host, context)`; see "Plugins" in the README.

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
