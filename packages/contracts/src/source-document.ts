import { z } from 'zod';
import { SourceBindingSchema } from './sessions/source-channel.js';
const id = z.string().min(1).max(256);
export const SourceDocumentArtifactReceiptSchema = z
  .object({
    artifactId: id,
    sessionId: id,
    runId: id,
    answerGoalId: id,
    attemptId: id,
    binding: SourceBindingSchema,
    format: z.enum(['pdf', 'docx']),
    fileName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^/\\\x00-\x1f]+\.(pdf|docx)$/),
    contentType: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    rendererVersion: z.string().min(1).max(100),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    canonicalContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    conversion: z.object({artifactId:id,sourceMessageId:id,sha256:z.string().regex(/^[a-f0-9]{64}$/),manifestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
    citationIds: z.array(id).max(100),
    metadataFields: z.array(id).max(100),
  })
  .strict().superRefine((receipt,ctx)=>{
    if(receipt.conversion&&!receipt.canonicalContentHash)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Conversion requires canonical content integrity'});
  });
export const ReadSourceDocumentSchema = z
  .object({
    artifactId: id,
    answerGoalId: id,
    attemptId: id,
    binding: SourceBindingSchema,
  })
  .strict();
export type SourceDocumentArtifactReceipt = z.infer<
  typeof SourceDocumentArtifactReceiptSchema
>;
export type ReadSourceDocument = z.infer<typeof ReadSourceDocumentSchema>;
/** Bounded JSON transport only. SDK wrapper returns decoded bytes to the host, never to the model. */
export const ReadSourceDocumentResponseSchema = z
  .object({
    receipt: SourceDocumentArtifactReceiptSchema,
    bytesBase64: z.string().max(11184812),
  })
  .strict();
export type ReadSourceDocumentResponse = z.infer<
  typeof ReadSourceDocumentResponseSchema
>;
export const ConvertSourceDocumentRequestSchema=z.object({convertExistingArtifactId:id,targetFormat:z.enum(['pdf','docx'])}).strict();
export type ConvertSourceDocumentRequest=z.infer<typeof ConvertSourceDocumentRequestSchema>;
