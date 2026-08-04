import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FileArtifactDescriptor } from '../../../domain/file-artifacts/file-artifact.js';
declare const fileToolSchema: {
    action: z.ZodEnum<{
        read: "read";
        write: "write";
        list: "list";
        promote_scratch: "promote_scratch";
    }>;
    artifactId: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    readLimit: z.ZodOptional<z.ZodNumber>;
    content: z.ZodOptional<z.ZodString>;
    encoding: z.ZodOptional<z.ZodEnum<{
        utf8: "utf8";
        base64: "base64";
    }>>;
    contentType: z.ZodOptional<z.ZodString>;
    targetScope: z.ZodOptional<z.ZodString>;
    targetPath: z.ZodOptional<z.ZodString>;
    protected: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
};
export declare function registerFileTools(server: McpServer): void;
export declare function handleFileToolAction(args: z.infer<z.ZodObject<typeof fileToolSchema>>): Promise<string>;
export declare function measureFileToolPayloadSize(value: unknown): number;
export declare function descriptorPayloadBytes(descriptors: readonly FileArtifactDescriptor[]): number;
export {};
