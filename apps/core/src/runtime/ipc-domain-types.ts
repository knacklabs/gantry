import { AvailableGroup } from './agent-spawn.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RegisteredGroup,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: { threadId?: string },
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => Promise<void> | void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => Promise<AvailableGroup[]> | AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => Promise<void> | void;
  onSchedulerChanged: (jobId?: string) => void;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  mcpHostnameLookup?: HostnameLookup;
  opsRepository: OpsRepository;
}

export interface IpcDomainContext {
  sourceGroup: string;
  isMain: boolean;
  browserProfileName?: string;
  ipcBaseDir: string;
  deps: IpcDeps;
}

export interface IpcDomainHandler<TRequest, TResponse = void> {
  handle(request: TRequest, context: IpcDomainContext): Promise<TResponse>;
}
