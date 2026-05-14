import type { PermissionApprovalUpdate } from '../domain/types.js';
import { requestPermissionReviewSuggestions } from './request-permission-review.js';

export interface CollectedPrimeToolAttempt {
  requestedToolName: string;
  toolName: string;
  toolInput?: unknown;
  suggestions?: unknown[];
}

export interface JobPrimingSuggestion {
  toolName: string;
  requestedToolName: string;
  suggestions: PermissionApprovalUpdate[];
}

export class JobPrimingService {
  formatPermissionSuggestions(
    attempts: readonly CollectedPrimeToolAttempt[],
  ): JobPrimingSuggestion[] {
    const formatted: JobPrimingSuggestion[] = [];
    const seen = new Set<string>();

    for (const attempt of attempts) {
      const suggestions = normalizeSuggestionList(
        attempt.suggestions ??
          requestPermissionReviewSuggestions({
            permissionKind: 'tool',
            toolName: attempt.toolName,
          }),
      );
      if (!suggestions) continue;

      const key = JSON.stringify({
        toolName: attempt.toolName,
        requestedToolName: attempt.requestedToolName,
        suggestions,
      });
      if (seen.has(key)) continue;
      seen.add(key);

      formatted.push({
        toolName: attempt.toolName,
        requestedToolName: attempt.requestedToolName,
        suggestions,
      });
    }

    return formatted;
  }
}

function normalizeSuggestionList(
  suggestions: unknown,
): PermissionApprovalUpdate[] | undefined {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return undefined;
  }
  return suggestions as PermissionApprovalUpdate[];
}
