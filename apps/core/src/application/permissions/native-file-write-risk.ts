import { evaluateProspectiveWriteBoundary } from '../../shared/permission-prospective-write.js';
import {
  GantryToolRiskVerdict,
  type GantryToolRisk,
} from './gantry-tool-risk.js';

export async function judgeNativeFileWrite(input: {
  toolName: string;
  toolInput: unknown;
  workspaceRoot?: string;
}): Promise<GantryToolRisk> {
  if (input.toolName !== 'FileWrite' && input.toolName !== 'FileEdit') {
    return {
      verdict: GantryToolRiskVerdict.Ambiguous,
      reason: 'unsupported native file-write tool',
    };
  }
  const row =
    input.toolInput &&
    typeof input.toolInput === 'object' &&
    !Array.isArray(input.toolInput)
      ? (input.toolInput as Record<string, unknown>)
      : {};
  const destinations = [row.file_path, row.path].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (destinations.length === 0) {
    return {
      verdict: GantryToolRiskVerdict.Ambiguous,
      reason: 'native file-write destination is missing',
    };
  }
  for (const candidatePath of destinations) {
    const boundary = await evaluateProspectiveWriteBoundary({
      workspaceRoot: input.workspaceRoot,
      candidatePath,
    });
    if (!boundary.inside) {
      return {
        verdict: GantryToolRiskVerdict.High,
        reason: boundary.reason ?? 'write boundary could not be verified',
      };
    }
  }
  return {
    verdict: GantryToolRiskVerdict.Low,
    reason: 'native file write inside workspace',
  };
}
