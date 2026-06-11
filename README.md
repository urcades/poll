# Minimal Loomio Voting

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
