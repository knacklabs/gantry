/** Keep complete Indic syllables together so the font shaper can position their marks. */
export function textRuns(text: string): Array<{ text: string; font: string }> {
  return (text.match(/[\u0900-\u097f\ua8e0-\ua8ff]+|[\u0c80-\u0cff]+|[^\u0900-\u097f\ua8e0-\ua8ff\u0c80-\u0cff]+/gu) ?? []).map((part) => ({
    text: part,
    font: /[\u0900-\u097f\ua8e0-\ua8ff]/u.test(part) ? "Noto Sans Devanagari" : /[\u0c80-\u0cff]/u.test(part) ? "Noto Sans Kannada" : "Noto Sans",
  }));
}
