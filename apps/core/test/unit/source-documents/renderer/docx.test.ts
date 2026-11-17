import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderDocument } from "../../../../src/source-documents/renderer/render.js";
const { unzipSync } = createRequire(import.meta.resolve("docx"))("fflate");

describe("real DOCX rendering", () => {
  it("reopens the ZIP with Unicode, long paragraphs, lists and repeating table headers", async () => {
    const result = await renderDocument({ version: 1, format: "docx", fileName: "Tender.docx", title: "Tender summary", blocks: [
      { type: "heading", level: 2, text: "Résumé हिंदी ಕನ್ನಡ Ελληνικά" },
      { type: "paragraph", text: "Long readable paragraph. ".repeat(900) },
      { type: "list", ordered: true, items: ["First", "Second"] },
      { type: "table", headers: ["Item", "Description"], rows: Array.from({ length: 120 }, (_, i) => [String(i), `Table row ${i}`]) },
    ] });
    const bytes = Buffer.from(result.bytesBase64, "base64");
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(result.sizeBytes).toBe(bytes.length); expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const archive = unzipSync(bytes); const xml = Buffer.from(archive["word/document.xml"]).toString("utf8");
    const text = [...xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu)].map((match) => match[1]).join("");
    expect(text.includes("Résumé हिंदी ಕನ್ನಡ Ελληνικά")).toBe(true); expect(text.includes("Table row 119")).toBe(true);
    expect(xml).toContain("w:tblHeader"); expect(xml).toContain("w:tblLayout"); expect(xml).toContain("w:keepNext");
    expect(Object.keys(archive)).toContain("[Content_Types].xml");
    expect(Object.keys(archive).filter((name) => /^word\/fonts\/.*\.odttf$/u.test(name)).length).toBe(6);
    for (const name of Object.keys(archive).filter((name) => name.endsWith(".rels"))) expect(Buffer.from(archive[name]).toString("utf8")).not.toContain('TargetMode="External"');
  });
  it("validates direct calls instead of bypassing the stdin boundary", async () => {
    await expect(renderDocument({ version: 1, format: "docx", fileName: "../unsafe.docx", title: "No", blocks: [{ type: "paragraph", text: "No" }] })).rejects.toThrow();
  });
});
