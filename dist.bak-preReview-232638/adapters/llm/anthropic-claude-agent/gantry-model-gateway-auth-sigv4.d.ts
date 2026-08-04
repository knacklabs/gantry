export interface AwsSigV4Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}
export interface AwsSigV4SignInput {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: Buffer;
    region: string;
    service: string;
    credentials: AwsSigV4Credentials;
    now?: Date;
}
export declare function signAwsSigV4Request(input: AwsSigV4SignInput): void;
