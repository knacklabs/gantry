import { createSkillsMiddleware } from 'deepagents';
export function createInlineSkillsMiddleware(options) {
    const middleware = createSkillsMiddleware(options);
    const beforeAgent = middleware.beforeAgent;
    if (typeof beforeAgent !== 'function')
        return middleware;
    return {
        ...middleware,
        beforeAgent: (state, runtime) => beforeAgent({ ...state, skillsMetadata: [] }, runtime),
    };
}
