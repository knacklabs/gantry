import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TFontDictionary } from 'pdfmake/interfaces.js';
import { textRuns } from './text.js';
const fontkit = createRequire(import.meta.url)('fontkit') as {
  openSync(path: string): { hasGlyphForCodePoint(point: number): boolean };
};

/** Font paths are trusted deployment configuration; the request cannot select a file or URL. */
export function fontContext() {
  const directory =
    process.env.GANTRY_DOCUMENT_FONT_DIR ??
    fileURLToPath(new URL('./fonts/', import.meta.url));
  const files = new Set<string>();
  const fonts: TFontDictionary = {};
  const families: Array<{ name: string; normal: string; bold: string }> = [];
  const faces = new Map<
    string,
    Array<{ hasGlyphForCodePoint(point: number): boolean }>
  >();
  for (const name of [
    'Noto Sans',
    'Noto Sans Devanagari',
    'Noto Sans Kannada',
  ]) {
    const normal = resolve(
      directory,
      `${name.replaceAll(' ', '')}-Regular.ttf`,
    );
    const bold = resolve(directory, `${name.replaceAll(' ', '')}-Bold.ttf`);
    files.add(normal);
    files.add(bold);
    fonts[name] = { normal, bold, italics: normal, bolditalics: bold };
    families.push({ name, normal, bold });
    faces.set(name, [fontkit.openSync(normal), fontkit.openSync(bold)]);
  }
  const symbolFont = 'Noto Sans Symbols2';
  const symbolPath = resolve(directory, 'NotoSansSymbols2-Regular.ttf');
  files.add(symbolPath);
  fonts[symbolFont] = {
    normal: symbolPath,
    bold: symbolPath,
    italics: symbolPath,
    bolditalics: symbolPath,
  };
  families.push({ name: symbolFont, normal: symbolPath, bold: symbolPath });
  faces.set(symbolFont, [fontkit.openSync(symbolPath)]);
  const text = (value: string) => {
    const runs: Array<{ text: string; font: string }> = [];
    for (const run of textRuns(value))
      for (const character of run.text) {
        const supports = (font: string) =>
          /[\n\r\t]/u.test(character) ||
          faces
            .get(font)!
            .every((face) =>
              face.hasGlyphForCodePoint(character.codePointAt(0)!),
            );
        const font = supports(run.font)
          ? run.font
          : supports(symbolFont)
            ? symbolFont
            : undefined;
        if (!font)
          throw new Error('Document contains an unsupported font glyph.');
        const previous = runs.at(-1);
        if (previous?.font === font) previous.text += character;
        else runs.push({ text: character, font });
      }
    return runs.map((run) => ({
      ...run,
      ...(/[!-~]{40}/u.test(run.text)
        ? { wordBreak: 'break-all' as const }
        : {}),
    }));
  };
  return { files, fonts, text, families };
}
