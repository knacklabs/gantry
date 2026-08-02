import { type BrainEdgeType, type BrainEntityKind, type BrainPageSourceKind } from './brain-types.js';
export interface ParsedBrainMarkdown {
    frontmatter: Record<string, unknown>;
    body: string;
    title: string;
}
export interface BrainEntityRef {
    kind: BrainEntityKind;
    name: string;
}
export interface BrainEdgeRef {
    type: BrainEdgeType;
    from: BrainEntityRef;
    to: BrainEntityRef;
}
export interface BrainPageExtraction {
    entities: BrainEntityRef[];
    edges: BrainEdgeRef[];
}
export declare function normalizeBrainSlug(value: string): string;
export declare function normalizeEntityName(value: string): string;
export declare function brainEmbeddingText(input: {
    title: string;
    markdown: string;
}): string;
export declare function brainContentHash(input: {
    title: string;
    markdown: string;
}): string;
export declare function parseBrainMarkdown(markdown: string): ParsedBrainMarkdown;
export declare function sourceKindFromFrontmatter(value: unknown, fallback: BrainPageSourceKind): BrainPageSourceKind;
export declare function extractBrainPageRefs(parsed: ParsedBrainMarkdown): BrainPageExtraction;
