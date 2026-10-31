/** Opens a URL in the default browser. Failure is fine: the address is printed to the console too. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
  } catch {
    // no opener available (headless box, WSL without xdg-open)
  }
}
