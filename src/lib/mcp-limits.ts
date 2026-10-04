/**
 * Limits and labels for chat sessions over MCP (#sah-mcp-real-work-build), shared by the MCP tools (mcp-work.ts) and the API (routes/job.ts).
 * A chat app is one person in one conversation: these are wide enough for that and a wall for a loop. All can be set in the environment.
 */
export const CHAT_MODELS = ["chatgpt-unmeasured", "claude-chat-unmeasured", "mcp-unmeasured"];
export const isChatModel = (m: unknown): boolean => CHAT_MODELS.includes(String(m ?? "").toLowerCase());
/** Chat sessions working at once per person. */
export const chatSessionLimit = (): number => Number(process.env.MCP_CHAT_SESSIONS ?? 4);
/** Chat returns per person per hour (a CLI agent's limit is 120). */
export const CHAT_RETURNS_PER_HOUR = Number(process.env.MCP_CHAT_RETURNS_PER_HOUR ?? 10);
/** Signed-in tool calls per connection (grant) per minute, and per chat app (client) across all its people per minute. */
export const CALLS_PER_GRANT_PER_MIN = Number(process.env.MCP_CALLS_PER_GRANT_PER_MIN ?? 60);
export const CALLS_PER_CLIENT_PER_MIN = Number(process.env.MCP_CALLS_PER_CLIENT_PER_MIN ?? 3000);
