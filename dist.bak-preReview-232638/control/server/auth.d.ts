import type { IncomingMessage } from 'node:http';
import { type ApiKeyRecord, type Scope } from '../../shared/control-api-keys.js';
export type { ApiKeyRecord, Scope } from '../../shared/control-api-keys.js';
export type AuthenticationResult = {
    status: 'authenticated';
    key: ApiKeyRecord;
} | {
    status: 'missing' | 'invalid';
} | {
    status: 'forbidden';
    key: ApiKeyRecord;
    missingScopes: Scope[];
};
export { CONTROL_API_SCOPES, parseControlApiKeys, parseControlApiKeysStrict, } from '../../shared/control-api-keys.js';
export { isValidControlId } from '../../shared/control-id.js';
export declare function authenticate(req: IncomingMessage, requiredScopes: Scope[], keys: ApiKeyRecord[]): AuthenticationResult;
