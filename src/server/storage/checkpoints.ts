import { closeSync, constants, fchmodSync, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

function protectFile(path: string, create: boolean): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error();
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(realpathSync(dirname(resolve(path))), basename(path));
  }
}

/** Resumption storage only; business transitions remain in ApplicationDatabase. */
export class WorkflowCheckpoints {
  readonly saver: SqliteSaver;
  #closed = false;

  constructor(path: string, applicationPath?: string) {
    let db: Database.Database | undefined;
    try {
      // Empty SQLite paths and :memory: silently create nonpersistent stores.
      if (!path.trim() || path === ':memory:') throw new Error();
      if (applicationPath && applicationPath !== ':memory:') {
        if (canonicalPath(path) === canonicalPath(applicationPath)) throw new Error();
        try {
          const checkpoint = statSync(path);
          const application = statSync(applicationPath);
          if (checkpoint.dev === application.dev && checkpoint.ino === application.ino) throw new Error();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      protectFile(path, true);
      // SqliteSaver enables WAL lazily. Existing sidecars must also be private,
      // regular files; SQLite creates new sidecars with the database's mode.
      for (const suffix of ['-wal', '-shm', '-journal']) protectFile(`${path}${suffix}`, false);
      db = new Database(path);
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      db.pragma('trusted_schema = OFF');
      this.saver = new SqliteSaver(db);
    } catch {
      try { db?.close(); } catch { /* Do not expose paths or SQL details. */ }
      throw new Error('checkpoint_store_initialization_failed');
    }
  }

  /** Exercise the library's lazy setup and a real checkpoint query. */
  async ready(): Promise<boolean> {
    if (this.#closed) return false;
    try {
      await this.saver.getTuple({ configurable: { thread_id: '', checkpoint_ns: '__readiness__' } });
      return true;
    } catch { return false; }
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.saver.db.close();
      this.#closed = true;
    } catch { throw new Error('checkpoint_store_close_failed'); }
  }
}
