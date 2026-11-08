import pkg from "../../package.json";

/** The version of this build: the one in package.json, which the release tag is made from. */
export const VERSION: string = pkg.version;

export const REPO_URL = "https://github.com/alexandrkotov/tapalog-reader";
export const SITE_URL = "https://tapalog.com";

export interface Component {
  name: string;
  license: string;
  url: string;
}

/** What is built into the program besides its own code, with the licence each part comes under. */
export const COMPONENTS: Component[] = [
  { name: "pdf.js", license: "Apache-2.0", url: "https://github.com/mozilla/pdf.js" },
  { name: "foliate-js", license: "MIT", url: "https://github.com/johnfactotum/foliate-js" },
  { name: "Bun", license: "MIT, with JavaScriptCore under LGPL-2.1", url: "https://bun.sh" },
  { name: "cloudflared", license: "Apache-2.0", url: "https://github.com/cloudflare/cloudflared" },
  { name: "sql.js", license: "MIT", url: "https://github.com/sql-js/sql.js" },
  { name: "fflate", license: "MIT", url: "https://github.com/101arrowz/fflate" },
  { name: "qrcode-generator", license: "MIT", url: "https://github.com/kazuhikoarase/qrcode-generator" },
  { name: "ECM viewer engine", license: "MIT", url: "https://github.com/alexandrkotov/electronic-catalog-maker" },
];
