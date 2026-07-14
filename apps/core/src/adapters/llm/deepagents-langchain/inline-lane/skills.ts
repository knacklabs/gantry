import { createSkillsMiddleware } from 'deepagents';
import type { SkillsMiddlewareOptions } from 'deepagents';

export function createInlineSkillsMiddleware(
  options: SkillsMiddlewareOptions,
): ReturnType<typeof createSkillsMiddleware> {
  const middleware = createSkillsMiddleware(options);
  const beforeAgent = middleware.beforeAgent;
  if (typeof beforeAgent !== 'function') return middleware;
  return {
    ...middleware,
    beforeAgent: (state, runtime) =>
      beforeAgent({ ...state, skillsMetadata: [] }, runtime),
  };
}
