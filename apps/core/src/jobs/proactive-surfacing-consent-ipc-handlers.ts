import { createHash } from 'node:crypto';

import type {
  ProactiveSurfacingOptIn,
  ProactiveSurfacingSubject,
} from '../adapters/storage/postgres/repositories/proactive-surfacing-repository.postgres.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { patternSubjectForScope } from '../shared/pattern-candidate-subject.js';
import { nowIso } from '../shared/time/datetime.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

type ProactiveSurfacingRepository = {
  getBySubject(
    subject: ProactiveSurfacingSubject,
  ): Promise<ProactiveSurfacingOptIn | null>;
  setEnabled(input: {
    subject: ProactiveSurfacingSubject;
    id: string;
    actorId?: string | null;
    nowIso: string;
  }): Promise<ProactiveSurfacingOptIn>;
  setOptedOut(input: {
    subject: ProactiveSurfacingSubject;
    actorId?: string | null;
    nowIso: string;
  }): Promise<ProactiveSurfacingOptIn | null>;
};

type ProactiveSurfacingConsentRuntimeDeps = {
  getStorage: () => {
    repositories: {
      proactiveSurfacing?: ProactiveSurfacingRepository;
    };
  };
};

let runtimeDeps: ProactiveSurfacingConsentRuntimeDeps | null = null;

export function configureProactiveSurfacingConsentIpcHandlers(
  deps: ProactiveSurfacingConsentRuntimeDeps,
): void {
  runtimeDeps = deps;
}

function getRuntimeDeps(): ProactiveSurfacingConsentRuntimeDeps {
  if (!runtimeDeps) {
    throw new Error(
      'Proactive surfacing consent IPC handlers are not configured.',
    );
  }
  return runtimeDeps;
}

function proactiveSurfacingId(subject: ProactiveSurfacingSubject): string {
  const digest = createHash('sha256')
    .update(
      [
        subject.appId,
        subject.agentId,
        subject.subjectType,
        subject.subjectId,
      ].join('\0'),
    )
    .digest('hex');
  return `ps_${digest}`;
}

export const proactiveSurfacingConsentHandler: TaskHandler = async (
  context,
) => {
  const { accept, reject } = createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
  const { data, sourceAgentFolder } = context;
  const payload = data.payload || {};
  if (!data.appId) {
    reject(
      'Proactive surfacing consent requires signed app scope.',
      'forbidden',
    );
    return;
  }
  const choice = toTrimmedString(payload.choice, { maxLen: 32 });
  if (choice !== 'enable' && choice !== 'opt_out') {
    reject('Invalid proactive surfacing consent choice.', 'invalid_request');
    return;
  }
  if (!data.memoryUserId) {
    reject(
      'Proactive surfacing consent change requires a real user reply this turn.',
      'forbidden',
    );
    return;
  }
  const conversationKind = toTrimmedString(payload.conversationKind, {
    maxLen: 32,
  });
  if (conversationKind !== 'dm' && conversationKind !== 'channel') {
    reject('Invalid proactive surfacing conversation kind.', 'invalid_request');
    return;
  }
  const targetJid = data.targetJid || data.chatJid || '';
  if (!context.sourceAgentFolderJids.includes(targetJid)) {
    reject(
      'Proactive surfacing consent must target a chat bound to the requesting agent.',
      'forbidden',
    );
    return;
  }
  const repo = getRuntimeDeps().getStorage().repositories.proactiveSurfacing;
  if (!repo) {
    reject(
      'Proactive surfacing repository is not available.',
      'preflight_failed',
    );
    return;
  }
  const subjectTuple = patternSubjectForScope({
    appId: data.appId,
    agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder),
    folder: sourceAgentFolder,
    conversationId: targetJid,
    conversationKind,
    userId: data.memoryUserId,
  });
  if (!subjectTuple) {
    reject('Proactive surfacing subject is not valid.', 'invalid_request');
    return;
  }
  const subject: ProactiveSurfacingSubject = {
    appId: subjectTuple.appId,
    agentId: subjectTuple.agentId,
    subjectType: subjectTuple.subjectType,
    subjectId: subjectTuple.subjectId,
  };
  if (choice === 'enable') {
    await repo.setEnabled({
      subject,
      id: proactiveSurfacingId(subject),
      actorId: data.memoryUserId,
      nowIso: nowIso(),
    });
    accept('Proactive surfacing enabled.', 'proactive_surfacing_enabled');
    return;
  }
  await repo.setOptedOut({
    subject,
    actorId: data.memoryUserId,
    nowIso: nowIso(),
  });
  accept('Proactive surfacing opted out.', 'proactive_surfacing_opted_out');
};
