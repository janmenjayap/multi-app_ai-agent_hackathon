import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeMonitorSchema, MonitorStore } from './monitor-store.js';

export const APPLICATION_STORE_VERSION = 1;

/** The application and monitor share this connection; checkpoints never do. */
export class ApplicationDatabase {
  readonly connection: DatabaseSync;
  readonly monitor: MonitorStore;
  #closed = false;

  constructor(path: string) {
    let connection: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          if (!fstatSync(fd).isFile()) throw new Error();
          fchmodSync(fd, 0o600);
        } finally { closeSync(fd); }
      }
      connection = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      connection.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
      connection.exec('BEGIN IMMEDIATE');
      initializeMonitorSchema(connection);
      connection.exec(`CREATE TABLE IF NOT EXISTS application_migrations (
        migration_id INTEGER PRIMARY KEY, migration_digest TEXT NOT NULL
      ) STRICT`);
      let migration: string;
      try { migration = readFileSync(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8'); }
      catch { migration = readFileSync(new URL('../../../src/server/migrations/001-initial.sql', import.meta.url), 'utf8'); }
      const hash = createHash('sha256').update(migration).digest('hex');
      const applied = connection.prepare('SELECT * FROM application_migrations ORDER BY migration_id').all();
      if (applied.some(row => row.migration_id !== APPLICATION_STORE_VERSION || row.migration_digest !== hash)) throw new Error();
      if (!applied.length) {
        connection.exec(migration);
        connection.prepare('INSERT INTO application_migrations VALUES (?, ?)').run(APPLICATION_STORE_VERSION, hash);
      }
      connection.exec('COMMIT');
      this.connection = connection;
      this.monitor = new MonitorStore(connection);
    } catch {
      try { if (connection?.isTransaction) connection.exec('ROLLBACK'); connection?.close(); } catch { /* Fixed outward error. */ }
      throw new Error('application_store_initialization_failed');
    }
  }

  /** Synchronous, short local work only. Returning a Promise always rolls back. */
  transaction<T>(action: () => T): T {
    if (this.#closed) throw new Error('application_store_closed');
    if (this.connection.isTransaction) throw new Error('nested_application_transaction');
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) throw new Error();
      this.connection.exec('COMMIT');
      return result;
    } catch {
      try { this.connection.exec('ROLLBACK'); } catch { /* Keep SQL and private values restricted. */ }
      throw new Error('application_transaction_failed');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.monitor.close();
    this.connection.close();
    this.#closed = true;
  }
}
