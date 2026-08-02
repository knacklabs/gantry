interface ScheduleValidationInput {
    schedule_type: string;
    schedule_value: string;
    next_run?: string | null;
}
export declare function validateScheduleConfig(job: ScheduleValidationInput): string | null;
export {};
