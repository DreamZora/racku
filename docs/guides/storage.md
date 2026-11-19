# Storage devices

`rack42u/std` exports the standard connectors and the factories that mount the standard devices. Each factory takes `{ name }` in `options` to rename the device. The [HTTP panel](http.md) is a standard device too.

## memkv

`memkv(options?)` provides `kv: Kv` (`kv/v1`), an in-memory store of string keys and string values: `get(key)`, `set({ key, value })`, `delete(key)`, `keys(prefix)`, and a `changed` event with the key after every `set` and every `delete` that removed a key. Entries move to the new instance during swaps and hot reloads; a restart starts empty.

## sqlite

`sqlite(config, options?)` provides `sql: Sql` (`sql/v1`) on `bun:sqlite`: `query({ sql, params? })` returns rows as objects, `run({ sql, params? })` returns `{ changes, lastInsertRowid }`, and `batch([...statements])` runs statements in one transaction and rolls back if one fails. Parameters bind to positional `?` placeholders. `config.path` is relative to the base directory, missing directories are created, and file databases use WAL mode; `":memory:"` gives an in-memory database that moves to the new instance during a swap. Database errors fail with `SQL_ERROR`, with the driver's code, such as `SQLITE_CONSTRAINT_UNIQUE`, in `data.code`.
