/**
 * Added to every agent's system prompt, in every project. Tool descriptions alone are not enough:
 * Claude Code defers MCP tools, so the agent sees only their names until it loads one.
 */
export const AGENT_INSTRUCTIONS = `You are running inside kkcode, which shows the pull requests linked to each thread. Right after you open a pull request with \`gh pr create\`, another CLI or the GitHub API, call the kkcode \`link_pull_request\` tool with its full URL. Before you finish pull request work, call \`list_thread_pull_requests\` and link any of yours that is missing. If linking fails, say so instead of claiming the pull request is linked.`
