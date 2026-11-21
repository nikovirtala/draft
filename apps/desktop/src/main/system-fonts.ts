import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
/**
 * Apple's New York and SF Mono ship with macOS, but Chromium hides their dot-prefixed family
 * names from pages, so neither a family name nor local() reaches them. This scheme serves the
 * installed files, and only these, for the renderer's @font-face rules. SF Pro needs none of
 * this: system-ui resolves to it.
 */
export const FONT_SCHEME = "draft-font";
const FILES = new Set(["NewYork.ttf", "NewYorkItalic.ttf", "SFNSMono.ttf", "SFNSMonoItalic.ttf"]);
const DIR = "/System/Library/Fonts/";
/** Before app ready: lets @font-face load from the scheme under the page's CSP. */
export function registerFontScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FONT_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } },
  ]);
}
/** After app ready. Anything but the listed files, or any platform but macOS, is a 404. */
export function handleFontScheme(): void {
  protocol.handle(FONT_SCHEME, (req) => {
    const file = new URL(req.url).pathname.slice(1);
    if (process.platform !== "darwin" || !FILES.has(file))
      return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(DIR + file).toString());
  });
}
