import pdfmake from "pdfmake";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { fontContext } from "./fonts.js";
import { MAX_OUTPUT_BYTES, type SourceDocumentRendererRequest } from "./types.js";

export async function renderPdf(request: SourceDocumentRendererRequest): Promise<Buffer> {
  const { files, fonts, text } = fontContext();
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path) => files.has(path));
  pdfmake.setFonts(fonts);
  const wide = request.blocks.some((block) => block.type === "table" && block.headers.length > 6);
  const content: Content[] = [{ text: text(request.title), fontSize: 20, bold: true, margin: [0, 0, 0, 18] }];
  for (const block of request.blocks) {
    if (block.type === "paragraph") content.push({ text: text(block.text), margin: [0, 0, 0, 10] });
    else if (block.type === "heading") content.push({ text: text(block.text), fontSize: [16, 13, 11][block.level - 1], bold: true, margin: [0, 12, 0, 7] });
    else if (block.type === "list") content.push({ ...(block.ordered ? { ol: block.items.map((item) => ({ text: text(item) })) } : { ul: block.items.map((item) => ({ text: text(item) })) }), margin: [0, 0, 0, 10] });
    else content.push({
      table: { headerRows: 1, widths: block.headers.map(() => "*"), body: [block.headers.map((header) => ({ text: text(header), bold: true, fillColor: "#EAF0F4" })), ...block.rows.map((row) => row.map((cell) => ({ text: text(cell) }))) ] },
      fontSize: block.headers.length > 6 ? 8 : 10, margin: [0, 5, 0, 12], layout: "lightHorizontalLines",
    });
  }
  const definition: TDocumentDefinitions = { info: { title: request.title, creator: "Gantry" }, pageSize: "A4", pageOrientation: wide ? "landscape" : "portrait", pageMargins: [48, 48, 48, 48], defaultStyle: { font: "Noto Sans", fontSize: 10.5, lineHeight: 1.2, color: "#172B3A" }, content };
  const stream = await pdfmake.createPdf(definition).getStream();
  return new Promise<Buffer>((done, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    stream.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_OUTPUT_BYTES) { stream.destroy(new Error("Rendered document exceeds output limit.")); return; }
      chunks.push(chunk);
    });
    stream.on("error", reject); stream.on("end", () => done(Buffer.concat(chunks, length)));
    stream.end();
  });
}
