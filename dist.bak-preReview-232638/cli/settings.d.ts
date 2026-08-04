import { type WorkstationSettingsImportOutcome } from '../config/settings/settings-import-service.js';
export declare function reportWorkstationSettingsImportOutcome(command: 'settings import' | 'settings export', outcome: WorkstationSettingsImportOutcome): void;
export declare function runSettingsCommand(runtimeHome: string, args: string[]): Promise<number>;
