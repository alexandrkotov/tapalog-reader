import { expect, test } from "bun:test";
import { decodeText } from "./decode";

const cp1251 = (s: string) => Uint8Array.from([...s].map((c) => (c >= "А" && c <= "я" ? c.charCodeAt(0) - 0x410 + 0xc0 : c.charCodeAt(0))));
const cp1252 = (s: string) => Uint8Array.from([...s].map((c) => ({ é: 0xe9, è: 0xe8, ï: 0xef, "—": 0x97 })[c] ?? c.charCodeAt(0)));

test("UTF-8, with and without a BOM, and UTF-16 with a BOM", () => {
  expect(decodeText(new TextEncoder().encode("Привет, мир"))).toBe("Привет, мир");
  expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Привет")]))).toBe("Привет");
  const le = Uint8Array.from([0xff, 0xfe, ...[..."Привет"].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
  expect(decodeText(le)).toBe("Привет");
});

test("unlabelled Cyrillic is Windows-1251", () => {
  expect(decodeText(cp1251("Повесть о реке, глава первая. Сад и мост."))).toBe("Повесть о реке, глава первая. Сад и мост.");
});

test("unlabelled accented Latin text is Windows-1252", () => {
  expect(decodeText(cp1252("Café crème — naïve résumé"))).toBe("Café crème — naïve résumé");
});
