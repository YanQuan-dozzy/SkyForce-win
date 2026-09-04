import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HistoryItem } from '../shared/types';

interface HistoryWrite {
  sourceName: string;
  outputName: string;
  mode: string;
  template: string;
  status: number;
  errorMessage?: string;
  noteCount?: number;
  bpm?: number;
  elapsedMs: number;
}

export class AppDatabase {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(userDataDirectory: string) {
    this.path = join(userDataDirectory, 'data', 'skyforce.db');
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, {
      timeout: 5_000,
      defensive: true
    });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversion_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_name TEXT NOT NULL,
        output_name TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        template TEXT NOT NULL,
        status INTEGER NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        note_count INTEGER NOT NULL DEFAULT 0,
        bpm INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_history_created ON conversion_history(created_at DESC);
      CREATE TABLE IF NOT EXISTS editor_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        format TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_meta(key, value) VALUES ('schema_version', '1')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
  }

  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const output: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        output[row.key] = JSON.parse(row.value_json);
      } catch {
        output[row.key] = row.value_json;
      }
    }
    return output;
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO settings(key, value_json, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=CURRENT_TIMESTAMP
    `).run(key, JSON.stringify(value));
  }

  addHistory(item: HistoryWrite): void {
    this.db.prepare(`
      INSERT INTO conversion_history(
        source_name, output_name, mode, template, status,
        error_message, note_count, bpm, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.sourceName,
      item.outputName,
      item.mode,
      item.template,
      item.status,
      item.errorMessage ?? '',
      item.noteCount ?? 0,
      item.bpm ?? 0,
      item.elapsedMs
    );
  }

  listHistory(limit = 100): HistoryItem[] {
    const safeLimit = Math.max(1, Math.min(500, Math.round(limit)));
    return this.db.prepare(`
      SELECT id, source_name, output_name, mode, template, status,
             error_message, note_count, bpm, elapsed_ms, created_at
      FROM conversion_history ORDER BY id DESC LIMIT ?
    `).all(safeLimit) as unknown as HistoryItem[];
  }

  clearHistory(): void {
    this.db.exec('DELETE FROM conversion_history;');
  }

  async backup(destination: string): Promise<void> {
    await backup(this.db, destination, { rate: 100 });
  }

  close(): void {
    this.db.close();
  }
}
