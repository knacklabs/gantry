import { z } from 'zod';
export declare const schedulerAccessRequirementSchema: z.ZodObject<{
    target: z.ZodUnion<readonly [z.ZodObject<{
        kind: z.ZodLiteral<"tool_rule">;
        rule: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"capability">;
        capability_id: z.ZodString;
        implementation: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                configured_access: "configured_access";
                local_cli: "local_cli";
                mcp_server: "mcp_server";
                builtin_tool: "builtin_tool";
            }>;
            name: z.ZodOptional<z.ZodString>;
            executable_path: z.ZodOptional<z.ZodString>;
            executable_version: z.ZodOptional<z.ZodString>;
            executable_hash: z.ZodOptional<z.ZodString>;
            command_template: z.ZodOptional<z.ZodString>;
            auth_preflight: z.ZodOptional<z.ZodString>;
            protected_paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
            network_hosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"mcp_server">;
        server: z.ZodString;
    }, z.core.$strict>]>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SchedulerAccessRequirementInput = z.infer<typeof schedulerAccessRequirementSchema>;
