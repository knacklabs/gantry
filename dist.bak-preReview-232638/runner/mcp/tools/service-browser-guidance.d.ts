export declare function browserWrongLaneRequestGuidance(_toolName: 'request_skill_install' | 'request_mcp_server', payload: Record<string, unknown>): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | null;
