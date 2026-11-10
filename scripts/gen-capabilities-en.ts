/**
 * Makes the English page of the capabilities (guide/capabilities.en.html) from the Russian one (guide/capabilities.html).
 * Both hold the two languages and the same script; they are two files only because a link preview (Facebook, LinkedIn) is
 * read from the page's own tags, without running its script, so each language needs its own tags, picture and default.
 * Edit the Russian page and run this again (a test fails when the English one is out of date):
 *   bun run gen:capabilities
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://alexandrkotov.github.io/tapalog-reader/guide/";

/** Sets the `content` of the one meta tag found by `attr="value"`. */
function setMeta(html: string, attr: string, value: string, content: string): string {
  const tag = new RegExp(`(<meta ${attr}="${value}" content=")[^"]*(">)`);
  if (!tag.test(html)) throw new Error(`no <meta ${attr}="${value}">`);
  return html.replace(tag, (_, a: string, b: string) => a + content.replace(/"/g, "&quot;") + b);
}

export function englishPage(russian: string): string {
  if (!russian.includes('<html lang="ru">')) throw new Error("the Russian page does not say lang=ru");
  let html = russian.replace('<html lang="ru">', '<html lang="en">');
  const title = "Tapalog Reader: not just a reader, a combine for books";
  const text = "A folder of books becomes a web library: readers, scans with proofreading, share links, plugins.";
  const image = SITE + "og-image.en.png";
  html = setMeta(html, "name", "description", `${title}. Readers, a library, scans with proofreading, sharing and access, plugins. One file for Windows, Linux and macOS.`);
  html = setMeta(html, "property", "og:title", title);
  html = setMeta(html, "property", "og:description", `${text} One file for Windows, Linux and macOS.`);
  html = setMeta(html, "property", "og:url", SITE + "capabilities.en.html?theme=light");
  html = setMeta(html, "property", "og:image", image);
  html = setMeta(html, "property", "og:image:alt", "Not just a reader: a combine for books. Reading, library, scans, access, plugins");
  html = setMeta(html, "property", "og:locale", "en_US");
  html = setMeta(html, "property", "og:locale:alternate", "ru_RU");
  html = setMeta(html, "name", "twitter:title", title);
  html = setMeta(html, "name", "twitter:description", text);
  html = setMeta(html, "name", "twitter:image", image);
  return html;
}

if (import.meta.main) {
  const guide = join(import.meta.dir, "../guide");
  writeFileSync(join(guide, "capabilities.en.html"), englishPage(readFileSync(join(guide, "capabilities.html"), "utf8")));
  console.log("guide/capabilities.en.html written");
}
