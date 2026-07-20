import { ApplicationError } from '../common/application-error.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { stableSha256Json } from '../../shared/stable-hash.js';

export type AliasVerificationStatus = 'verified' | 'unverified' | 'retired';
export type IdentityEvidenceType =
  | 'provider_user'
  | 'email'
  | 'phone'
  | 'web_user';

export interface PersonRecord {
  personId: string;
  appId: string;
  kind: 'human' | 'service';
  displayName?: string | null;
  status: 'active' | 'disabled' | 'archived';
  createdAt: string;
  updatedAt: string;
  aliases?: PersonAliasRecord[];
  aliasCounts?: Record<AliasVerificationStatus, number>;
  memoryCounts?: {
    personal: number;
    active: number;
    archived: number;
    superseded: number;
    deleted: number;
  };
}

export interface PersonListCursor {
  updatedAt: string;
  personId: string;
}

export interface PersonListRepositoryPage {
  people: PersonRecord[];
  nextCursor: PersonListCursor | null;
}

export interface PersonListPage {
  people: PersonRecord[];
  nextCursor: string | null;
}

export interface PersonListInput {
  limit?: number;
  cursor?: string;
}

export interface PersonListRepositoryInput {
  limit: number;
  cursor?: PersonListCursor;
}

export interface PersonAliasRecord {
  id: string;
  appId: string;
  personId: string;
  provider: string;
  providerAccountId?: string | null;
  externalUserId: string;
  displayName?: string | null;
  verificationStatus: AliasVerificationStatus;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  retiredAt?: string | null;
  retiredBy?: string | null;
  evidence?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityResolveInput {
  appId: string;
  provider: string;
  providerAccountId?: string | null;
  externalUserId: string;
  displayName?: string | null;
  evidenceType: IdentityEvidenceType;
  createIfMissing?: boolean;
}

export interface IdentityResolveResult {
  status: 'resolved' | 'created' | 'unresolved';
  personId: string | null;
  memoryHydrationEligible: boolean;
  matchedAlias?: PersonAliasRecord;
  createdAlias?: PersonAliasRecord;
  verificationStatus?: AliasVerificationStatus;
}

export interface AddPersonAliasInput {
  appId: string;
  personId: string;
  provider: string;
  providerAccountId?: string | null;
  externalUserId: string;
  displayName?: string | null;
  evidenceType: IdentityEvidenceType;
  evidence?: Record<string, unknown>;
  actor: string;
}

export interface RetirePersonAliasInput {
  appId: string;
  personId: string;
  aliasId: string;
  actor: string;
}

export interface PersonMergeConflict {
  type?: 'memory' | 'alias';
  sourceMemoryId?: string;
  targetMemoryId?: string;
  sourceAliasId?: string;
  targetAliasId?: string;
  agentId?: string | null;
  kind: string;
  key: string;
}

export interface PersonMergePreview {
  summary: 'Merge preview only. No data changed.';
  sourcePersonId: string;
  targetPersonId: string;
  aliasesToMove: PersonAliasRecord[];
  memoryRowsToMove: number;
  excludedMemoryScopes: {
    group: number;
    channel: number;
    common: number;
  };
  conflicts: PersonMergeConflict[];
  fingerprint?: string;
  memoryRowsFingerprint?: string;
}

export interface PersonMergeApplyResult extends Omit<
  PersonMergePreview,
  'summary'
> {
  summary: 'Person merge completed. Personal memory and aliases now belong to the target person.';
  idempotencyKey: string;
  auditId: string;
  applied: boolean;
}

export interface PersonMergeInput {
  appId: string;
  targetPersonId: string;
  sourcePersonId: string;
  idempotencyKey?: string;
  actor: string;
  conflictResolution?: 'fail_on_conflict' | 'keep_target';
  expectedFingerprint?: string;
}

export function personMergeFingerprint(
  preview: Omit<PersonMergePreview, 'fingerprint'>,
): string {
  const canonical = {
    sourcePersonId: preview.sourcePersonId,
    targetPersonId: preview.targetPersonId,
    aliasesToMove: [...preview.aliasesToMove]
      .map((alias) => ({
        id: alias.id,
        personId: alias.personId,
        appId: alias.appId,
        provider: alias.provider,
        providerAccountId: alias.providerAccountId ?? null,
        externalUserId: alias.externalUserId,
        verificationStatus: alias.verificationStatus,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    memoryRowsToMove: preview.memoryRowsToMove,
    memoryRowsFingerprint: preview.memoryRowsFingerprint ?? null,
    excludedMemoryScopes: preview.excludedMemoryScopes,
    conflicts: [...preview.conflicts].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  };
  return `sha256:${stableSha256Json(canonical)}`;
}

export interface PersonIdentityRepository {
  resolveIdentity(
    input: IdentityResolveInput,
    auditEventFactory?: (
      result: IdentityResolveResult,
    ) => RuntimeEventPublishInput,
  ): Promise<IdentityResolveResult>;
  listPeople(
    appId: string,
    input: PersonListRepositoryInput,
  ): Promise<PersonListRepositoryPage>;
  getPerson(appId: string, personId: string): Promise<PersonRecord | null>;
  addAlias(
    input: AddPersonAliasInput,
    auditEventFactory?: (alias: PersonAliasRecord) => RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord>;
  retireAlias(
    input: RetirePersonAliasInput,
    auditEventFactory?: (alias: PersonAliasRecord) => RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord | null>;
  previewMerge(input: PersonMergeInput): Promise<PersonMergePreview>;
  mergePeople(input: PersonMergeInput): Promise<PersonMergeApplyResult>;
  mergePeople(
    input: PersonMergeInput,
    auditEventFactory?: (
      result: PersonMergeApplyResult,
    ) => RuntimeEventPublishInput,
  ): Promise<PersonMergeApplyResult>;
}

export class PersonIdentityService {
  constructor(
    private readonly repository: PersonIdentityRepository,
    private readonly normalizeProvider: (provider: string) => string = (
      provider,
    ) => provider.trim().toLowerCase(),
  ) {}

  async resolve(
    input: IdentityResolveInput,
    auditEventFactory?: (
      result: IdentityResolveResult,
    ) => RuntimeEventPublishInput,
  ): Promise<IdentityResolveResult> {
    const normalized = this.normalizeAliasInput(input);
    return this.repository.resolveIdentity(
      {
        ...normalized,
        createIfMissing: input.createIfMissing !== false,
      },
      auditEventFactory,
    );
  }

  async listPeople(
    appId: string,
    input: PersonListInput = {},
  ): Promise<PersonListPage> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'limit must be an integer between 1 and 200',
      );
    }
    const page = await this.repository.listPeople(appId, {
      limit,
      cursor: input.cursor ? this.decodeListCursor(input.cursor) : undefined,
    });
    return {
      people: page.people,
      nextCursor: page.nextCursor
        ? Buffer.from(
            JSON.stringify([
              page.nextCursor.updatedAt,
              page.nextCursor.personId,
            ]),
          ).toString('base64url')
        : null,
    };
  }

  async getPerson(appId: string, personId: string): Promise<PersonRecord> {
    const person = await this.repository.getPerson(appId, personId);
    if (!person) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Person is not accessible to this app.',
      );
    }
    return person;
  }

  async addAlias(
    input: AddPersonAliasInput,
    auditEventFactory?: (alias: PersonAliasRecord) => RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord> {
    return this.repository.addAlias(
      this.normalizeAliasInput(input),
      auditEventFactory,
    );
  }

  async retireAlias(
    input: RetirePersonAliasInput,
    auditEventFactory?: (alias: PersonAliasRecord) => RuntimeEventPublishInput,
  ): Promise<PersonAliasRecord> {
    const alias = await this.repository.retireAlias(input, auditEventFactory);
    if (!alias) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Person is not accessible to this app.',
      );
    }
    return alias;
  }

  previewMerge(input: PersonMergeInput): Promise<PersonMergePreview> {
    return this.repository.previewMerge(input).then((preview) => ({
      ...preview,
      fingerprint: personMergeFingerprint(preview),
    }));
  }

  async mergePeople(
    input: PersonMergeInput,
    auditEventFactory?: (
      result: PersonMergeApplyResult,
    ) => RuntimeEventPublishInput,
  ): Promise<PersonMergeApplyResult> {
    return this.repository.mergePeople(
      {
        ...input,
        conflictResolution: input.conflictResolution ?? 'fail_on_conflict',
      },
      auditEventFactory,
    );
  }

  private normalizeAliasInput<
    T extends { provider: string; externalUserId: string },
  >(input: T): T {
    const provider = this.normalizeProvider(input.provider);
    if (!provider) {
      throw new ApplicationError('INVALID_REQUEST', 'provider is required');
    }
    if (!input.externalUserId.trim()) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'externalUserId is required',
      );
    }
    return { ...input, provider };
  }

  private decodeListCursor(cursor: string): PersonListCursor {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 2 ||
        typeof decoded[0] !== 'string' ||
        Number.isNaN(Date.parse(decoded[0])) ||
        typeof decoded[1] !== 'string' ||
        !decoded[1]
      ) {
        throw new Error();
      }
      return { updatedAt: decoded[0], personId: decoded[1] };
    } catch {
      throw new ApplicationError('INVALID_REQUEST', 'cursor is invalid');
    }
  }
}
