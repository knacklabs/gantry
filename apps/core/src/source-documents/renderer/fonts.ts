import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TFontDictionary } from "pdfmake/interfaces.js";
import { textRuns } from "./text.js";
const fontkit = createRequire(import.meta.url)("fontkit") as { openSync(path: string): { hasGlyphForCodePoint(point: number): boolean } };

/** Font paths are trusted deployment configuration; the request cannot select a file or URL. */
export function fontContext() {
  const directory = process.env.GANTRY_DOCUMENT_FONT_DIR ?? fileURLToPath(new URL("./fonts/", import.meta.url));
  const files = new Set<string>(); const fonts: TFontDictionary = {}; const families: Array<{ name: string; normal: string; bold: string }> = []; const faces = new Map<string, Array<{ hasGlyphForCodePoint(point: number): boolean }>>();
  for (const name of ["Noto Sans", "Noto Sans Devanagari", "Noto Sans Kannada"]) {
    const normal = resolve(directory, `${name.replaceAll(" ", "")}-Regular.ttf`);
    const bold = resolve(directory, `${name.replaceAll(" ", "")}-Bold.ttf`);
    files.add(normal); files.add(bold); fonts[name] = { normal, bold, italics: normal, bolditalics: bold };
    families.push({ name, normal, bold });
    faces.set(name, [fontkit.openSync(normal), fontkit.openSync(bold)]);
  }
  const text = (value: string) => textRuns(value).map((run) => {
    for (const character of run.text) if (!/[\n\r\t]/u.test(character)) {
      if (!faces.get(run.font)!.every((face) => face.hasGlyphForCodePoint(character.codePointAt(0)!))) throw new Error("Document contains an unsupported font glyph.");
    }
    return { ...run, ...(/[!-~]{40}/u.test(run.text) ? { wordBreak: "break-all" as const } : {}) };
  });
  return { files, fonts, text, families };
}
