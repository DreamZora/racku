/**
 * The `sqlite` standard device: a `sql/v1` database on `bun:sqlite`.
 *
 * This file is device code and runs only in its Worker. It imports the framework through the
 * package name, so the firmware keeps the framework external instead of bundling a copy.
 *
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-devices
 * @decision .agents/decisions/261115_222025-p0-api-details.md#standard-connectors
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#firmware-build
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { device, RackError } from "rack42u";
import { Sql } from "rack42u/std";
import * as v from "valibot";

const MEMORY = ":memory:";

// One Worker per instance, so module state belongs to this instance alone.
let db: Database | undefined;
let inMemory = false;

interface Statement {
  sql: string;
  params?: (string | number | bigint | boolean | null | Uint8Array)[] | undefined;
}

function open(): Database {
  if (db === undefined) throw new RackError("SQL_ERROR", "the database is closed");
  return db;
}

/** Runs database work, turning driver errors into `SQL_ERROR`. */
function guard<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RackError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    throw new RackError("SQL_ERROR", message, typeof code === "string" ? { code } : undefined);
  }
}

function run(database: Database, { sql, params = [] }: Statement) {
  const statement = database.prepare(sql);
  try {
    const { changes, lastInsertRowid } = statement.run(...(params as SQLQueryBindings[]));
    return { changes, lastInsertRowid };
  } finally {
    statement.finalize();
  }
}

export default device({
  model: "sqlite",
  provides: { sql: Sql },
  config: v.object({ path: v.pipe(v.string(), v.minLength(1)) }),
  powerOn(ctx) {
    inMemory = ctx.config.path === MEMORY;
    if (inMemory) {
      db = new Database(MEMORY);
    } else {
      const file = resolve(ctx.baseDir, ctx.config.path);
      mkdirSync(dirname(file), { recursive: true });
      db = new Database(file, { create: true });
      // The old and the new instance both hold the file open during a swap.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
    }
    return {
      sql: {
        query: ({ sql, params = [] }) =>
          guard(() => {
            const statement = open().prepare(sql);
            try {
              return statement.all(...(params as SQLQueryBindings[])) as Record<
                string,
                string | number | bigint | boolean | null | Uint8Array<ArrayBuffer>
              >[];
            } finally {
              statement.finalize();
            }
          }),
        run: (statement) => guard(() => run(open(), statement)),
        batch: (statements) =>
          guard(() => {
            const database = open();
            return database.transaction(() => statements.map((s) => run(database, s)))();
          }),
      },
    };
  },
  snapshot: () => (inMemory && db !== undefined ? db.serialize() : null),
  restore(ctx, state) {
    if (!inMemory) return;
    if (!(state instanceof Uint8Array)) {
      ctx.log.warn("ignored a snapshot that is not a serialized database");
      return;
    }
    db?.close();
    db = Database.deserialize(state);
  },
  powerOff() {
    db?.close();
    db = undefined;
  },
});
