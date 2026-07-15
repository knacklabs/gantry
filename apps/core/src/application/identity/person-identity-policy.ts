import { ApplicationError } from '../common/application-error.js';

export function assertAliasTargetIsActive(status: string): void {
  if (status !== 'active') {
    throw new ApplicationError(
      'CONFLICT',
      'Aliases cannot be added to an inactive person.',
    );
  }
}

export function assertAliasOwnership(
  ownerPersonId: string | null | undefined,
  requestedPersonId: string,
): void {
  if (ownerPersonId && ownerPersonId !== requestedPersonId) {
    throw new ApplicationError(
      'CONFLICT',
      'Alias already belongs to another person.',
    );
  }
}

export function assertRetiredAliasCanBeRebound(
  ownerPersonId: string | null | undefined,
  requestedPersonId: string,
): void {
  if (ownerPersonId && ownerPersonId !== requestedPersonId) {
    throw new ApplicationError(
      'CONFLICT',
      'Retired alias belongs to another person and cannot be rebound.',
    );
  }
}

export function assertAliasCanResolve(retired: boolean): void {
  if (retired) {
    throw new ApplicationError(
      'CONFLICT',
      'Alias is retired and cannot resolve active personal memory.',
    );
  }
}

export function assertMergeablePeople(
  rows: Array<{ status: string }>,
  targetPersonId: string,
  sourcePersonId: string,
): void {
  if (targetPersonId === sourcePersonId) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'sourcePersonId must differ from target personId',
    );
  }
  if (rows.length !== 2) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Person is not accessible to this app.',
    );
  }
  if (rows.some((row) => row.status !== 'active')) {
    throw new ApplicationError(
      'CONFLICT',
      'Source and target people must both be active and unmerged.',
    );
  }
}

export function assertMergeConflicts(
  aliasConflictCount: number,
  memoryConflictCount: number,
  conflictResolution: 'fail_on_conflict' | 'keep_target',
): void {
  if (aliasConflictCount > 0) {
    throw new ApplicationError(
      'CONFLICT',
      'Merge has alias conflicts. Resolve aliases before applying the merge.',
    );
  }
  if (memoryConflictCount > 0 && conflictResolution === 'fail_on_conflict') {
    throw new ApplicationError(
      'CONFLICT',
      'Merge has personal memory conflicts. Run preview and choose a conflictResolution.',
    );
  }
}

export function assertDetailLimit(
  kind: 'alias' | 'conflict',
  count: number,
  limit: number,
): void {
  if (count > limit) {
    throw new ApplicationError(
      'CONFLICT',
      `Person merge exceeds the ${limit} ${kind} detail limit.`,
    );
  }
}
