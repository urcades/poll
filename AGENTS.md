# Agent instructions

## Every human capability is also an MCP capability

Agents use this app through the MCP server at `/mcp` (`src/lib/server/mcp/`). It must offer everything a person can do in the web pages, under the same rules. **Any change that adds, removes or changes something people can do must make the matching MCP change in the same commit.** A human-side feature without its MCP counterpart is unfinished.

This covers page actions, JSON API routes, downloads, poll types, ballot shapes, poll settings, lifecycle states, access rules (admin, operator, invites, vote tokens, result visibility, anonymity), and anything people can read on the poll, results or home pages. Purely presentational changes (layout, styling, copy, client-side widgets that submit the same data) are exempt.

The essentials:

- Put the logic in shared server code (`src/lib/server/app.ts`, `src/db.ts`, `src/tally.ts`), called by both the web route and the MCP tool. Never write a check only on one side.
- Agents may never do or see more than a person holding the same link or token.
- Map every new page load, form action and HTTP handler in `src/lib/server/mcp/parity.ts`. `tests/mcp-parity.test.ts` fails until you do, and it also checks that every poll type and default setting works over MCP.
- Test both sides (`tests/integration.test.ts`, `tests/mcp.test.ts`). Update the README's MCP tool table.

**Step-by-step guide:** `.claude/skills/mcp-parity/SKILL.md` covers where each kind of change goes, conventions for new tools, and what to test. Read it before changing anything listed above, or when the parity test fails.

Before finishing, run `bun run check` and `bun test`.
