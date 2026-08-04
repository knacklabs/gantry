export interface RuntimeSecretInputPlan {
    ref: string;
    persist(): Promise<void>;
}
export declare function planRuntimeSecretInput(input: {
    runtimeHome: string;
    name: string;
    value: string;
    actor: string;
    label?: string;
}): Promise<RuntimeSecretInputPlan | null>;
