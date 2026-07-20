import type {
  AddPersonAliasRequest,
  IdentityEvidenceType,
  IdentityResolveRequest,
  IdentityResolveResponse,
  PersonAliasResponse,
  PersonAliasVerificationStatus,
  PersonMergeApplyResponse,
  PersonMergeApplyRequest,
  PersonMergeConflictResolution,
  PersonMergeRequest,
  PersonMergePreviewResponse,
  PeopleListResponse,
  PersonResponse,
} from '@gantry/contracts';

import { querySuffix } from './query-string.js';
import type { RequestOptions } from './types.js';

export type {
  IdentityEvidenceType,
  PersonAliasVerificationStatus,
  PersonMergeConflictResolution,
};

export type IdentityResolveInput = IdentityResolveRequest;
export type PersonAliasInput = AddPersonAliasRequest;
export type PersonMergeInput = PersonMergeRequest;
export type PeopleListInput = {
  appId?: string;
  limit?: number;
  cursor?: string;
};

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
    list: (input: PeopleListInput = {}) =>
      request<PeopleListResponse>({
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
      apply: (personId: string, input: PersonMergeApplyRequest) =>
        request<PersonMergeApplyResponse>({
          method: 'POST',
          path: `/v1/people/${encodeURIComponent(personId)}/merge`,
          body: input,
        }),
    },
  };
}
