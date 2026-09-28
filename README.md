# Poll

A small SvelteKit + Bun voting app for running informal votes with people who have a shared link.

This project started as a local exploration of Loomio-style poll creation and later borrowed a few useful OpaVote ideas. It is intentionally not an account-based election platform. Anyone with the app URL can create drafts, preview ballots, open voting, submit or replace a vote by display name, close polls, and export closed results.

## What It Includes

- Draft, open, and closed poll lifecycle.
- Draft preview and draft-only editing before voting opens.
- SQLite persistence through `work/votes.sqlite`.
- One active vote per display name per poll; the same browser can update its vote, and a per-vote edit token (held in a cookie) prevents other visitors from silently replacing it by reusing the name.
- Result visibility controls, anonymous result/export mode, quorum fields, and optional/required/disabled vote reasons.
- A per-poll admin capability: creating a poll mints an admin token (cookie plus a shareable admin link) that is required to edit drafts, open or close voting, and export results. Polls created before this feature have no token and remain open to everyone.
- JSON and CSV exports for closed polls (admin only).
- A SvelteKit frontend styled with `@flowercomputer/flowerparts`.

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

The database lives at `/data/votes.sqlite` on the volume. Take volume snapshots (or add Litestream) if losing poll history would hurt. `auto_stop_machines` is enabled; cold starts are a few seconds and the data survives them.

## Useful Commands

Run type and Svelte checks:

```bash
bun run check
```

Run tests:

```bash
bun test
```

Build for production:

```bash
bun run build
```

Preview the production build:

```bash
bun run preview
```

## Data And Privacy Notes

Runtime data is stored locally in `work/votes.sqlite`, which is ignored by Git. The app does not implement accounts, email delivery, reminders, or per-voter administration. It assumes a lightweight trust model where the link is shared with friends or collaborators; capability tokens (a vote edit token per ballot, an admin token per poll) provide just enough ownership without any sign-in.

Hidden results (before vote or before close) are enforced server-side: the tally and voter data are excluded from the page payload entirely, not just hidden in the UI.

Anonymous voting mode hides voter names and reasons in results and exports, but display names are still stored internally so a voter can update their own ballot. Anonymous exports are re-ordered and omit timestamps so they do not reveal submission order.

## Repository Shape

- `src/routes/`: SvelteKit pages and JSON endpoints.
- `src/lib/`: shared UI and server helpers.
- `src/db.ts`: SQLite-backed store and migrations.
- `src/tally.ts`: vote validation and tally algorithms.
- `src/templates.ts`: poll type metadata, examples, defaults, and external references.
- `tests/`: deterministic tally and route-level integration tests.
