import { describe, expect, it } from "vitest";
import { parseRendererRequest } from "../../../../src/source-documents/renderer/validation.js";

const request = { version: 1, format: "pdf", fileName: "Tender.pdf", title: "Tender summary", blocks: [{ type: "paragraph", text: "Résumé Ελληνικά हिंदी ಕನ್ನಡ" }] };
const parse = (value: unknown) => parseRendererRequest(Buffer.from(JSON.stringify(value)));

describe("bounded document input", () => {
  it("accepts the versioned text, heading, list and rectangular table contract", () => {
    const value = { ...request, blocks: [...request.blocks, { type: "heading", level: 2, text: "Details" }, { type: "list", ordered: true, items: ["First", "Second"] }, { type: "table", headers: ["Name", "Value"], rows: [["Reference", "003"]] }] };
    expect(parse(value)).toEqual(value);
  });
  it.each(["../Tender.pdf", "C:\\Tender.pdf", "Tender.docx", "Tender\n.pdf", "CON.pdf", "a".repeat(129) + ".pdf"])("rejects unsafe or mismatched filename %j", (fileName) => {
    expect(() => parse({ ...request, fileName })).toThrow();
  });
  it.each([
    { ...request, version: 2 }, { ...request, format: "html" }, { ...request, title: "x".repeat(201) },
    { ...request, url: "https://example.com" }, { ...request, blocks: [] },
    { ...request, blocks: Array.from({ length: 201 }, () => request.blocks[0]) },
    { ...request, blocks: [{ type: "paragraph", text: "x", script: "execute" }] },
    { ...request, blocks: [{ type: "paragraph", text: "\u0000" }] },
    { ...request, blocks: [{ type: "paragraph", text: "\ud800" }] },
    { ...request, blocks: [{ type: "heading", level: 4, text: "No" }] },
    { ...request, blocks: [{ type: "list", ordered: "yes", items: ["No"] }] },
    { ...request, blocks: [{ type: "list", ordered: false, items: Array(101).fill("No") }] },
    { ...request, blocks: [{ type: "table", headers: ["A", "B"], rows: [["missing"]] }] },
    { ...request, blocks: [{ type: "table", headers: Array(21).fill("A"), rows: [] }] },
    { ...request, blocks: [{ type: "table", headers: ["A"], rows: Array(201).fill(["A"]) }] },
    { ...request, blocks: [{ type: "paragraph", text: "x".repeat(100001) }] },
  ])("rejects unsupported fields, types, control text and excess content", (value) => { expect(() => parse(value)).toThrow(); });
  it("rejects malformed UTF8, excess JSON bytes and trailing JSON", () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(512 * 1024 + 1, 32), Buffer.from(JSON.stringify(request) + "{}")]) expect(() => parseRendererRequest(bytes)).toThrow();
  });
  it("keeps URL and markup shaped text inert rather than interpreting it", () => {
    const value = { ...request, blocks: [{ type: "paragraph", text: '<script>alert(1)</script> https://example.com' }] };
    expect(parse(value)).toEqual(value);
  });
});
