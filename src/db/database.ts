import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Migration = string | ((db: DatabaseSync) => void);

export interface OpenOptions {
  backupDir?: string;
}

export function openDatabase(path: string, migrations: readonly Migration[], options: OpenOptions = {}): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const db = new DatabaseSync(path, { defensive: true });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
    const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (current > migrations.length) throw new Error('データベースのスキーマがこのアプリより新しいため開けません');
    if (existed && current < migrations.length && options.backupDir) {
      mkdirSync(options.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = join(options.backupDir, `clive-v${current}-${stamp}.db`);
      db.prepare('VACUUM INTO ?').run(target);
    }
    transaction(db, () => {
      for (let version = current; version < migrations.length; version++) {
        const migration = migrations[version]!;
        if (typeof migration === 'string') db.exec(migration); else migration(db);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT clive_nested' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(nested ? 'RELEASE clive_nested' : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO clive_nested; RELEASE clive_nested' : 'ROLLBACK');
    throw error;
  }
}
