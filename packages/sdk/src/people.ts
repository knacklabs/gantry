import type { RequestOptions } from './types.js';
import { querySuffix } from './query-string.js';
import type {
  IdentityResolveResponse,
  PersonAliasResponse,
  PersonMergeApplyResponse,
  PersonMergePreviewResponse,
  PersonResponse,
} from '@gantry/contracts';

export type IdentityEvidenceType =
  | 'provider_user'
  | 'email'
  | 'phone'
  | 'web_user';
export type PersonAliasVerificationStatus =
  | 'verified'
  | 'unverified'
  | 'retired';
export type PersonMergeConflictResolution = 'fail_on_conflict' | 'keep_target';

export interface IdentityResolveInput {
  appId?: string;
  provider: string;
  providerAccountId?: string | null;
  externalUserId: string;
  displayName?: string | null;
  evidenceType: IdentityEvidenceType;
  createIfMissing?: boolean;
}

export interface PersonAliasInput {
  appId?: string;
  provider: string;
  providerAccountId?: string | null;
  externalUserId: string;
  displayName?: string | null;
  evidenceType: IdentityEvidenceType;
  evidence?: Record<string, unknown>;
}

export interface PersonMergeInput {
  appId?: string;
  sourcePersonId: string;
  idempotencyKey?: string;
  conflictResolution?: PersonMergeConflictResolution;
}

type Requester = <T>(options: RequestOptions) => Promise<T>;

export function createIdentityClient(request: Requester) {
  return {
    resolve: (input: IdentityResolveInput) =>
      request<IdentityResolveResponse>({
        method: 'POST',
        path: '/v1/identity/resolve',
        body: input,
      }),
  };
}

export function createPeopleClient(request: Requester) {
  return {
    list: (input: { appId?: string } = {}) =>
      request<{ people: PersonResponse[] }>({
        method: 'GET',
        path: `/v1/people${querySuffix(input)}`,
      }),
    get: (personId: string, input: { appId?: string } = {}) =>
      request<{ person: PersonResponse }>({
        method: 'GET',
        path: `/v1/people/${encodeURIComponent(personId)}${querySuffix(input)}`,
      }),
    aliases: {
      add: (personId: string, input: PersonAliasInput) =>
        request<{ alias: PersonAliasResponse }>({
          method: 'POST',
          path: `/v1/people/${encodeURIComponent(personId)}/aliases`,
          body: input,
        }),
      retire: (
        personId: string,
        aliasId: string,
        input: { appId?: string } = {},
      ) =>
        request<{ alias: PersonAliasResponse }>({
          method: 'DELETE',
          path: `/v1/people/${encodeURIComponent(personId)}/aliases/${encodeURIComponent(aliasId)}${querySuffix(input)}`,
        }),
    },
    merge: {
      preview: (personId: string, input: PersonMergeInput) =>
        request<PersonMergePreviewResponse>({
          method: 'POST',
          path: `/v1/people/${encodeURIComponent(personId)}/merge:preview`,
          body: input,
        }),
      apply: (personId: string, input: PersonMergeInput) =>
        request<PersonMergeApplyResponse>({
          method: 'POST',
          path: `/v1/people/${encodeURIComponent(personId)}/merge`,
          body: input,
        }),
    },
  };
}
