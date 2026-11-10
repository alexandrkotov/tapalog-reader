import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { englishPage } from "../scripts/gen-capabilities-en";

const guide = join(import.meta.dir, "../guide");
const read = (name: string) => readFileSync(join(guide, name), "utf8");

describe("the capabilities pages (guide/capabilities*.html)", () => {
  test("the English page is the Russian one made by `bun run gen:capabilities`", () => {
    expect(read("capabilities.en.html")).toBe(englishPage(read("capabilities.html")));
  });

  test("each page names its own language and a preview picture that exists beside it", () => {
    for (const [file, lang, picture] of [["capabilities.html", "ru", "og-image.png"], ["capabilities.en.html", "en", "og-image.en.png"]] as const) {
      const html = read(file);
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain(`<meta property="og:image" content="https://alexandrkotov.github.io/tapalog-reader/guide/${picture}">`);
      expect(html).toContain(`<meta name="twitter:image" content="https://alexandrkotov.github.io/tapalog-reader/guide/${picture}">`);
      expect(existsSync(join(guide, picture))).toBe(true);
      expect(html).toContain(`/guide/${file}?theme=light">`); // the address a card leads to opens the light theme
    }
  });
});
