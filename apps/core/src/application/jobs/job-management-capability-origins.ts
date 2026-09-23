import type { Job } from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import type { JobUpdatePatch } from './job-management-types.js';

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST'] as const;

export function extendCapabilityAllowedOrigins(input: {
  job: Job;
  agentTask: NonNullable<Job['agent_task']>;
  approvals: NonNullable<JobUpdatePatch['addCapabilityAllowedOrigins']>;
  now: string;
}): NonNullable<Job['agent_task']> | undefined {
  const context = input.agentTask.trustedCapabilityContext;
  if (
    !context ||
    !Array.isArray(context.allowedOrigins) ||
    context.allowedOrigins.some((origin) => typeof origin !== 'string')
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'The retained task requires a trusted allowedOrigins context.',
    );
  }
  const additions = input.approvals.map((approval) => {
    const origin = typeof approval === 'string' ? approval : approval.origin;
    const methods =
      typeof approval === 'string' ? ['GET', 'HEAD'] : approval.methods;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Invalid exact capability origin.',
      );
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== origin
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Invalid exact capability origin.',
      );
    }
    if (typeof approval !== 'string' && url.protocol !== 'https:') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Explicit capability method approvals require an exact HTTPS origin.',
      );
    }
    if (
      methods.length === 0 ||
      methods.some(
        (method) =>
          !ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number]),
      )
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Invalid trusted origin method policy.',
      );
    }
    return {
      origin,
      methods: [...new Set(methods)],
      explicitMethods: typeof approval !== 'string',
    };
  });
  const priorOrigins = context.allowedOrigins as string[];
  const newOrigins = additions
    .map(({ origin }) => origin)
    .filter((origin) => !priorOrigins.includes(origin));
  const restrictions = context.allowedMethodsByOrigin;
  if (
    restrictions !== undefined &&
    (!restrictions ||
      typeof restrictions !== 'object' ||
      Array.isArray(restrictions))
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Invalid trusted origin method policy.',
    );
  }
  const priorMethods = (restrictions ?? {}) as Record<string, unknown>;
  const allowedMethodsByOrigin = Object.fromEntries(
    Object.entries(priorMethods).map(([origin, methods]) => {
      if (
        !priorOrigins.includes(origin) ||
        !Array.isArray(methods) ||
        methods.length === 0 ||
        methods.some(
          (method) =>
            typeof method !== 'string' ||
            !ALLOWED_METHODS.includes(
              method as (typeof ALLOWED_METHODS)[number],
            ),
        )
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          'Invalid trusted origin method policy.',
        );
      }
      return [origin, [...new Set(methods)]];
    }),
  );
  for (const { origin, methods, explicitMethods } of additions) {
    if (priorOrigins.includes(origin) && !explicitMethods) continue;
    allowedMethodsByOrigin[origin] = [
      ...new Set([...(allowedMethodsByOrigin[origin] ?? []), ...methods]),
    ];
  }
  const methodsChanged = additions.some(({ origin, explicitMethods }) => {
    if (priorOrigins.includes(origin) && !explicitMethods) return false;
    const before = Array.isArray(priorMethods[origin])
      ? (priorMethods[origin] as unknown[])
      : [];
    return (allowedMethodsByOrigin[origin] ?? []).some(
      (method) => !before.includes(method),
    );
  });
  if (
    (newOrigins.length > 0 || methodsChanged) &&
    (input.job.status !== 'paused' ||
      (input.job.lease_run_id &&
        (!input.job.lease_expires_at ||
          !Number.isFinite(Date.parse(input.job.lease_expires_at)) ||
          Date.parse(input.job.lease_expires_at) > Date.parse(input.now))))
  ) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Trusted capability origins may be extended only on a paused job without a live run.',
    );
  }
  const allowedOrigins = [
    ...new Set([...priorOrigins, ...additions.map(({ origin }) => origin)]),
  ];
  if (allowedOrigins.length > 50) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'At most 50 capability origins may be admitted.',
    );
  }
  const hostedValidationPolicy = context.hostedValidationPolicy;
  let updatedHostedValidationPolicy: Record<string, unknown> | undefined;
  let hostedPolicyChanged = false;
  if (hostedValidationPolicy !== undefined) {
    if (
      !hostedValidationPolicy ||
      typeof hostedValidationPolicy !== 'object' ||
      Array.isArray(hostedValidationPolicy)
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Invalid retained hosted validation policy.',
      );
    }
    const hostedOrigins = (hostedValidationPolicy as Record<string, unknown>)
      .allowedOrigins;
    if (
      !Array.isArray(hostedOrigins) ||
      hostedOrigins.some((origin) => typeof origin !== 'string')
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Invalid retained hosted validation origins.',
      );
    }
    const missingHostedOrigins = priorOrigins.filter(
      (origin) => !hostedOrigins.includes(origin),
    );
    if (
      hostedOrigins.some((origin) => !priorOrigins.includes(origin)) ||
      missingHostedOrigins.some(
        (origin) => !additions.some((addition) => addition.origin === origin),
      )
    ) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Retained hosted validation origins do not match trusted capability origins.',
      );
    }
    hostedPolicyChanged =
      hostedOrigins.length !== allowedOrigins.length ||
      hostedOrigins.some((origin, index) => origin !== allowedOrigins[index]);
    updatedHostedValidationPolicy = {
      ...(hostedValidationPolicy as Record<string, unknown>),
      allowedOrigins,
    };
  }
  if (!newOrigins.length && !methodsChanged && !hostedPolicyChanged) {
    return undefined;
  }
  return {
    ...input.agentTask,
    trustedCapabilityContext: {
      ...context,
      allowedOrigins,
      ...(updatedHostedValidationPolicy
        ? { hostedValidationPolicy: updatedHostedValidationPolicy }
        : {}),
      allowedMethodsByOrigin,
    },
  };
}
