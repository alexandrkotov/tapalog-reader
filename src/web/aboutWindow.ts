import { t } from "./i18n";
import { api, copyText, el, openModal } from "./ui";

export interface About {
  name: string;
  version: string;
  license: string;
  repo: string;
  site: string;
  components: { name: string; license: string; url: string }[];
  /** The folder with the program's own files; only the administrator is told. */
  dataFolder: string | null;
}

let known: Promise<About> | null = null;

/** What the server says about itself, asked once. */
export function aboutInfo(): Promise<About> {
  known ??= api<About>("/api/about").catch((e) => {
    known = null; // asked again next time
    throw e;
  });
  return known;
}

const link = (href: string, text: string) => el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });

/** The text a reader pastes into a report of a problem. */
export const details = (about: About, agent: string): string => `${about.name} ${about.version}\n${agent}`;

/** The window "About the program": the version, the licence, where to ask, and what the program is built from. */
export async function openAbout(): Promise<void> {
  let about: About;
  try {
    about = await aboutInfo();
  } catch {
    return;
  }
  const modal = openModal(t("about.title"));
  const copy = el("button", { type: "button", class: "btn", textContent: t("about.copy") });
  copy.addEventListener("click", async () => {
    if (await copyText(details(about, navigator.userAgent))) {
      copy.textContent = t("common.copied");
      setTimeout(() => (copy.textContent = t("about.copy")), 1500);
    }
  });
  modal.body.append(
    el("div", { class: "about-head" }, el("strong", { class: "about-name", textContent: about.name }), el("span", { class: "about-version", textContent: t("about.version", { v: about.version }) })),
    el("p", { class: "about-what", textContent: t("about.what") }),
    el("p", { class: "muted small about-offline", textContent: t("about.offline") }),
    el("p", { class: "about-links" }, link(about.site, t("about.site")), " · ", link(about.repo, t("about.source")), " · ", link(`${about.repo}/issues`, t("about.issues")), " · ", link(`${about.repo}/blob/main/LICENSE`, t("about.license", { name: about.license }))),
    el("h3", { class: "about-parts", textContent: t("about.components") }),
    el("ul", { class: "about-components" }, ...about.components.map((c) => el("li", {}, link(c.url, c.name), el("span", { class: "muted small", textContent: ` ${c.license}` })))),
    ...(about.dataFolder ? [el("p", { class: "muted small about-data" }, `${t("about.data")} `, el("code", { textContent: about.dataFolder }))] : []),
    el("div", { class: "about-actions" }, copy),
  );
}
