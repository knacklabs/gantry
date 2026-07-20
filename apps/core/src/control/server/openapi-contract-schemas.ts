import {
  AgentHarnessSchema,
  AgentProfileFileContentResponseSchema,
  AgentProfileFileKindSchema,
  AgentProfileFilesResponseSchema,
  AgentProfileFileSummarySchema,
  ConversationInstallListResponseSchema,
  ConversationInstallRouteRequestSchema,
  ConversationInstallResponseSchema,
  ConversationInstallRouteConfigSchema,
  ListModelsResponseSchema,
  ModelDefaultsPatchRequestSchema,
  ModelDefaultsResponseSchema,
  ModelDefaultSlotSchema,
  ModelPreviewRequestSchema,
  ModelPreviewResponseSchema,
  ModelRecordSchema,
  ModelWorkloadSchema,
  PutAgentProfileFileRequestSchema,
  RuntimeSettingsResponseSchema,
  SettingsDesiredStateResponseSchema,
  SettingsDesiredStateUpdateRequestSchema,
  SettingsDesiredStateUpdateResponseSchema,
  SettingsDocumentSchema,
  SettingsRevisionsResponseSchema,
  SettingsRevisionSummarySchema,
} from '@gantry/contracts';
import { z } from 'zod';

import type { JsonSchema } from './openapi-route-helpers.js';

function projectContractSchemas(
  schemas: Record<string, z.ZodType>,
): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) {
    registry.add(schema, { id });
  }
  const projected = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
  }).schemas;
  return Object.fromEntries(
    Object.entries(projected).map(([id, schema]) => {
      const component = { ...schema } as JsonSchema;
      delete component.$id;
      delete component.$schema;
      return [id, component];
    }),
  );
}

export const contractOpenApiSchemas = projectContractSchemas({
  AgentHarness: AgentHarnessSchema,
  AgentProfileFileKind: AgentProfileFileKindSchema,
  AgentProfileFileSummary: AgentProfileFileSummarySchema,
  AgentProfileFilesResponse: AgentProfileFilesResponseSchema,
  AgentProfileFileContentResponse: AgentProfileFileContentResponseSchema,
  PutAgentProfileFileRequest: PutAgentProfileFileRequestSchema,
  ModelWorkload: ModelWorkloadSchema,
  Model: ModelRecordSchema,
  ModelListResponse: ListModelsResponseSchema,
  ModelDefaultSlot: ModelDefaultSlotSchema,
  ModelDefaultsResponse: ModelDefaultsResponseSchema,
  ModelDefaultsPatchRequest: ModelDefaultsPatchRequestSchema,
  ModelPreviewRequest: ModelPreviewRequestSchema,
  ModelPreviewResponse: ModelPreviewResponseSchema,
  SettingsResponse: RuntimeSettingsResponseSchema,
  SettingsDocument: SettingsDocumentSchema,
  SettingsDesiredStateResponse: SettingsDesiredStateResponseSchema,
  SettingsDesiredStateUpdateRequest: SettingsDesiredStateUpdateRequestSchema,
  SettingsDesiredStateUpdateResponse: SettingsDesiredStateUpdateResponseSchema,
  SettingsRevisionSummary: SettingsRevisionSummarySchema,
  SettingsRevisionsResponse: SettingsRevisionsResponseSchema,
  ConversationInstallRouteConfig: ConversationInstallRouteConfigSchema,
  ConversationInstallRouteRequest: ConversationInstallRouteRequestSchema,
  ConversationInstall: ConversationInstallResponseSchema,
  ConversationInstallListResponse: ConversationInstallListResponseSchema,
});
