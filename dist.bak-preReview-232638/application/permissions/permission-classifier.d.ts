export type PermissionClassifierRequestFamily = 'tool' | 'admin' | 'review' | 'promotion';
export declare function isPermissionClassifierEligible(canonicalToolName: string, requestFamily: PermissionClassifierRequestFamily): boolean;
