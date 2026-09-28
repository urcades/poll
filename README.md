# Poll

A small SvelteKit + Bun voting app for running informal votes with people who have a shared link.

This project started as a local exploration of Loomio-style poll creation and later borrowed a few useful OpaVote ideas. It is intentionally not an account-based election platform. Anyone with the app URL can create drafts, preview ballots, open voting, submit or replace a vote by display name, close polls, and export closed results. Polls are not listed publicly: each one is shared by its link.

## What It Includes

- Draft, open, and closed poll lifecycle.
- Draft preview and draft-only editing before voting opens.
- SQLite persistence through `work/votes.sqlite`.
- Unguessable poll links: every poll has a random 10-character base62 slug (e.g. `/poll/4WZegrFSou`) used in all URLs, API paths, API responses, and export filenames. The internal integer id is never public, and numeric URLs like `/poll/3` return 404.
- One active vote per display name per poll; the same browser can update its vote, and a per-vote edit token (held in a cookie) prevents other visitors from silently replacing it by reusing the name.
- Result visibility controls, anonymous result/export mode, quorum fields, and optional/required/disabled vote reasons.
- A per-poll admin capability: creating a poll mints an admin token (cookie plus a shareable admin link) that is required to edit drafts, open, close, or delete the poll, and export results. Opening the admin link swaps the token for a cookie and redirects to the plain poll URL. Only a SHA-256 hash of the token is stored, so the admin link shown on the poll page is rebuilt from the admin's own cookie; an admin who loses their cookie and link cannot recover it.
- A "My votes" home page listing only the polls this browser created or voted in (grouped as drafts, active, closed), based on its capability cookies. A brand-new visitor sees an empty state; they reach a poll through the link they were given.
- An optional instance operator secret (`OPERATOR_TOKEN` env var). Visiting any poll with `?admin=<OPERATOR_TOKEN>` makes that browser admin of every poll and lets its home page list every poll. This is the only way to manage legacy polls created before admin tokens existed and a way to remove spam. Operators who are not a poll's own admin do not get a shareable admin link.
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

Runtime data is stored locally in `work/votes.sqlite`, which is ignored by Git. The schema is versioned with ordered migrations tracked in `PRAGMA user_version` (each runs in a transaction on startup); opening an older database upgrades it in place, including adding poll slugs and hashing existing tokens. Back up the file before upgrading a database you care about. The app does not implement accounts, email delivery, reminders, or per-voter administration. It assumes a lightweight trust model where the link is shared with friends or collaborators; capability tokens (a vote edit token per ballot, an admin token per poll) provide just enough ownership without any sign-in. Tokens live in httpOnly cookies and are stored in the database only as SHA-256 hashes, so a leaked database file does not hand out admin or vote-edit access. Poll slugs are random, so polls cannot be enumerated by counting.

Hidden results (before vote or before close) are enforced server-side: the tally and voter data are excluded from the page payload entirely, not just hidden in the UI. When results are shown for a non-anonymous poll, the page payload includes voter names and reasons but not full ballots; ballots appear only in the admin JSON/CSV export.

Anonymous voting mode hides voter names and reasons in results and exports, but display names are still stored internally so a voter can update their own ballot. Anonymous exports are re-ordered and omit timestamps so they do not reveal submission order.

## Repository Shape

- `src/routes/`: SvelteKit pages and JSON endpoints.
- `src/lib/`: shared UI and server helpers.
- `src/db.ts`: SQLite-backed store and migrations.
- `src/tally.ts`: vote validation and tally algorithms.
- `src/templates.ts`: poll type metadata, examples, defaults, and external references.
- `tests/`: deterministic tally and route-level integration tests.
