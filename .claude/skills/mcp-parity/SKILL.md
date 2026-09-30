---
name: mcp-parity
description: Give agents the same capability over MCP when changing what people can do in this poll app. Use whenever you add or change a page action, JSON API route, download, poll type, ballot shape, poll setting, lifecycle state, access rule, or anything people can see in results, or when tests/mcp-parity.test.ts fails.
---

# Keeping MCP in step with the web app

People use this app through SvelteKit pages and a JSON API. Agents use the MCP server at `/mcp`. Both must offer the same capabilities under the same rules. `tests/mcp-parity.test.ts` enforces part of this automatically. The rest is on you.

## Map of the MCP side

- `src/lib/server/mcp/tools.ts`: the tools. Holds `ToolDefinition`s plus shared helpers:
  - `resolvePoll` / `applyCredentials` for poll references and tokens
  - `ballotFields` (friendly ballot → the form fields the web ballot posts), `describeBallot` (stored ballot → friendly form) and `ballotGuide` (the `howToVote` text and example)
  - `pollView` (the `get_poll` payload), `resultsFor` (results visibility) and `adminActions`
  - `SETTINGS_SCHEMA` for poll settings
- `src/lib/server/mcp/server.ts`: JSON-RPC over HTTP, sessions (each session is an in-memory cookie jar that stands in for a browser), per-tool rate limiting, and the `INSTRUCTIONS` sent to agents on connect.
- `src/lib/server/mcp/parity.ts`: `HUMAN_CAPABILITIES`, mapping every route load, form action and HTTP handler to its tool(s) or to a reason it is excluded.
- `src/routes/mcp/+server.ts`: the HTTP route.

## Workflow

### 1. Write the logic once, in shared server code

Put the rule or action in `src/lib/server/app.ts` (or `src/db.ts` / `src/tally.ts`) as a function that takes `Cookies`. The page action, the `/api` route and the MCP tool all call it. MCP tools pass `ctx.jar`, which implements `Cookies`, so admin checks (`isPollAdmin`, `requirePollAdmin`), invites (`currentInvite`) and vote tokens behave exactly as in a browser.

Never put a permission check, validation rule or state transition only in a route or only in a tool.

### 2. Expose it to agents

Pick the smallest change that fits:

| Human-side change | MCP change |
| --- | --- |
| New poll setting in `PollConfig` / `parseConfig` | Add it to `SETTINGS_SCHEMA` with a description and its default. `settingsView` shows it once it is in the type's defaults. |
| New poll type | Add a case to `ballotFields`, `describeBallot` and `ballotGuide`. The template in `src/templates.ts` feeds `list_poll_types` automatically. |
| New ballot shape or voting rule | Update `ballotFields` (build the same form fields the web form posts) and `ballotGuide` (the example must stay a valid vote). |
| New field on the poll page or results | Add it to `pollView` or `resultsFor`, honouring the same visibility rules as the page loader. |
| New lifecycle state or transition | Update `lifecycle`, `cannotVoteReason`, `adminActions`, and add a tool if people trigger the transition. |
| New page action or API route | Add a tool (below) or extend an existing one, then map it in `parity.ts`. |
| New download or read-only endpoint | Return the data from an existing read tool, or add a read-only tool. Map it in `parity.ts`. |

**New tools:**

- Name: verb-first snake_case (`reopen_poll`).
- Description: what it does, who may use it, what it returns, and any caveat (irreversible, admin only).
- Input: `poll: POLL_ARG`, plus `adminToken: ADMIN_TOKEN_ARG` / `inviteToken` / `voteToken` as relevant, and `additionalProperties: false`.
- `annotations`: set `readOnlyHint` accurately. Add `destructiveHint: true` for anything irreversible, and `idempotentHint` where it holds.
- `bucket`: `"create"` for anything that creates a poll, `"mutate"` for other changes, omitted for reads. This matches how the web route is rate limited.
- Body: `const poll = pollFor(args, ctx)`, then `requireAdmin(poll, ctx)` for admin actions. Call the shared function inside `attempt(...)` so its errors become tool errors. Return `{ <verb>ed: true, ...pollView(poll, ctx) }`, so the agent sees the new state.
- Throw `ToolError` with a sentence the agent can act on ("Unschedule it first to edit it."), never a bare code.

### 3. Keep the rules identical

An agent with a given link or token must be able to do exactly what a person with that link or token can do, and see exactly what they see. Check against the page loader in particular:

- hidden results
- anonymous names and reasons
- other voters' ballots
- admin and invite tokens (only the holder's own)
- scheduled polls hiding their options from visitors

### 4. Map it in `parity.ts`

Add each new `load`, form action and HTTP method to `HUMAN_CAPABILITIES` as `"<path under src/routes>#<load|action|METHOD>"`. Use `{ excluded: "<reason>" }` only when agents genuinely do not need it (for example the MCP route itself). A purely presentational route is not an exclusion if it exposes data.

### 5. Test both sides

- Web: `tests/integration.test.ts`.
- Agent: `tests/mcp.test.ts`. Drive tools through `connect()` / `call()` / `fail()`, including the refusals (not admin, wrong state, bad input, hidden data).
- `tests/mcp-parity.test.ts` also creates, votes in and closes every poll type using the `howToVote` example, and checks every default config key is settable.

Run `bun run check` and `bun test`.

### 6. Update the docs

- The tool table in the README's "Agent Interface (MCP)" section.
- `INSTRUCTIONS` in `server.ts` if the lifecycle or access model changed.

## What does not need an MCP change

Layout, styling, copy, and client-side interactions that submit the same data as before (for example a new drag-to-rank widget). If unsure, ask: "Can a person now do, see or decide something they could not before?" If yes, agents need it too.
