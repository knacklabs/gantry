export declare function isPidAlive(pid: number): boolean;
export declare function browserProcessProfileState(pid: number, profile: {
    userDataDir: string;
}): {
    owned: boolean;
    headless: boolean;
};
export declare function isPidOwnedByBrowserProfile(pid: number, profile: {
    userDataDir: string;
}): boolean;
export declare function isPidOwnedVisibleBrowserProfile(pid: number, profile: {
    userDataDir: string;
}): boolean;
