# Chat apps over MCP

A person can contribute from a chat app (ChatGPT, Claude) without a command-line agent. The chat app connects to Solve at Home over MCP, the person signs in with GitHub on solveathome.org, and the chat takes an assignment, works on it in the conversation and sends the result under the person's handle. In beta: everything here is off unless the server runs with `MCP_WORK_BETA=1`, and `MCP_WORK_HANDLES` (comma-separated) limits who may connect while it is set.

The public plugin at `POST /mcp` is unchanged: three read-only tools, no sign-in.

## The endpoint

`POST /mcp/beta`: the public plugin's three tools, plus six that need the person's account (OAuth scope `contribute`):

| Tool | What it does |
|---|---|
| `start_contributing` | Takes one assignment for the person and returns the chat brief and a `session_id`. A chat that already holds one gets it back. |
| `get_assignment` | Re-reads the brief. Keeps the assignment alive. |
| `read_project_file` | Reads a project document in pages of 20,000 characters (`path`, `offset`); an empty path lists the top folder. |
| `submit_return` | Sends the result: `report_md`, `author_rung`, and `recipe_md` (formalize, break), `decision` (curate) or `patch` when the task asks. Optional `share_url`: a chatgpt.com/share or claude.ai/share link the person wants published with it. |
| `release_assignment` | Hands the assignment back. Nothing is published. |
| `my_standing` | The person's points and latest results with their review state. |

The tools call the site's own API on the loopback address (`GET /start`, `POST /result`, `POST /release`), so a chat session meets the same scheduling, intake, triage, review and credit as a command-line agent. An access token works on the API only with the in-process secret the MCP endpoint sends (`X-MCP-Internal`); presented directly it is refused.

It speaks the `initialize` revisions (2025-11-25 back to 2024-11-05) and the stateless 2026-07-28 revision (`server/discover`, the version in every request's `_meta`, `Mcp-Method` and `Mcp-Name` checked against the body, `resultType` and cache hints on results).

## Signing in

solveathome.org is the authorization server (`src/lib/oauth.ts`):

- `GET /.well-known/oauth-protected-resource/mcp/beta` (RFC 9728) names the resource and this server; `GET /.well-known/oauth-authorization-server` (RFC 8414) the endpoints.
- A tool that needs sign-in, called without a token, answers HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="contribute"` (Claude signs in on that). ChatGPT, recognised by its user agent or its `openai/` request metadata, gets a tool result with `isError` and `_meta["mcp/www_authenticate"]` instead. An invalid or expired token is always a 401 with `error="invalid_token"`.
- Clients: a Client ID Metadata Document (an https `client_id` whose JSON names itself, `token_endpoint_auth_method: none`) is preferred and cached for a day. It is fetched over https only, never from a private address, at most 64 KB. Dynamic registration (`POST /oauth/register`) is the fallback, 20 an hour per address.
- `GET /oauth/authorize`: authorization code with PKCE S256 only; `resource` must be the endpoint. A person who is not signed in goes through the site's GitHub sign-in, which creates the account, and comes straight back. The page then asks one thing per app: "I accept the Terms" (a link to `/terms`), Allow or Cancel. Accepting records the current terms version (`users.terms_version`, `terms_acceptances` with `via = 'oauth'`) and the connection (`oauth_grants`). A person who already allowed the same app on the current terms is not asked again. The redirect carries `code`, `state` and `iss` (RFC 9207).
- `POST /oauth/token`: a code works once (a second use closes the connection); access tokens last an hour; refresh tokens rotate, work once (a replay closes the connection) and last 90 days from their last use. Tokens are opaque and stored as SHA-256 hashes.
- `/settings/connections` lists the person's connected apps; Disconnect ends one at once. That is the only way a connection ends, apart from a replayed token.

The person's agent token (`tokens`) is never read, shown or changed by any of this.

## What a chat session is

- One connection's latest live session is the chat's session; `session_id` names one explicitly. It registers like any agent (`registered_via = 'mcp'`, `oauth_grant_id`), with no compute share and no sub-agents.
- **Model unmeasured.** A chat app does not say which model ran, and the person can switch models mid-chat. The session carries the app's label instead of a model id: `chatgpt-unmeasured`, `claude-chat-unmeasured` or `mcp-unmeasured`, tier 3 in `model_tiers`. It is never asked for a model or a thinking level.
- **Chat work only.** The scheduler gives a chat session explore, source, formalize, break and curate jobs, and none that needs compute (`CHAT_TYPES`, `chatOnly` in `src/lib/scheduler.ts`). The brief is the chat brief (`renderChatBrief`, `CHAT_BRIEF_VERSION`): the task, the tools, the calibration rules, nothing about headers or session logs.
- **Transcript.** The server records every signed-in tool call and its answer (`mcp_calls`). At submission that record is the transcript, one JSON object per line, with a first line `{"kind":"mcp-observed", …}` that carries the share link when the person gave one. It is not the model's reasoning.
- **Usage.** Unmeasured and never estimated: `tokens.source = "none"`, `tokens.log = "mcp-observed"`, no token credit. Points come only from acceptance; tier 3 earns no frontier premium.
- **Review.** A chat return always goes to review, even an explore (which is otherwise recorded unreviewed). Where the project triages, a triage reads it first, and a trusted reviewer decides whatever the triage says. Chat sessions never review or triage (tier 3, never trusted). The review and triage briefs say what the transcript is (`REVIEW_BRIEF_VERSION` 12).
- **Limits.** Per person: 4 chat sessions at once (`MCP_CHAT_SESSIONS`), 10 chat returns an hour (`MCP_CHAT_RETURNS_PER_HOUR`), under the handle's usual limits. Per connection: 60 signed-in calls a minute; per chat app across all its people: 3,000 a minute (`MCP_CALLS_PER_GRANT_PER_MIN`, `MCP_CALLS_PER_CLIENT_PER_MIN`). Per address: 600 MCP requests a minute, 30 authorize, 60 token and 20 registrations an hour.

## Terms

Version `2026-10-04` adds a perpetual, irrevocable, sublicensable licence to submitted content and the chat apps. The previous version (`2026-09-12.1`) still covers existing command-line agents, so the running swarm does not pause: a person on it sees "Our Terms changed" on the site and accepts when they next sign in. Every chat connection, and every new sign-up, accepts the current version.

## Before public launch

These gates stay closed while the beta is private (lesson of Oct 3 2026: risks that are not critical in a private beta are written down as gates, not fixed first). Each must be met before chat contributions open to the public:

1. Retire the old-terms grace: every contributor whose returns we publish is on the current terms version (remove `PREVIOUS_TERMS_VERSION` from the gate in `src/lib/auth.ts`).
2. Move the six tools from `/mcp/beta` onto `/mcp` and resubmit the ChatGPT plugin for review with the write tools, so the public listing and the working endpoint are the same.
3. A security review of the authorization server by someone who did not write it (consent, PKCE, refresh rotation, CIMD fetching, the in-process secret).
4. New-account gate: a minimum GitHub account age, or the first returns of a new handle only from accounts older than that, against throwaway accounts.
5. Own-kind rule for chat returns: a model never reviews its own kind, and a chat return's model is unknown. Decide whether OpenAI-family reviewers stay off ChatGPT returns and Anthropic-family reviewers off Claude ones.
6. Watch the triage and review queues for chat returns. If they swamp trusted reviewers, lower `MCP_CHAT_RETURNS_PER_HOUR` or require a share link.
7. Rate limits shared across instances: the limits are in memory per process, so with blue/green or more than one instance they are per instance.
8. Prompt injection: briefs and project documents carry other contributors' text into the person's chat. Mark it as quoted data in tool results, and re-check against both directories' rules.
9. Clean up unused dynamically registered clients and old `mcp_calls` rows that belong to no return.
10. Write tools on ChatGPT plans: confirm which plans can use the write tools in practice, and say so on the site.
