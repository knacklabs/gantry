import type { PermissionCallbackClaim, PermissionCallbackClaimReference, PermissionCallbackScope } from '../../domain/types.js';
export declare function samePermissionCallbackLocator(left: {
    providerAlias: string;
    matchKind: PermissionCallbackClaim['match']['kind'];
    scope: PermissionCallbackScope;
}, right: {
    providerAlias: string;
    matchKind: PermissionCallbackClaim['match']['kind'];
    scope: PermissionCallbackScope;
}): boolean;
export declare function permissionClaimReference(claim: PermissionCallbackClaim): PermissionCallbackClaimReference;
export declare function samePermissionClaim(claim: PermissionCallbackClaim, reference: PermissionCallbackClaimReference): boolean;
export declare function isAllowedPermissionApproverIdentity(mode: PermissionCallbackClaim['intent']['mode'], approverRef: string): boolean;
