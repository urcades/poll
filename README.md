# Poll

A small SvelteKit + Bun voting app for running informal votes with people who have a shared link.

This project started as a local exploration of Loomio-style poll creation and later borrowed a few useful OpaVote ideas. It is intentionally not an account-based election platform. Anyone with the app URL can create drafts, preview ballots, open voting, submit or replace a vote by display name, close polls, and export closed results. Polls are not listed publicly: each one is shared by its link.

## What It Includes

- Draft, scheduled, open, and closed poll lifecycle.
- Draft preview and draft-only editing before voting opens.
- SQLite persistence through `work/votes.sqlite`.
- Unguessable poll links: every poll has a random 10-character base62 slug (e.g. `/poll/4WZegrFSou`) used in all URLs, API paths, API responses, and export filenames. The internal integer id is never public, and numeric URLs like `/poll/3` return 404.
- One active vote per display name per poll; the same browser can update its vote, and a per-vote edit token (held in a cookie) prevents other visitors from silently replacing it by reusing the name.
- Result visibility controls, anonymous result/export mode, quorum fields, and optional/required/disabled vote reasons.
- A per-poll admin capability: creating a poll mints an admin token (cookie plus a shareable admin link) that is required to edit drafts, open, close, or delete the poll, and export results. Opening the admin link swaps the token for a cookie and redirects to the plain poll URL. Only a SHA-256 hash of the token is stored, so the admin link shown on the poll page is rebuilt from the admin's own cookie; an admin who loses their cookie and link cannot recover it.
- Optional invite-only mode (`voterMode: "invite"`; open-link voting stays the default). The admin lists invitee names, one per line (trimmed, de-duplicated ignoring case, max 80 characters each, up to 500). Each invitee gets a personal link, `/poll/<slug>?invite=<token>`, which is swapped for an httpOnly cookie and redirected to the clean URL. The ballot then shows "Voting as <name>" with no name field; the server ignores any submitted name, rejects votes without a valid invite ("This poll is invite-only. Use the personal link you were sent.") on both the form and `POST /api/polls/<slug>/votes`, and lets the same invite re-vote to update its ballot. The invitee list is set while the poll is a draft; once open, the admin can add invitees (form on the poll page or `POST /api/polls/<slug>/invitees` with `inviteesText`) but never remove or rename anyone. In invite mode quorum uses the number of invitees as the eligible count and the manual eligible voter count is ignored. The admin sees an "Invitations" section with each invitee's personal link (copy button), whether they have voted (not what), and "N of M invitees have voted".
- A "My votes" home page listing only the polls this browser created, voted in, or was invited to (grouped as drafts, active, closed), based on its capability cookies. A brand-new visitor sees an empty state; they reach a poll through the link they were given.
- An optional instance operator secret (`OPERATOR_TOKEN` env var). Visiting any poll with `?admin=<OPERATOR_TOKEN>` makes that browser admin of every poll and lets its home page list every poll. This is the only way to manage legacy polls created before admin tokens existed and a way to remove spam. Operators who are not a poll's own admin do not get a shareable admin link.
- Scheduled opening: give a draft an "Opens at" time and click "Schedule" (or `POST /api/polls/<slug>/schedule`). The poll moves to a `scheduled` status, its setup is frozen, and it opens by itself when the time arrives (`opened_at` is set to the scheduled time; the sweep runs on every request, so nothing needs a background job). "Unschedule" (`POST /api/polls/<slug>/unschedule`) turns it back into an editable draft. Scheduling needs an opening time in the future, before the closing time if one is set (saving a draft with opens-at at or after closes-at is rejected too). Admins see scheduled polls on their home page under Drafts as "Scheduled for ..."; nobody else sees them listed. Visitors to a scheduled poll's link see "Voting opens ..." (in their local time) and no ballot, and the page refreshes itself when it opens.
- Duplicate: the admin of any poll (draft, scheduled, open, or closed) can click "Duplicate" (or `POST /api/polls/<slug>/duplicate`, which returns `{id, adminToken}`). This creates a new draft titled "Copy of ..." with the same type, details, config, options and invitee names, and a new admin token (set as a cookie in that browser), so invitees get fresh personal links. Votes and opening/closing times are not copied. The form action redirects to the new draft's edit page. Duplicating counts against the creation rate limit.
- JSON and CSV exports for closed polls (admin only).
- Real time polls: in a time poll each timeslot is a date and time picked with a `datetime-local` input in the editor (plus an optional note). The browser converts to UTC and stores the option label as an ISO 8601 instant (e.g. `2026-10-05T14:00:00.000Z`). The server validates that every time-poll label is a date (full ISO with a zone, or `YYYY-MM-DD HH:MM` read as UTC, which is also what the no-JS fallback gets), normalizes it, and rejects duplicates. New time polls start with three upcoming weekday slots (10:00 and 14:00 tomorrow-ish, then 10:00 the next weekday) generated when the editor opens, in the browser's time zone. Slots are shown everywhere (ballot, results table, charts, "Best timeslot") in the viewer's own zone with the meeting duration, like "Mon 5 Oct, 14:00-15:00 (GMT+2)"; the server renders UTC and the browser swaps in local text right after load, so there is no hydration mismatch. Legacy polls with free-text labels keep working and display as typed; only labels that parse as ISO dates are formatted.
- Calendar file: once a time poll is closed, `/poll/<slug>/event.ics` serves an iCalendar event for the winning slot (UTC start and end from the meeting duration, poll title as the summary, details as the description). Anyone who can see the results can download it; it is 404 for non-time polls, polls whose slots are not dates, or when nobody is available for any slot, and 400 while the poll is not closed.
- Results page: `/poll/<slug>/results` is a read-only page with just the title, outcome, quorum, charts and tables (including the round chart), reusing the same component as the poll page and honouring anonymous mode and hidden-results settings (hidden results never reach the payload; the page says so instead). Closed polls link to it with "Share results". Drafts and scheduled polls have no results page.
- Link previews: poll pages, the results page and the home page carry Open Graph and Twitter card tags (title, a shortened description or "<type> - <status>", the clean `/poll/<slug>` URL from the request origin, and a generic `static/og.png` 1200x630 image). Tags are built from public poll fields only, never admin or invite tokens or voter data. Poll pages also send `<meta name="robots" content="noindex">` since polls are private by link. Behind a proxy, make sure `ORIGIN` (or the forwarded host headers your adapter trusts) reflect the public URL so absolute links are right.
- A SvelteKit frontend styled with `@flowercomputer/flowerparts`.

## Describe A Vote In Words

The home page has a text field: type what you want decided ("Which two films Friday: Past Lives, Perfect Days or Poor Things?", "Elect 2 organizers from Ada, Ben, Chen, Diana and Eli, anonymous") and the new-poll editor opens already filled in. Nothing is created until you save; the editor shows what was filled in and which other voting methods were close.

How it works: code finds the candidate options (bullet lines, a list after a colon or "between/from", or a list in the closing sentence), the numbers, and the title. One request to [TypeSafe](https://typesafe.ai)'s Jev model then makes only the judgment calls, as closed questions it answers with choices and probabilities rather than free text: which of the 12 voting methods fits, which settings the wording asks for (anonymous, voters may change their vote, a reason is required), what each number means (seats, pick limit, point budget, top score, ranked choices, meeting minutes or hours, option count), and which candidate items are real options. An answer must be at least 70% sure to change the form, and every filled value is checked against what the editor allows (for example seats must be fewer than the candidates). Time-poll slots are not read from the text; the editor offers upcoming ones. Responses take well under a second.

Set `TYPESAFE_API_KEY` on the server (`.env` locally, see `.env.example`; `fly secrets set TYPESAFE_API_KEY=...` on Fly). Without it the field is shown disabled with a note. The key stays on the server, the description is sent only to `api.typesafe.ai`, and it travels to the editor in browser navigation state, never in a URL. Each description counts against the creation rate limit. Agents do not need this: over MCP they choose the method and fill the settings themselves (`list_poll_types`, `create_poll`).

## Usage Log

Everything notable is recorded as an event in an `events` table in the app's own database (so prompts, polls and votes can be joined), and as one JSON line on stdout (`usageEvent: true`), which Cloudflare's log stream, Workers observability and `fly logs` pick up.

| Kind | What it holds |
| --- | --- |
| `describe`, `describe_failed` | The prompt, the whole pre-filled suggestion, Jev's raw answers and probabilities, model, token usage, latency, and a `suggestionId` |
| `poll_created`, `poll_updated` | Everything set up in the poll: type, title, details, settings, options, times, invitee count. `poll_created` carries the `suggestionId` and `fromDescription`: which fields the person changed from what Jev filled in |
| `poll_opened`, `poll_scheduled`, `poll_unscheduled`, `poll_closed`, `poll_duplicated`, `poll_deleted`, `invitees_added`, `export` | Lifecycle, with vote counts where relevant |
| `vote_cast`, `vote_rejected` | The ballot, reason, voter name (not on anonymous polls), the option labels, and whether it replaced an earlier vote; for rejections, only why |
| `mcp_initialize`, `mcp_tool` | Which agent client connected; each tool call with duration, success and the argument names (never values) |
| `client_page_view`, `client_click`, `client_field_change`, `client_form_submit`, `client_page_leave`, `client_error` | From the browser tracker: pages, what was clicked (tag, label, link path), which field changed (label only, never what was typed), time on page, scroll depth, viewport, script errors |
| `rate_limited`, `server_error`, `not_found` | Operational events |

Every event also has a timestamp, a source (`web`, `api`, `mcp`, `browser`), the poll id and a session id. Browser sessions use a random id in a `poll_sid` cookie that the tracker sets; MCP sessions use their MCP session id. The ids are not logins and are not linked to any person.

**What is never recorded:** admin, vote, invite or operator tokens (events hold poll ids, not links), IP addresses, text typed into fields, and query strings. On **anonymous polls** nothing ties a ballot to a person: `vote_cast` has the ballot but no voter name or session, and the server ignores browser events from their pages (the tracker also switches itself off there and drops its session cookie). Browsers sending Do Not Track or Global Privacy Control are not tracked in the browser; server-side events still happen, since they are the app working. Every page carries a short notice that usage is logged.

**Reading it:** sign in with `/events?admin=<OPERATOR_TOKEN>` (anyone else gets a 404). The page filters by kind, kind prefix, poll, session, source, text and dates, shows counts per day and kind, expands each event's data, and downloads the same filter as JSON or CSV (`/events/export.json`, `/events/export.csv`). Agents connected as the operator use `get_usage_events`. To follow one prompt through: filter `kind=describe`, copy its `suggestionId`, then search that text.

**Jev corrections:** `/events/corrections` joins every description to what became of it, using the log alone. For each one it shows Jev's reading (voting method with its probabilities, title, options, settings) next to the poll the person finally saved, including edits made to the draft afterwards, and lists the corrections field by field: `type`, `title`, `options` (what was added, removed or reordered), `optionCount` (when Jev only knew how many), and each `config.*` setting. A setting is flagged "Jev missed it" when Jev left it at the default and the person changed it; otherwise Jev set it wrongly. Each description gets an outcome: `accepted` (saved unchanged), `corrected`, `rephrased` (described again within 30 minutes without saving; the retry is shown), `abandoned` (nothing saved after an hour) or `pending`. The summary gives the share accepted, the correction rate by field, which voting methods Jev gets confused (Jev said X, they chose Y, and whether Y was a close second Jev had listed), and calibration: how often the method survives, by Jev's stated confidence. `/events/corrections/export.jsonl` (or `get_jev_corrections` with `format: "jsonl"`) downloads one line per description: the prompt, Jev's prediction and raw probabilities, and the corrected labels (`?saved=1` keeps only labelled rows), shaped for evaluating Jev or training a classifier. Rewrites that never become polls are in the log too, so unlabelled prompts remain available.

**Settings:** `EVENT_LOG=off` disables recording; `EVENT_RETENTION_DAYS` (default 365) drops older events; `EVENT_STDOUT=off` keeps rows but skips the stdout line.

## Agent Interface (MCP)

Everything a person can do in the web pages, an agent can do over the [Model Context Protocol](https://modelcontextprotocol.io) at `/mcp` (Streamable HTTP, JSON responses, no SSE stream). Point any MCP client at the app's URL, for example with Claude Code:

```bash
claude mcp add --transport http poll https://your-poll-host/mcp
```

Tools:

| Tool | What it does | Who |
| --- | --- | --- |
| `list_poll_types` | Every decision method, when to use it, how results work, defaults | anyone |
| `create_poll` | New draft (or `open: true` to open or schedule it at once); returns the `adminToken`, links and invitee links | anyone |
| `get_poll` | The poll as a participant sees it: options with ids, a `howToVote` summary with an example ballot, your vote, whether you can vote, visible results, admin extras | anyone with the id or link |
| `cast_vote` | Vote or re-vote with one friendly field per method (`choice`, `selected`, `scores`, `allocations`, `ranking`, `availability`); options by label or id; returns a `voteToken` | voters / invitees |
| `get_results` | The tally, following the poll's visibility rules | anyone allowed to see it |
| `list_my_polls` | Polls this session created, voted in or was invited to (everything for the operator) | session |
| `get_usage_events` | The usage log with filters and per-day counts (see Usage Log) | operator |
| `get_jev_corrections` | How Jev's readings were corrected: per-field corrections, outcomes, statistics, training export (see Usage Log) | operator |
| `update_draft` | Partial edit of a draft (only the fields passed change) | admin |
| `open_poll`, `schedule_poll`, `unschedule_poll`, `close_poll` | Lifecycle; `schedule_poll` can set `opensAt` in the same call | admin |
| `add_invitees` | Invite more people; returns their personal links | admin |
| `duplicate_poll`, `delete_poll` | Copy into a new draft; permanent delete | admin |
| `export_results` | The JSON export for a closed poll, with ballots named by option label | admin |

Access works the same as in a browser. Each MCP session gets an in-memory stand-in for a browser's capability cookies: the session that creates a poll is its admin, a session that votes can update its own ballot, and opening an admin or invite link (passed as `poll`) grants that access for the session. Tokens are also returned (`adminToken`, `voteToken`) and accepted as arguments (`adminToken`, `inviteToken`, `voteToken`), so an agent can act across sessions and after server restarts, which forget every session. Sessions expire after 24 hours idle. Requests without a session id work too, statelessly, with explicit tokens. The operator can connect with `Authorization: Bearer <OPERATOR_TOKEN>`. The endpoint never reads browser cookies.

Every tool runs the same server functions as the pages and JSON API (`src/lib/server/app.ts`): votes go through the same parsing and validation, and invite-only mode, final votes, hidden results, anonymous mode and admin checks all apply unchanged. Rate limits apply per tool call rather than per HTTP request: `create_poll` and `duplicate_poll` count against the creation limit, other changes against the general one, and reads are free. Problems an agent can fix (a missing reason, an unknown option, a closed poll) come back as tool errors with a plain explanation. The server's `instructions` explain the lifecycle and access model to the connecting agent and tell it to treat poll text and voter reasons as content rather than instructions.

## Poll Types

The app currently supports these vote and proposal shapes:

- Sense check
- Consent
- Consensus
- Majority
- Choose
- Approval
- Score
- Allocate
- Rank
- IRV / Ranked-choice
- STV Election
- Time poll

The tally logic includes simple proposal outcomes, approval counts, score averages, point allocation totals, Borda-style rank scoring, single-winner IRV rounds, Scottish/Meek STV variants, and time-poll availability summaries.

## Requirements

- Bun 1.2 or newer.
- A recent Node runtime available on the machine for the SvelteKit/Vite toolchain. The local development setup has been run with Node 25.

The project is Bun-first and commits `bun.lock`. `package-lock.json` is ignored to avoid competing lockfiles.

## Running Locally

Install dependencies:

```bash
bun install
```

Start the development server:

```bash
bun run dev
```

Open:

```text
http://127.0.0.1:3000/
```

The dev server is configured to listen on port `3000`.

## Serving On A Tailnet With Caddy

For a durable local deployment, build the SvelteKit app and run the Node adapter on a loopback-only port. Caddy can then terminate HTTPS on the Tailscale address and proxy requests to that local process.

Build the app:

```bash
bun run build
```

Run the production server on a private local port:

```bash
HOST=127.0.0.1 \
PORT=4179 \
DB_PATH=/Users/edouard/Developer/poll/work/votes.sqlite \
node build/index.js
```

Because Caddy connects from loopback, the app would otherwise see every visitor as `127.0.0.1`, and rate limiting would count everyone together. Tell adapter-node to trust the proxy's `X-Forwarded-For` header (Caddy's `reverse_proxy` sets it to the real client address) by adding:

```bash
ADDRESS_HEADER=X-Forwarded-For XFF_DEPTH=1
```

`XFF_DEPTH=1` means exactly one trusted proxy (Caddy) sits in front, so the last entry in the header is used. That entry is written by Caddy and cannot be spoofed by clients. Only set these when the app is reachable exclusively through the proxy (keep `HOST=127.0.0.1`).

Rate limiting is per client IP and in-memory. Defaults: 10 poll creations per 10 minutes and 60 other mutating requests per minute. Tune with `RATE_LIMIT_CREATE_MAX`, `RATE_LIMIT_CREATE_WINDOW_SECONDS`, `RATE_LIMIT_MUTATE_MAX`, `RATE_LIMIT_MUTATE_WINDOW_SECONDS`, or disable with `RATE_LIMIT=off`.

Use a LaunchAgent, systemd unit, or another process manager for long-running use. The important details are that `HOST` stays on `127.0.0.1`, `PORT` matches the Caddy upstream, and `DB_PATH` points at the SQLite database you want to keep.

Example Caddy site using a Tailscale certificate:

```caddyfile
{
	auto_https disable_redirects
}

https://violaceae-1.saga-owl.ts.net:10000 {
	bind 100.114.219.31
	tls /Users/edouard/.config/lifting-plate-calculator/certs/violaceae-1.saga-owl.ts.net.crt /Users/edouard/.config/lifting-plate-calculator/certs/violaceae-1.saga-owl.ts.net.key

	reverse_proxy 127.0.0.1:4179
}
```

With that shape, this app is available to devices on the same Tailscale network at:

```text
https://violaceae-1.saga-owl.ts.net:10000/
```

If adapting this for another machine, replace the hostname, Tailscale IP, certificate paths, and ports. The raw Tailscale IP is useful for binding Caddy, but the `.ts.net` hostname is the better browser URL because it matches the trusted certificate.

## Deploying To Fly.io

`fly.toml` sets `ADDRESS_HEADER=Fly-Client-IP` so rate limiting sees the real client address.

The repo ships a `Dockerfile` (Bun build stage, Node runtime) and a `fly.toml`. The app is a single stateful process with SQLite on a volume, so keep it at exactly one machine.

```bash
fly apps create poll        # or edit `app` in fly.toml first
fly volumes create poll_data --size 1
fly deploy
fly scale count 1
```

The database lives at `/data/votes.sqlite` on the volume. `auto_stop_machines` is enabled; cold starts are a few seconds and the data survives them.

To turn on [describing a vote in words](#describe-a-vote-in-words), set the key as a secret before deploying: `fly secrets set TYPESAFE_API_KEY=<your key>`.

### Backups With Litestream

The image bundles [Litestream](https://litestream.io). When `LITESTREAM_REPLICA_URL` is set, `deploy/start.sh` restores the latest replica onto an empty volume and then runs the app under continuous replication; without it, the app starts normally.

```bash
fly secrets set LITESTREAM_REPLICA_URL=s3://my-bucket/poll \
  LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...
```

Any S3-compatible store works (Tigris, R2, B2); non-AWS endpoints take an `?endpoint=` query on the URL. Without Litestream, take regular volume snapshots if losing poll history would hurt.

## Deploying To Cloudflare Workers

The app is one stateful process (SQLite, in-memory rate limits and MCP sessions), so on Cloudflare it runs inside a single Durable Object, `PollApp`, whose built-in SQLite storage holds the database. `worker/index.ts` forwards every request that isn't a static file to that object, which runs the SvelteKit app built by `@sveltejs/adapter-cloudflare`. `src/db.ts` has a Durable Object driver: transactions use `transactionSync`, and the schema version lives in a `_meta` table because Durable Objects don't allow `PRAGMA user_version`.

```bash
bun run build:cloudflare                 # ADAPTER=cloudflare vite build
npx wrangler dev --local                 # try it locally (state in .wrangler/)
bun run test:e2e:worker                  # the browser suite against the Worker
npx wrangler secret put TYPESAFE_API_KEY # optional: describing a vote in words
npx wrangler secret put OPERATOR_TOKEN   # optional
npx wrangler deploy
```

Or deploy with the `cf` CLI, which can't build SvelteKit projects itself (v1.0.0-beta): `npm run cf:package` builds the app, bundles the Worker with Wrangler without deploying, and writes it in cf's prebuilt format (`.cloudflare/output`); then `cf deploy --prebuilt --secrets-file .env` deploys it to the account cf is signed in to. Without a `routes` or custom domain the Worker is served at `poll.<your-subdomain>.workers.dev`. The Node build (`bun run build`, Docker, Fly) is unchanged and remains the default.

## Useful Commands

Run type and Svelte checks:

```bash
bun run check
```

Run tests:

```bash
bun test
```

Run the browser end-to-end tests (Playwright, Chromium):

```bash
bunx playwright install chromium   # once
bun run test:e2e
```

The suite builds the app and runs the production server (`node build/index.js`, so the strict Content-Security-Policy is in force) on `127.0.0.1:4319` with `RATE_LIMIT=off` and a throwaway SQLite database in the OS temp directory that is deleted afterwards; `work/votes.sqlite` is never touched. Each test drives separate browser contexts as different people, fails on any console error or CSP violation, and a 375px phone project checks for horizontal scrolling. Override the port with `E2E_PORT`. Specs live in `e2e/*.e2e.ts`, so `bun test` (which only runs `tests/`) does not pick them up. In CI they run as a separate `e2e` job that uploads the Playwright report on failure.

Build for production:

```bash
bun run build
```

Preview the production build:

```bash
bun run preview
```

## Data And Privacy Notes

Runtime data is stored locally in `work/votes.sqlite`, which is ignored by Git. The schema is versioned with ordered migrations tracked in `PRAGMA user_version` (each runs in a transaction on startup); opening an older database upgrades it in place, including adding poll slugs and hashing existing tokens. Back up the file before upgrading a database you care about. The app does not implement accounts, email delivery (invite links are copied and sent by the admin), or reminders. It assumes a lightweight trust model where the link is shared with friends or collaborators; capability tokens (a vote edit token per ballot, an admin token per poll) provide just enough ownership without any sign-in. Tokens live in httpOnly cookies and are stored in the database only as SHA-256 hashes, so a leaked database file does not hand out admin or vote-edit access. Poll slugs are random, so polls cannot be enumerated by counting.

Invite links are never stored. Each invitee's token is derived as HMAC-SHA256 keyed by the poll's admin token over `invite:<invite id>` (base64url), and only its SHA-256 hash goes in the `invites` table. The admin page regenerates every link from the admin's own cookie, exactly like the admin link, so a database leak yields no usable invite link, and an operator who is not the poll's own admin sees invitee names and voted status but no links and cannot create new invitees. Losing the admin token means losing the ability to re-show the links (already-issued links keep working). Invite mode limits casual multiple voting under different names; it is not identity verification, since anyone who receives a link can vote as that invitee, and an invitee can forward it.

The admin's invitation list shows who has voted, like a sign-in sheet, even when the poll is anonymous. Anonymous mode still hides how anyone voted, from the admin too, but not participation.

Hidden results (before vote or before close) are enforced server-side: the tally and voter data are excluded from the page payload entirely, not just hidden in the UI. When results are shown for a non-anonymous poll, the page payload includes voter names and reasons but not full ballots; ballots appear only in the admin JSON/CSV export.

Anonymous polls take no name in open-link mode: the ballot is keyed to the voting browser (an internal id derived from its vote token), so one vote per browser still holds and nobody, the admin included, can see how anyone voted. Results show reasons without names, in alphabetical order; anonymous exports list ballots as "Voter N" with their reasons, re-ordered and without timestamps so they do not reveal submission order. In invite-only mode invitees are known by name, so the admin sees who has voted (not how).

## Repository Shape

- `src/routes/`: SvelteKit pages and JSON endpoints.
- `src/lib/`: shared UI and server helpers.
- `src/db.ts`: SQLite-backed store and migrations.
- `src/tally.ts`: vote validation and tally algorithms.
- `src/templates.ts`: poll type metadata, examples, defaults (time polls generate upcoming slots), and external references.
- `src/lib/server/mcp/`: the MCP server (`server.ts`: protocol and sessions; `tools.ts`: the tools; `parity.ts`: which tool covers each web route and action), served by `src/routes/mcp/+server.ts`. `tests/mcp-parity.test.ts` fails when a web capability has no MCP counterpart; `AGENTS.md` and `.claude/skills/mcp-parity/` explain how to add one.
- `src/lib/ics.ts`: iCalendar writer (escaping, line folding) used by the `.ics` route.
- `static/og.png`: the generic link-preview image.
- `tests/`: deterministic tally and route-level integration tests.
- `e2e/`: Playwright browser tests against the production build (`playwright.config.ts` at the root).
