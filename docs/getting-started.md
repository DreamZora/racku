# Getting started

This guide builds a small app of your own, outside the rack42u repository: a notes service that keeps its notes in SQLite, behind the HTTP panel. It takes the steps every app takes: add rack42u, define a connector, write devices, mount them in a rack, run it, test a device on the bench, and change a device while the rack runs.

You need [Bun](https://bun.sh) 1.4.4 or later, git, and access to the rack42u repository on GitHub.

## Create the app

Make a directory for the app, with a `package.json` whose scripts run the `rack` command:

```json
{
  "name": "notes",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "rack start",
    "dev": "rack dev",
    "test": "bun test"
  }
}
```

## Add rack42u

rack42u isn't published to a registry; an app depends on it through git, at a tag of its repository. Add it, and valibot for the schemas:

```sh
bun add git+ssh://git@github.com/DreamZora/rack42u.git#v0.5.0 valibot
```

- Bun clones the repository with git, over HTTPS first and then over SSH, so git's credentials for GitHub or an SSH key with access to the repository will do. A `git+https://github.com/...` URL doesn't work for a private repository, since Bun downloads those from GitHub's API without credentials.
- Pin a tag or a commit: until rack42u's first formal release, any version may break the API.
- To use a local clone of rack42u instead, give its path as a URL, such as `git+file:///home/you/rack42u#v0.5.0`.

## Define a connector

A connector is the contract between two devices: here, adding a note and listing them. Every device that uses it imports this file:

```ts
// connectors.ts
import { connector, rpc } from "rack42u";
import * as v from "valibot";

const Note = v.object({ id: v.number(), text: v.string() });

export const Notes = connector("notes/v1", {
  add: rpc(v.string(), Note),
  list: rpc(v.undefined(), v.array(Note)),
});
```

## Write the devices

The `notes` device provides `Notes`, and keeps the notes in a SQL database that it needs, `Sql` from `rack42u/std`:

```ts
// devices/notes.ts
import { device } from "rack42u";
import { Sql } from "rack42u/std";
import { Notes } from "../connectors.ts";

export default device({
  model: "notes",
  needs: { db: Sql },
  provides: { notes: Notes },

  async powerOn(ctx) {
    await ctx.ports.db.run({
      sql: "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
    });
    return {
      notes: {
        async add(text) {
          const sql = "INSERT INTO notes (text) VALUES (?)";
          const { lastInsertRowid } = await ctx.ports.db.run({ sql, params: [text] });
          return { id: Number(lastInsertRowid), text };
        },
        async list() {
          const rows = await ctx.ports.db.query({ sql: "SELECT id, text FROM notes ORDER BY id" });
          return rows.map((row) => ({ id: Number(row.id), text: String(row.text) }));
        },
      },
    };
  },
});
```

The `web` device turns HTTP requests into calls to `notes`. It provides `Http`, the connector the HTTP panel calls, and `httpHandler` adapts a function from `Request` to `Response` to it:

```ts
// devices/web.ts
import { device } from "rack42u";
import { Http, httpHandler } from "rack42u/std";
import { Notes } from "../connectors.ts";

export default device({
  model: "web",
  needs: { notes: Notes },
  provides: { http: Http },

  powerOn: (ctx) => ({
    http: httpHandler(async (request) => {
      if (request.method === "POST") {
        return Response.json(await ctx.ports.notes.add(await request.text()));
      }
      return Response.json(await ctx.ports.notes.list(undefined));
    }),
  }),
});
```

Neither device imports the other: each calls the ports it needs, and the rack connects them.

## Mount them in a rack

The manifest names the device in each slot, from the bottom up. A device may need only devices below it, so the database comes first and the HTTP panel, which routes `/notes` to the `web` device, comes last:

```ts
// rack.ts
import { rack, slot } from "rack42u";
import { httpPanel, sqlite } from "rack42u/std";

export default rack("notes", {
  slots: {
    1: sqlite({ path: "data/notes.db" }),
    2: slot("./devices/notes.ts"),
    3: slot("./devices/web.ts"),
    4: httpPanel({ port: 3000, routes: { "/notes": "web.http" } }),
  },
});
```

The rack wires each need to the only device below it that provides the connector: `notes` to the database, and `web` to `notes`.

## Run it

```sh
bun run start
```

The rack builds each device file into firmware under `.rack/`, starts the devices from the bottom up, and logs `rack notes started`. In another terminal:

```sh
curl -X POST localhost:3000/notes -d 'Buy milk'
# {"id":1,"text":"Buy milk"}
curl -X POST localhost:3000/notes -d 'Call Ada'
# {"id":2,"text":"Call Ada"}
curl localhost:3000/notes
# [{"id":1,"text":"Buy milk"},{"id":2,"text":"Call Ada"}]
```

Press Ctrl-C to stop the rack: it stops the devices from the top down. The notes stay in `data/notes.db`. Keep `.rack/` and `data/` out of version control.

## Test a device

The bench runs one device in a rack of its own, with a stub for each of its needs. This test gives `notes` a database made of an array:

```ts
// devices/notes.test.ts
import { expect, test } from "bun:test";
import { bench, stub } from "rack42u/bench";
import { Sql } from "rack42u/std";

test("notes adds a note and lists it", async () => {
  const rows: { id: number; text: string }[] = [];
  await using notes = await bench(new URL("./notes.ts", import.meta.url), {
    needs: {
      db: stub(Sql, {
        run({ sql, params }) {
          if (sql.startsWith("INSERT")) rows.push({ id: rows.length + 1, text: String(params?.[0]) });
          return { changes: 1, lastInsertRowid: rows.length };
        },
        query: () => rows,
      }),
    },
  });
  expect(await notes.call("notes", "add", "Buy milk")).toEqual({ id: 1, text: "Buy milk" });
  expect(await notes.call("notes", "list", undefined)).toEqual([{ id: 1, text: "Buy milk" }]);
});
```

```sh
bun run test
```

## Change a device while it runs

`rack dev` starts the rack, then replaces the devices whose files change, while the rest keep running:

```sh
bun run dev
```

In `devices/notes.ts`, list the newest note first:

```ts
const rows = await ctx.ports.db.query({ sql: "SELECT id, text FROM notes ORDER BY id DESC" });
```

The rack rebuilds every device, and replaces only `notes`, whose firmware changed. The database keeps the notes, and the panel keeps serving:

```sh
curl localhost:3000/notes
# [{"id":2,"text":"Call Ada"},{"id":1,"text":"Buy milk"}]
```

## Working with an agent

rack42u comes with a skill for coding agents, such as Claude Code: the workflow of an app, the rules that keep devices swappable, the pitfalls, and which document answers what. It is in the package; copy it into the app, where an agent that works in the app finds it:

```sh
mkdir -p .claude/skills && cp -r node_modules/rack42u/skills/rack42u .claude/skills/
```

## Where to go next

- [Concepts](concepts.md) explains how a rack works: slots, devices, connectors, the backplane, firmware, swaps, and faults.
- The [guides](README.md#guides) cover each part in depth, starting with [Devices](guides/devices.md).
- [Design](design.md) says why rack42u is built this way.
