import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Invite, Option, Poll, PollConfig, PollStatus, PollType, Vote } from "./types";
import { defaultConfigFor } from "./templates";

type SqliteDatabase = {
  /** Durable Object storage: no PRAGMA user_version, foreign_keys or WAL; versions live in _meta. */
  durable?: boolean;
  close(): void;
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): unknown;
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  };
  transaction<T>(fn: () => T): () => T;
};

type BunSqliteModule = {
  Database: new (path: string, options: { create: boolean }) => SqliteDatabase;
};

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
    };
  };
};

function createDatabase(path: string): SqliteDatabase {
  if (!("Bun" in globalThis)) return createNodeDatabase(path);
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as BunSqliteModule;
  return new Database(path, { create: true });
}

function createNodeDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;
  const db = new DatabaseSync(path);
  return {
    close: () => db.close(),
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    query: (sql) => {
      const statement = db.prepare(sql);
      return {
        all: (...params) => statement.all(...params),
        get: (...params) => statement.get(...params),
        run: (...params) => statement.run(...params)
      };
    },
    transaction: (fn) => () => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

/** The parts of a Durable Object's storage the driver needs (see worker/index.ts). */
export interface DurableStorage {
  sql: { exec(sql: string, ...params: unknown[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

// Durable Object SQL binds strings, numbers, null and buffers only.
const bindable = (params: unknown[]) => params.map((value) => (typeof value === "boolean" ? Number(value) : value === undefined ? null : value));

function createDurableDatabase(storage: DurableStorage): SqliteDatabase {
  const rows = (sql: string, params: unknown[]) => storage.sql.exec(sql, ...bindable(params)).toArray();
  const run = (sql: string, params: unknown[]) => {
    rows(sql, params);
    const meta = rows("SELECT changes() AS changes, last_insert_rowid() AS id", []);
    const { changes, id } = meta[0] as { changes: number; id: number };
    return { changes, lastInsertRowid: id };
  };
  return {
    durable: true,
    close: () => {},
    exec: (sql) => void storage.sql.exec(sql),
    run: (sql, ...params) => run(sql, params),
    query: (sql) => ({
      all: (...params) => rows(sql, params),
      get: (...params) => rows(sql, params)[0] ?? null,
      run: (...params) => run(sql, params)
    }),
    transaction: (fn) => () => storage.transactionSync(fn)
  };
}

interface PollRow {
  id: number;
  slug: string;
  type: PollType;
  title: string;
  details: string;
  config_json: string;
  status: PollStatus;
  opens_at: string | null;
  closes_at: string | null;
  manually_closed_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
  admin_token_hash: string;
  created_at: string;
}

interface OptionRow {
  id: number;
  poll_id: number;
  label: string;
  meaning: string;
  sort_order: number;
}

interface VoteRow {
  id: number;
  poll_id: number;
  voter_name: string;
  ballot_json: string;
  reason: string;
  edit_token_hash: string;
  updated_at: string;
}

const SLUG_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SLUG_LENGTH = 10;

/** Random URL-safe public poll id: 10 base62 chars (~59 bits), rejection-sampled so it is unbiased. */
export function generateSlug(): string {
  let slug = "";
  while (slug.length < SLUG_LENGTH) {
    for (const byte of randomBytes(SLUG_LENGTH * 2)) {
      if (byte >= 248) continue; // 248 = 62 * 4, avoids modulo bias
      slug += SLUG_ALPHABET[byte % 62];
      if (slug.length === SLUG_LENGTH) break;
    }
  }
  return slug;
}

/** Capability tokens are stored only as SHA-256 hex; cookies/URLs carry the plaintext. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented plaintext token against a stored hash. Empty stored hash never matches. */
export function tokenMatches(storedHash: string, presented: string): boolean {
  if (!storedHash || !presented) return false;
  const a = Buffer.from(hashToken(presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Personal voting token for one invitee: HMAC-SHA256 keyed by the poll's
 * plaintext admin token over `invite:<invite id>`, base64url. Only
 * `hashToken()` of it is stored, so the admin (who holds the admin token) can
 * regenerate every invite link on demand while the database alone, or an
 * operator who is not the poll admin, cannot.
 */
export function deriveInviteToken(adminToken: string, inviteId: number): string {
  return createHmac("sha256", adminToken).update(`invite:${inviteId}`).digest("base64url");
}

export const MAX_INVITEES = 500;

interface InviteRow {
  id: number;
  poll_id: number;
  name: string;
  token_hash: string;
  created_at: string;
}

const NO_ADMIN_TOKEN_MESSAGE = "Invite links can only be created with the poll's own admin link (the operator token cannot derive them).";

export interface CreatePollInput {
  type: PollType;
  title: string;
  details: string;
  config: PollConfig;
  opensAt: string | null;
  closesAt: string | null;
  options: Array<{ label: string; meaning: string }>;
  /** Plaintext admin token; only its hash is stored. */
  adminToken?: string;
  /** Invitee names for `voterMode: "invite"` (already trimmed and de-duplicated). Ignored in open mode. */
  invitees?: string[];
  /** Which description (see lib/server/suggest.ts) this poll was pre-filled from; used only by the usage log. */
  suggestionId?: string;
}

export interface UpdatePollInput extends CreatePollInput {
  id: number;
}

interface Migration {
  version: number;
  up(db: SqliteDatabase): void;
}

function columnNames(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

// Ordered, append-only. Each runs in its own transaction and is recorded in
// PRAGMA user_version. Never edit a shipped migration; add a new one.
const MIGRATIONS: Migration[] = [
  {
    // Baseline: takes a fresh DB or any pre-versioning DB (which may lack the
    // status/opened_at/closed_at/admin_token/edit_token columns) to the schema
    // as it stood before slugs and hashed tokens. Idempotent.
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          config_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          opens_at TEXT,
          closes_at TEXT,
          manually_closed_at TEXT,
          opened_at TEXT,
          closed_at TEXT,
          admin_token TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS options (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          meaning TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          voter_name TEXT NOT NULL,
          ballot_json TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          edit_token TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          UNIQUE(poll_id, voter_name)
        );
      `);
      const columns = columnNames(db, "polls");
      if (!columns.has("status")) db.run("ALTER TABLE polls ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
      if (!columns.has("opened_at")) db.run("ALTER TABLE polls ADD COLUMN opened_at TEXT");
      if (!columns.has("closed_at")) db.run("ALTER TABLE polls ADD COLUMN closed_at TEXT");
      if (!columns.has("admin_token")) db.run("ALTER TABLE polls ADD COLUMN admin_token TEXT NOT NULL DEFAULT ''");
      if (!columnNames(db, "votes").has("edit_token")) db.run("ALTER TABLE votes ADD COLUMN edit_token TEXT NOT NULL DEFAULT ''");
    }
  },
  {
    // Public slugs. SQLite cannot add a NOT NULL UNIQUE column in place, so
    // rebuild polls (the documented 12-step recipe; foreign keys are off).
    version: 2,
    up(db) {
      const seq = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'polls'").get() as { seq: number } | null;
      db.exec(`
        CREATE TABLE polls_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          config_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          opens_at TEXT,
          closes_at TEXT,
          manually_closed_at TEXT,
          opened_at TEXT,
          closed_at TEXT,
          admin_token TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
      `);
      const insert = db.query(`
        INSERT INTO polls_new (id, slug, type, title, details, config_json, status, opens_at, closes_at, manually_closed_at, opened_at, closed_at, admin_token, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const used = new Set<string>();
      for (const row of db.query("SELECT * FROM polls ORDER BY id").all() as Array<Record<string, unknown>>) {
        let slug = generateSlug();
        while (used.has(slug)) slug = generateSlug();
        used.add(slug);
        insert.run(row.id, slug, row.type, row.title, row.details, row.config_json, row.status, row.opens_at, row.closes_at, row.manually_closed_at, row.opened_at, row.closed_at, row.admin_token, row.created_at);
      }
      db.exec("DROP TABLE polls; ALTER TABLE polls_new RENAME TO polls;");
      // Keep AUTOINCREMENT high-water mark so deleted poll ids are never reused.
      if (seq) {
        db.query("DELETE FROM sqlite_sequence WHERE name = 'polls'").run();
        db.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('polls', ?)").run(seq.seq);
      }
    }
  },
  {
    // Hash capability tokens at rest. Existing plaintext cookies keep working
    // because comparison hashes the presented value. Empty stays empty (legacy).
    version: 3,
    up(db) {
      db.exec("ALTER TABLE polls RENAME COLUMN admin_token TO admin_token_hash");
      db.exec("ALTER TABLE votes RENAME COLUMN edit_token TO edit_token_hash");
      for (const row of db.query("SELECT id, admin_token_hash AS token FROM polls WHERE admin_token_hash != ''").all() as Array<{ id: number; token: string }>) {
        db.query("UPDATE polls SET admin_token_hash = ? WHERE id = ?").run(hashToken(row.token), row.id);
      }
      for (const row of db.query("SELECT id, edit_token_hash AS token FROM votes WHERE edit_token_hash != ''").all() as Array<{ id: number; token: string }>) {
        db.query("UPDATE votes SET edit_token_hash = ? WHERE id = ?").run(hashToken(row.token), row.id);
      }
    }
  },
  {
    // Invite mode: one row per invited voter. Only a hash of each personal
    // token is stored; the token itself is re-derived from the admin token.
    // AUTOINCREMENT so a deleted invite's id (and thus its derived token) is
    // never reissued to a different person.
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(poll_id, name)
        );
      `);
    }
  },
  {
    // Votes became final by default (allowVoteChanges: false). Polls created
    // before that keep the behaviour they were created with: changes allowed.
    version: 5,
    up(db) {
      db.exec(`
        UPDATE polls
        SET config_json = json_set(config_json, '$.allowVoteChanges', json('true'))
        WHERE json_extract(config_json, '$.allowVoteChanges') IS NULL;
      `);
    }
  },
  {
    // Usage log: one row per event (see lib/server/events.ts). No foreign
    // keys: events outlive the polls they describe, so polls are named by slug.
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          poll_slug TEXT NOT NULL DEFAULT '',
          session TEXT NOT NULL DEFAULT '',
          data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
        CREATE INDEX IF NOT EXISTS events_kind ON events (kind, ts);
        CREATE INDEX IF NOT EXISTS events_poll ON events (poll_slug, ts);
        CREATE INDEX IF NOT EXISTS events_session ON events (session, ts);
      `);
    }
  }
];

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  source: string;
  pollSlug: string;
  session: string;
  data: Record<string, unknown>;
}

export interface EventFilter {
  kind?: string;
  /** Matches kinds starting with this (for example "poll_" or "client_"). */
  kindPrefix?: string;
  pollSlug?: string;
  session?: string;
  source?: string;
  since?: string;
  until?: string;
  /** Substring search over the event's data (prompts, titles, paths...). */
  text?: string;
  /** Only events with an id below this (for paging newest-first). */
  before?: number;
  limit?: number;
}

export class Store {
  db: SqliteDatabase;

  constructor(path: string | DurableStorage = "work/votes.sqlite") {
    if (typeof path !== "string") {
      this.db = createDurableDatabase(path);
      this.migrate();
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = createDatabase(path);
    this.db.run("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
    }
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    if (this.db.durable) {
      this.migrateDurable();
    } else {
      this.migrateFile();
    }
    this.sweepSchedule();
    this.db.query("UPDATE polls SET opened_at = COALESCE(opened_at, created_at) WHERE status = 'open'").run();
  }

  /** Durable Objects always enforce foreign keys; defer the checks to each migration's commit instead. */
  private migrateDurable() {
    this.db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const row = this.db.query("SELECT value FROM _meta WHERE key = 'user_version'").get() as { value: number } | null;
    const current = row?.value ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.transaction(() => {
        this.db.exec("PRAGMA defer_foreign_keys = ON");
        migration.up(this.db);
        this.db.query("INSERT INTO _meta (key, value) VALUES ('user_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(migration.version);
      })();
    }
  }

  private migrateFile() {
    // Table rebuilds (migration 2) need foreign keys off; that pragma is a
    // no-op inside a transaction, so toggle it around the whole run.
    this.db.run("PRAGMA foreign_keys = OFF");
    try {
      const current = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        this.db.transaction(() => {
          migration.up(this.db);
          this.db.exec(`PRAGMA user_version = ${migration.version}`);
          const violations = this.db.query("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error(`Migration ${migration.version} left foreign key violations.`);
        })();
      }
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
  }

  /**
   * Applies time-driven transitions: scheduled polls whose `opens_at` has
   * passed become open (opened_at = opens_at), then open polls that were
   * manually closed or whose `closes_at` has passed become closed.
   */
  // ---- Usage events (lib/server/events.ts decides what to record) ----

  insertEvent(event: { ts: string; kind: string; source: string; pollSlug: string; session: string; data: unknown }): number {
    const result = this.db.query("INSERT INTO events (ts, kind, source, poll_slug, session, data_json) VALUES (?, ?, ?, ?, ?, ?)").run(event.ts, event.kind, event.source, event.pollSlug, event.session, JSON.stringify(event.data));
    return Number(result.lastInsertRowid);
  }

  private eventWhere(filter: EventFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      clauses.push(clause);
      params.push(value);
    };
    const like = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    if (filter.kind) add("kind = ?", filter.kind);
    if (filter.kindPrefix) add("kind LIKE ? ESCAPE '\\'", `${like(filter.kindPrefix).slice(1, -1)}%`);
    if (filter.pollSlug) add("poll_slug = ?", filter.pollSlug);
    if (filter.session) add("session = ?", filter.session);
    if (filter.source) add("source = ?", filter.source);
    if (filter.since) add("ts >= ?", filter.since);
    if (filter.until) add("ts < ?", filter.until);
    if (filter.before) add("id < ?", filter.before);
    if (filter.text) add("data_json LIKE ? ESCAPE '\\'", like(filter.text));
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /** Newest first. */
  listEvents(filter: EventFilter = {}): EventRow[] {
    const { sql, params } = this.eventWhere(filter);
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 5000);
    const rows = this.db.query(`SELECT id, ts, kind, source, poll_slug, session, data_json FROM events ${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Array<{ id: number; ts: string; kind: string; source: string; poll_slug: string; session: string; data_json: string }>;
    return rows.map((row) => ({ id: row.id, ts: row.ts, kind: row.kind, source: row.source, pollSlug: row.poll_slug, session: row.session, data: JSON.parse(row.data_json) as Record<string, unknown> }));
  }

  /** Counts per kind and day, for the overview. */
  eventSummary(filter: EventFilter = {}): Array<{ day: string; kind: string; count: number }> {
    const { sql, params } = this.eventWhere({ ...filter, before: undefined });
    return this.db.query(`SELECT substr(ts, 1, 10) AS day, kind, COUNT(*) AS count FROM events ${sql} GROUP BY day, kind ORDER BY day DESC, count DESC`).all(...params) as Array<{ day: string; kind: string; count: number }>;
  }

  /** The newest event of a kind whose data has `field` equal to `value` (for example a describe by its suggestionId). */
  findEvent(kind: string, field: string, value: string): EventRow | null {
    const row = this.db.query("SELECT id, ts, kind, source, poll_slug, session, data_json FROM events WHERE kind = ? AND json_extract(data_json, ?) = ? ORDER BY id DESC LIMIT 1").get(kind, `$.${field}`, value) as { id: number; ts: string; kind: string; source: string; poll_slug: string; session: string; data_json: string } | null;
    return row ? { id: row.id, ts: row.ts, kind: row.kind, source: row.source, pollSlug: row.poll_slug, session: row.session, data: JSON.parse(row.data_json) as Record<string, unknown> } : null;
  }

  pruneEvents(olderThanIso: string): number {
    return this.db.query("DELETE FROM events WHERE ts < ?").run(olderThanIso).changes;
  }

  sweepSchedule() {
    const now = new Date().toISOString();
    const opening = this.db.query("SELECT EXISTS(SELECT 1 FROM polls WHERE status = 'scheduled' AND opens_at IS NOT NULL AND opens_at <= ?) AS due").get(now) as { due: number };
    if (opening.due) {
      this.db.query(`
        UPDATE polls
        SET status = 'open',
            opened_at = COALESCE(opened_at, opens_at)
        WHERE status = 'scheduled' AND opens_at IS NOT NULL AND opens_at <= ?
      `).run(now);
    }
    const due = this.db.query(`
      SELECT EXISTS(
        SELECT 1 FROM polls
        WHERE status = 'open'
          AND (manually_closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at <= ?))
      ) AS due
    `).get(now) as { due: number };
    if (!due.due) return;
    this.db.query(`
      UPDATE polls
      SET status = 'closed',
          closed_at = COALESCE(closed_at, manually_closed_at, closes_at)
      WHERE status = 'open'
        AND (manually_closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at <= ?))
    `).run(now);
  }

  listPolls(): Poll[] {
    this.sweepSchedule();
    return (this.db.query("SELECT * FROM polls ORDER BY created_at DESC").all() as PollRow[]).map(mapPoll);
  }

  getPoll(id: number): Poll | null {
    this.sweepSchedule();
    const row = this.db.query("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | null;
    return row ? mapPoll(row) : null;
  }

  getPollBySlug(slug: string): Poll | null {
    this.sweepSchedule();
    const row = this.db.query("SELECT * FROM polls WHERE slug = ?").get(slug) as PollRow | null;
    return row ? mapPoll(row) : null;
  }

  /** Cheap change marker for live refresh: one aggregate query, no tally. Null if the slug is unknown. */
  pollVersion(slug: string): string | null {
    this.sweepSchedule();
    const now = new Date().toISOString();
    const row = this.db.query(`
      SELECT p.status AS status,
             COALESCE(p.closed_at, '') AS closed_at,
             (p.opens_at IS NULL OR p.opens_at <= ?1) AS started,
             (p.closes_at IS NOT NULL AND p.closes_at <= ?1) AS ended,
             (SELECT COUNT(*) FROM votes v WHERE v.poll_id = p.id) AS votes,
             (SELECT COALESCE(MAX(v.updated_at), '') FROM votes v WHERE v.poll_id = p.id) AS last_vote,
             (SELECT COUNT(*) FROM invites i WHERE i.poll_id = p.id) AS invites
      FROM polls p WHERE p.slug = ?2
    `).get(now, slug) as { status: string; closed_at: string; started: number; ended: number; votes: number; last_vote: string; invites: number } | null;
    if (!row) return null;
    return [row.status, row.closed_at, row.started, row.ended, row.votes, row.last_vote, row.invites].join("|");
  }

  getOptions(pollId: number): Option[] {
    return (this.db.query("SELECT * FROM options WHERE poll_id = ? ORDER BY sort_order, id").all(pollId) as OptionRow[]).map(mapOption);
  }

  getVotes(pollId: number): Vote[] {
    return (this.db.query("SELECT * FROM votes WHERE poll_id = ? ORDER BY updated_at, id").all(pollId) as VoteRow[]).map(mapVote);
  }

  getVoteByName(pollId: number, voterName: string, editToken = ""): Vote | null {
    const row = this.db.query("SELECT * FROM votes WHERE poll_id = ? AND voter_name = ?").get(pollId, voterName.trim()) as VoteRow | null;
    if (!row) return null;
    // Votes claimed with an edit token are only visible to the holder; legacy
    // rows without a token stay name-addressable.
    if (row.edit_token_hash && !tokenMatches(row.edit_token_hash, editToken)) return null;
    return mapVote(row);
  }

  createPoll(input: CreatePollInput): { id: number; slug: string } {
    const now = new Date().toISOString();
    const adminHash = input.adminToken ? hashToken(input.adminToken) : "";
    for (let attempt = 0; ; attempt++) {
      const slug = generateSlug();
      try {
        return this.db.transaction(() => {
          const insert = this.db.query(`
            INSERT INTO polls (slug, type, title, details, config_json, status, opens_at, closes_at, manually_closed_at, opened_at, closed_at, admin_token_hash, created_at)
            VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, ?, ?)
          `);
          const result = insert.run(
            slug,
            input.type,
            input.title,
            input.details,
            JSON.stringify(input.config),
            input.opensAt,
            input.closesAt,
            adminHash,
            now
          );
          const pollId = Number(result.lastInsertRowid);
          const optionInsert = this.db.query("INSERT INTO options (poll_id, label, meaning, sort_order) VALUES (?, ?, ?, ?)");
          input.options.forEach((option, index) => optionInsert.run(pollId, option.label, option.meaning, index));
          this.syncInvitees(pollId, input.config.voterMode === "invite" ? input.invitees ?? [] : [], input.adminToken ?? "");
          return { id: pollId, slug };
        })();
      } catch (error) {
        // Astronomically unlikely slug collision: retry with a fresh slug.
        if (attempt < 5 && String(error).includes("UNIQUE") && String(error).includes("slug")) continue;
        throw error;
      }
    }
  }

  updatePoll(input: UpdatePollInput): boolean {
    const tx = this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE polls
        SET type = ?, title = ?, details = ?, config_json = ?, opens_at = ?, closes_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(
        input.type,
        input.title,
        input.details,
        JSON.stringify(input.config),
        input.opensAt,
        input.closesAt,
        input.id
      );
      if (result.changes === 0) return false;
      this.db.query("DELETE FROM options WHERE poll_id = ?").run(input.id);
      const optionInsert = this.db.query("INSERT INTO options (poll_id, label, meaning, sort_order) VALUES (?, ?, ?, ?)");
      input.options.forEach((option, index) => optionInsert.run(input.id, option.label, option.meaning, index));
      this.syncInvitees(input.id, input.config.voterMode === "invite" ? input.invitees ?? [] : [], input.adminToken ?? "");
      return true;
    });
    return tx();
  }

  getInvites(pollId: number): Invite[] {
    return (this.db.query("SELECT * FROM invites WHERE poll_id = ? ORDER BY id").all(pollId) as InviteRow[]).map(mapInvite);
  }

  countInvites(pollId: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM invites WHERE poll_id = ?").get(pollId) as { n: number }).n;
  }

  /**
   * The invite whose personal token this is, or null. Looks the hash up
   * directly: the hash of a secret reveals nothing through lookup timing.
   */
  findInviteByToken(pollId: number, token: string): Invite | null {
    if (!token) return null;
    const row = this.db.query("SELECT * FROM invites WHERE poll_id = ? AND token_hash = ?").get(pollId, hashToken(token)) as InviteRow | null;
    return row ? mapInvite(row) : null;
  }

  /**
   * Makes the poll's invitees exactly `names` (draft setup). Existing rows for
   * kept names are untouched so their links stay valid. Removing someone who
   * already voted is refused. Creating links needs the plaintext admin token.
   */
  replaceInvitees(pollId: number, names: string[], adminToken: string) {
    this.db.transaction(() => this.syncInvitees(pollId, names, adminToken))();
  }

  /** Adds invitees (skipping names already invited, compared case-insensitively). Returns the names actually added. */
  addInvitees(pollId: number, names: string[], adminToken: string): string[] {
    return this.db.transaction(() => {
      const existing = new Set(this.getInvites(pollId).map((invite) => invite.name.toLowerCase()));
      const fresh: string[] = [];
      for (const name of names) {
        if (existing.has(name.toLowerCase())) continue;
        existing.add(name.toLowerCase());
        fresh.push(name);
      }
      if (fresh.length && !adminToken) throw new Error(NO_ADMIN_TOKEN_MESSAGE);
      if (existing.size > MAX_INVITEES) throw new Error(`Too many invitees (max ${MAX_INVITEES}).`);
      for (const name of fresh) this.insertInvite(pollId, name, adminToken);
      return fresh;
    })();
  }

  /** Not transactional on its own: call inside a transaction. */
  private syncInvitees(pollId: number, names: string[], adminToken: string) {
    if (names.length > MAX_INVITEES) throw new Error(`Too many invitees (max ${MAX_INVITEES}).`);
    const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
    const current = this.getInvites(pollId);
    const kept = new Set<string>();
    for (const invite of current) {
      const key = invite.name.toLowerCase();
      if (wanted.has(key) && wanted.get(key) === invite.name) {
        kept.add(key);
        continue;
      }
      const voted = this.db.query("SELECT 1 AS x FROM votes WHERE poll_id = ? AND voter_name = ?").get(pollId, invite.name);
      if (voted) throw new Error(`${invite.name} has already voted and cannot be removed from the invitee list.`);
      this.db.query("DELETE FROM invites WHERE id = ?").run(invite.id);
    }
    const fresh = [...wanted.entries()].filter(([key]) => !kept.has(key)).map(([, name]) => name);
    if (fresh.length && !adminToken) throw new Error(NO_ADMIN_TOKEN_MESSAGE);
    for (const name of fresh) this.insertInvite(pollId, name, adminToken);
  }

  private insertInvite(pollId: number, name: string, adminToken: string) {
    // The token depends on the row id, so insert first and then store its hash.
    const result = this.db.query("INSERT INTO invites (poll_id, name, token_hash, created_at) VALUES (?, ?, '', ?)").run(pollId, name, new Date().toISOString());
    const id = Number(result.lastInsertRowid);
    this.db.query("UPDATE invites SET token_hash = ? WHERE id = ?").run(hashToken(deriveInviteToken(adminToken, id)), id);
  }

  /** True if `token` is this poll's admin token. Only hashes are stored; legacy polls (empty hash) never match. */
  verifyAdminToken(pollId: number, token: string): boolean {
    const row = this.db.query("SELECT admin_token_hash FROM polls WHERE id = ?").get(pollId) as { admin_token_hash: string } | null;
    return tokenMatches(row?.admin_token_hash ?? "", token);
  }

  /** True if `token` is the edit token of any vote in this poll. */
  hasVoteToken(pollId: number, token: string): boolean {
    if (!token) return false;
    const rows = this.db.query("SELECT edit_token_hash FROM votes WHERE poll_id = ? AND edit_token_hash != ''").all(pollId) as Array<{ edit_token_hash: string }>;
    return rows.some((row) => tokenMatches(row.edit_token_hash, token));
  }

  /** The voter name on the ballot whose edit token this is, or null. */
  voterNameForToken(pollId: number, token: string): string | null {
    if (!token) return null;
    const rows = this.db.query("SELECT voter_name, edit_token_hash FROM votes WHERE poll_id = ? AND edit_token_hash != ''").all(pollId) as Array<{ voter_name: string; edit_token_hash: string }>;
    return rows.find((row) => tokenMatches(row.edit_token_hash, token))?.voter_name ?? null;
  }

  /** Draft -> scheduled. The caller has checked `opens_at` is set, in the future, and before `closes_at`. */
  schedulePoll(pollId: number): boolean {
    const result = this.db.query("UPDATE polls SET status = 'scheduled' WHERE id = ? AND status = 'draft' AND opens_at IS NOT NULL").run(pollId);
    return result.changes > 0;
  }

  /** Scheduled -> draft (setup becomes editable again). Returns false if it already opened. */
  unschedulePoll(pollId: number): boolean {
    this.sweepSchedule();
    const result = this.db.query("UPDATE polls SET status = 'draft' WHERE id = ? AND status = 'scheduled'").run(pollId);
    return result.changes > 0;
  }

  /**
   * A new draft with the source's type, title ("Copy of ..."), details, config,
   * options and invitee names, and a new admin token (hence fresh invite links).
   * No votes and no dates are carried over.
   */
  duplicatePoll(pollId: number, adminToken: string): { id: number; slug: string } {
    const source = this.getPoll(pollId);
    if (!source) throw new Error("Poll not found.");
    return this.createPoll({
      type: source.type,
      title: `Copy of ${source.title}`.slice(0, 200),
      details: source.details,
      config: source.config,
      opensAt: null,
      closesAt: null,
      options: this.getOptions(pollId).map((option) => ({ label: option.label, meaning: option.meaning })),
      adminToken,
      invitees: this.getInvites(pollId).map((invite) => invite.name)
    });
  }

  openPoll(pollId: number): boolean {
    const result = this.db.query("UPDATE polls SET status = 'open', opened_at = ? WHERE id = ? AND status = 'draft'").run(new Date().toISOString(), pollId);
    return result.changes > 0;
  }

  upsertVote(pollId: number, voterName: string, ballot: unknown, reason: string, editToken = "") {
    const name = voterName.trim();
    const tx = this.db.transaction(() => {
      const existing = this.db.query("SELECT edit_token_hash FROM votes WHERE poll_id = ? AND voter_name = ?").get(pollId, name) as { edit_token_hash: string } | null;
      if (existing && existing.edit_token_hash && !tokenMatches(existing.edit_token_hash, editToken)) {
        throw new Error("This display name has already voted from another device. Pick a different name, or vote from the original device to update the ballot.");
      }
      this.db.query(`
        INSERT INTO votes (poll_id, voter_name, ballot_json, reason, edit_token_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(poll_id, voter_name)
        DO UPDATE SET ballot_json = excluded.ballot_json, reason = excluded.reason, edit_token_hash = excluded.edit_token_hash, updated_at = excluded.updated_at
      `).run(pollId, name, JSON.stringify(ballot), reason, editToken ? hashToken(editToken) : "", new Date().toISOString());
    });
    tx();
  }

  deletePoll(pollId: number): boolean {
    const result = this.db.query("DELETE FROM polls WHERE id = ?").run(pollId);
    return result.changes > 0;
  }

  closePoll(pollId: number) {
    const now = new Date().toISOString();
    this.db.query("UPDATE polls SET status = 'closed', manually_closed_at = ?, closed_at = ? WHERE id = ?").run(now, now, pollId);
  }
}

function mapPoll(row: PollRow): Poll {
  return {
    id: row.id,
    slug: row.slug,
    type: row.type,
    title: row.title,
    details: row.details,
    config: { ...defaultConfigFor(row.type), ...JSON.parse(row.config_json) },
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    manuallyClosedAt: row.manually_closed_at,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    createdAt: row.created_at
  };
}

function mapInvite(row: InviteRow): Invite {
  return { id: row.id, pollId: row.poll_id, name: row.name, createdAt: row.created_at };
}

function mapOption(row: OptionRow): Option {
  return {
    id: row.id,
    pollId: row.poll_id,
    label: row.label,
    meaning: row.meaning,
    sortOrder: row.sort_order
  };
}

function mapVote(row: VoteRow): Vote {
  return {
    id: row.id,
    pollId: row.poll_id,
    voterName: row.voter_name,
    ballot: JSON.parse(row.ballot_json),
    reason: row.reason,
    updatedAt: row.updated_at
  };
}
