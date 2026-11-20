import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType, type IParagraphOptions } from "docx";
import { fontContext } from "./fonts.js";
import type { SourceDocumentRendererRequest } from "./types.js";
import { readFile } from "node:fs/promises";

export async function renderDocx(request: SourceDocumentRendererRequest): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  const { text: checkedText, families } = fontContext();
  const fonts = await Promise.all(families.map(async (font) => ({ name: font.name, data: await readFile(font.normal), bold: await readFile(font.bold) })));
  const paragraph = (text: string, options: IParagraphOptions = {}) => new Paragraph({
    children: checkedText(text).flatMap((run) => run.text.split("\n").flatMap((line, index) => [new TextRun({ text: line, font: run.font, ...(index ? { break: 1 } : {}) })])),
    spacing: { after: 140 }, ...options,
  });
  children.push(paragraph(request.title, { heading: HeadingLevel.TITLE, keepNext: true }));
  for (const block of request.blocks) {
    if (block.type === "paragraph") children.push(paragraph(block.text));
    else if (block.type === "heading") children.push(paragraph(block.text, { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][block.level - 1], keepNext: true }));
    else if (block.type === "list") block.items.forEach((item, index) => children.push(paragraph(`${block.ordered ? `${index + 1}.` : "•"} ${item}`)));
    else {
      const widths = block.headers.map(() => Math.floor(9746 / block.headers.length));
      const row = (cells: string[], header = false) => new TableRow({ tableHeader: header, cantSplit: false, children: cells.map((text, index) => new TableCell({ width: { size: widths[index], type: WidthType.DXA }, shading: header ? { fill: "EAF0F4" } : undefined, children: [paragraph(text, { spacing: { after: 80 } })] })) });
      children.push(new Table({ width: { size: 9746, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: widths, rows: [row(block.headers, true), ...block.rows.map((cells) => row(cells))] }));
      children.push(paragraph(""));
    }
  }
  return Packer.toBuffer(new Document({
    creator: "Gantry", title: request.title, fonts,
    styles: { default: { document: { run: { font: "Noto Sans", size: 21, color: "172B3A" }, paragraph: { spacing: { line: 290 } } }, title: { run: { color: "172B3A", size: 38 } }, heading1: { run: { color: "172B3A", size: 30 } }, heading2: { run: { color: "172B3A", size: 26 } }, heading3: { run: { color: "172B3A", size: 23 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children }],
  }));
}
