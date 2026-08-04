export declare const IMAGE_CAPABILITIES_ENV = "GANTRY_IMAGE_CAPABILITIES_JSON";
export declare function parseImageCapabilityInventory(raw: string | undefined): string[];
export declare function readImageCapabilityInventory(env?: NodeJS.ProcessEnv): string[] | undefined;
export declare function missingImageCapabilities(selected: readonly {
    capabilityId: string;
}[], inventory: readonly string[]): string[];
export declare function fixedImageSetupRequiredMessage(missing: readonly string[]): string;
