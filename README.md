# Poll

A small SvelteKit + Bun voting app for running informal votes with people who have a shared link.

This project started as a local exploration of Loomio-style poll creation and later borrowed a few useful OpaVote ideas. It is intentionally not an account-based election platform. Anyone with the app URL can create drafts, preview ballots, open voting, submit or replace a vote by display name, close polls, and export closed results.

## What It Includes

- Draft, open, and closed poll lifecycle.
- Draft preview and draft-only editing before voting opens.
- SQLite persistence through `work/votes.sqlite`.
- One active vote per display name per poll; later submissions replace earlier ones.
- Result visibility controls, anonymous result/export mode, quorum fields, and optional/required/disabled vote reasons.
- JSON and CSV exports for closed polls.
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

Runtime data is stored locally in `work/votes.sqlite`, which is ignored by Git. The app does not implement authentication, ownership, email delivery, reminders, or per-voter administration. It assumes a lightweight trust model where the link is shared with friends or collaborators.

Anonymous voting mode hides voter names and reasons in results and exports, but display names are still stored internally so repeat submissions can replace earlier votes.

## Repository Shape

- `src/routes/`: SvelteKit pages and JSON endpoints.
- `src/lib/`: shared UI and server helpers.
- `src/db.ts`: SQLite-backed store and migrations.
- `src/tally.ts`: vote validation and tally algorithms.
- `src/templates.ts`: poll type metadata, examples, defaults, and external references.
- `tests/`: deterministic tally and route-level integration tests.
