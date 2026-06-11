import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Option, Poll, PollConfig, PollStatus, PollType, Vote } from "./types";
import { defaultConfigFor } from "./templates";

const require = createRequire(import.meta.url);

type SqliteDatabase = {
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
  const { Database } = require("bun:sqlite") as BunSqliteModule;
  return new Database(path, { create: true });
}

function createNodeDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
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

interface PollRow {
  id: number;
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
  updated_at: string;
}

export interface CreatePollInput {
  type: PollType;
  title: string;
  details: string;
  config: PollConfig;
  opensAt: string | null;
  closesAt: string | null;
  options: Array<{ label: string; meaning: string }>;
}

export interface UpdatePollInput extends CreatePollInput {
  id: number;
}

export class Store {
  db: SqliteDatabase;

  constructor(path = "work/votes.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = createDatabase(path);
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
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
        updated_at TEXT NOT NULL,
        UNIQUE(poll_id, voter_name)
      );
    `);

    const columns = new Set((this.db.query("PRAGMA table_info(polls)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("status")) this.db.run("ALTER TABLE polls ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
    if (!columns.has("opened_at")) this.db.run("ALTER TABLE polls ADD COLUMN opened_at TEXT");
    if (!columns.has("closed_at")) this.db.run("ALTER TABLE polls ADD COLUMN closed_at TEXT");

    const now = new Date().toISOString();
    this.db.query(`
      UPDATE polls
      SET status = 'closed',
          closed_at = COALESCE(closed_at, manually_closed_at, closes_at)
      WHERE status != 'closed'
        AND (manually_closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at <= ?))
    `).run(now);
    this.db.query("UPDATE polls SET opened_at = COALESCE(opened_at, created_at) WHERE status = 'open'").run();
  }

  listPolls(): Poll[] {
    return (this.db.query("SELECT * FROM polls ORDER BY created_at DESC").all() as PollRow[]).map(mapPoll);
  }

  getPoll(id: number): Poll | null {
    const row = this.db.query("SELECT * FROM polls WHERE id = ?").get(id) as PollRow | null;
    return row ? mapPoll(row) : null;
  }

  getOptions(pollId: number): Option[] {
    return (this.db.query("SELECT * FROM options WHERE poll_id = ? ORDER BY sort_order, id").all(pollId) as OptionRow[]).map(mapOption);
  }

  getVotes(pollId: number): Vote[] {
    return (this.db.query("SELECT * FROM votes WHERE poll_id = ? ORDER BY updated_at, id").all(pollId) as VoteRow[]).map(mapVote);
  }

  getVoteByName(pollId: number, voterName: string): Vote | null {
    const row = this.db.query("SELECT * FROM votes WHERE poll_id = ? AND voter_name = ?").get(pollId, voterName.trim()) as VoteRow | null;
    return row ? mapVote(row) : null;
  }

  createPoll(input: CreatePollInput): number {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const insert = this.db.query(`
        INSERT INTO polls (type, title, details, config_json, status, opens_at, closes_at, manually_closed_at, opened_at, closed_at, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, ?)
      `);
      const result = insert.run(
        input.type,
        input.title,
        input.details,
        JSON.stringify(input.config),
        input.opensAt,
        input.closesAt,
        now
      );
      const pollId = Number(result.lastInsertRowid);
      const optionInsert = this.db.query("INSERT INTO options (poll_id, label, meaning, sort_order) VALUES (?, ?, ?, ?)");
      input.options.forEach((option, index) => optionInsert.run(pollId, option.label, option.meaning, index));
      return pollId;
    });
    return tx();
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
      return true;
    });
    return tx();
  }

  openPoll(pollId: number): boolean {
    const result = this.db.query("UPDATE polls SET status = 'open', opened_at = ? WHERE id = ? AND status = 'draft'").run(new Date().toISOString(), pollId);
    return result.changes > 0;
  }

  upsertVote(pollId: number, voterName: string, ballot: unknown, reason: string) {
    this.db.query(`
      INSERT INTO votes (poll_id, voter_name, ballot_json, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(poll_id, voter_name)
      DO UPDATE SET ballot_json = excluded.ballot_json, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(pollId, voterName.trim(), JSON.stringify(ballot), reason, new Date().toISOString());
  }

  closePoll(pollId: number) {
    const now = new Date().toISOString();
    this.db.query("UPDATE polls SET status = 'closed', manually_closed_at = ?, closed_at = ? WHERE id = ?").run(now, now, pollId);
  }
}

function mapPoll(row: PollRow): Poll {
  return {
    id: row.id,
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
