export declare function credentialRefsForRequestedMcp(serverName: string, transport: string, credentialNeeds: string[]): {
    name: string;
    target: "header";
    key: string;
}[] | {
    name: string;
    target: "env";
    key: string;
}[];
export declare function headerNameForCredentialNeed(credentialNeed: string): string;
