import { ApplicationError } from '../common/application-error.js';

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
}

export interface PersonIdentityRepository {
  resolveIdentity(input: IdentityResolveInput): Promise<IdentityResolveResult>;
  listPeople(appId: string): Promise<PersonRecord[]>;
  getPerson(appId: string, personId: string): Promise<PersonRecord | null>;
  addAlias(input: AddPersonAliasInput): Promise<PersonAliasRecord>;
  retireAlias(input: RetirePersonAliasInput): Promise<PersonAliasRecord | null>;
  previewMerge(input: PersonMergeInput): Promise<PersonMergePreview>;
  mergePeople(input: PersonMergeInput): Promise<PersonMergeApplyResult>;
}

export class PersonIdentityService {
  constructor(private readonly repository: PersonIdentityRepository) {}

  async resolve(input: IdentityResolveInput): Promise<IdentityResolveResult> {
    this.validateAliasInput(input);
    return this.repository.resolveIdentity({
      ...input,
      createIfMissing: input.createIfMissing !== false,
    });
  }

  listPeople(appId: string): Promise<PersonRecord[]> {
    return this.repository.listPeople(appId);
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

  async addAlias(input: AddPersonAliasInput): Promise<PersonAliasRecord> {
    this.validateAliasInput(input);
    return this.repository.addAlias(input);
  }

  async retireAlias(input: RetirePersonAliasInput): Promise<PersonAliasRecord> {
    const alias = await this.repository.retireAlias(input);
    if (!alias) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Person is not accessible to this app.',
      );
    }
    return alias;
  }

  previewMerge(input: PersonMergeInput): Promise<PersonMergePreview> {
    return this.repository.previewMerge(input);
  }

  mergePeople(input: PersonMergeInput): Promise<PersonMergeApplyResult> {
    return this.repository.mergePeople({
      ...input,
      conflictResolution: input.conflictResolution ?? 'fail_on_conflict',
    });
  }

  private validateAliasInput(input: {
    provider: string;
    externalUserId: string;
  }): void {
    if (!input.provider.trim()) {
      throw new ApplicationError('INVALID_REQUEST', 'provider is required');
    }
    if (!input.externalUserId.trim()) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'externalUserId is required',
      );
    }
  }
}
