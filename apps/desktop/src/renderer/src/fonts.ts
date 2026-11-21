/**
 * New York and SF Mono are the installed macOS files, served by the main process under
 * draft-font: (src/main/system-fonts.ts), because Chromium hides their family names from pages.
 * Registered here rather than in CSS so the bundler leaves the URLs alone. Both are variable fonts.
 */
const FACES = [
  { family: "New York", file: "NewYork.ttf", style: "normal" },
  { family: "New York", file: "NewYorkItalic.ttf", style: "italic" },
  { family: "SF Mono", file: "SFNSMono.ttf", style: "normal" },
  { family: "SF Mono", file: "SFNSMonoItalic.ttf", style: "italic" },
] as const;
export function loadSystemFonts(): void {
  for (const f of FACES) {
    const face = new FontFace(f.family, `url("draft-font://fonts/${f.file}")`, {
      style: f.style,
      weight: "1 1000",
    });
    document.fonts.add(face);
    // A missing file leaves the next font in the stack in place.
    face.load().catch(() => {});
  }
}
