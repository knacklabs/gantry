import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderDocument } from "../../../../src/source-documents/renderer/render.js";

describe("real bounded PDF rendering", () => {
  it("reopens real multipage bytes with Unicode and all table rows retained", async () => {
    const result = await renderDocument({ version: 1, format: "pdf", fileName: "Tender.pdf", title: "Tender summary", blocks: [
      { type: "heading", level: 1, text: "Résumé Ελληνικά हिंदी ಕನ್ನಡ" },
      { type: "paragraph", text: "A long readable paragraph. ".repeat(500) },
      { type: "list", ordered: false, items: ["First", "Second"] },
      { type: "table", headers: ["Item", "Description"], rows: Array.from({ length: 140 }, (_, index) => [String(index), `Table row ${index}`]) },
    ] });
    const bytes = Buffer.from(result.bytesBase64, "base64"); expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.sizeBytes).toBe(bytes.length); expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
    const document = await loading.promise;
    try {
      expect(document.numPages).toBeGreaterThan(3); const pages = [];
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number); const content = await page.getTextContent();
        pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
        expect(await page.getAnnotations()).toEqual([]);
        for (const item of content.items) if ("str" in item && item.str.trim()) {
          expect(item.transform[4]).toBeGreaterThanOrEqual(40);
          expect(item.transform[4] + item.width).toBeLessThanOrEqual(page.view[2] - 35);
        }
      }
      const text = pages.join(" "); expect(text.includes("Résumé")).toBe(true); expect(text.includes("Ελληνικά")).toBe(true); expect(text.includes("Table row 139")).toBe(true);
      expect(pages.filter((text) => text.includes("Description")).length).toBeGreaterThan(1);
    } finally { await loading.destroy(); }
  }, 30000);
  it.each(["pdf", "docx"] as const)("rejects unsupported glyphs in %s rather than producing silent replacement squares", async (format) => {
    await expect(renderDocument({ version: 1, format, fileName: `Tender.${format}`, title: "Tender", blocks: [{ type: "paragraph", text: "Unsupported 🦄" }] })).rejects.toThrow(/glyph/i);
  });
  it("fits twenty columns and long unbroken identifiers inside landscape pages", async () => {
    const result = await renderDocument({ version: 1, format: "pdf", fileName: "Wide.pdf", title: "Wide requirements", blocks: [{ type: "table", headers: Array.from({ length: 20 }, (_, index) => `H${index}`), rows: [Array(20).fill("ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3))] }] });
    const loading = getDocument({ data: new Uint8Array(Buffer.from(result.bytesBase64, "base64")), isEvalSupported: false });
    try {
      const document = await loading.promise; const page = await document.getPage(1); expect(page.view[2]).toBeGreaterThan(page.view[3]);
      for (const item of (await page.getTextContent()).items) if ("str" in item && item.str.trim()) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(40); expect(item.transform[4] + item.width).toBeLessThanOrEqual(page.view[2] - 35);
      }
    } finally { await loading.destroy(); }
  });
});
