import type { AppResponseRouteRecord, AppSessionRecord, ControlEventRecord, JobTriggerRecord, WebhookDeliveryRecord, WebhookRegistrationRecord } from './control-plane-records.postgres.js';
export type CanonicalControlRow = Record<string, unknown>;
export declare function text(value: unknown): string | null;
export declare function mapSession(row: CanonicalControlRow): AppSessionRecord;
export declare function mapRoute(row: CanonicalControlRow): AppResponseRouteRecord;
export declare function mapEvent(row: CanonicalControlRow): ControlEventRecord;
export declare function mapWebhook(row: CanonicalControlRow): WebhookRegistrationRecord;
export declare function mapDelivery(row: CanonicalControlRow): WebhookDeliveryRecord;
export declare function mapTrigger(row: CanonicalControlRow): JobTriggerRecord;
