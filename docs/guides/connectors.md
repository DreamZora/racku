# Connectors

A connector is a contract between devices: a name, a version, and the schemas of its members.

## Defining a connector

A connector lists RPC methods (`rpc(input, output)`) and events (`event(payload)`). Schemas can come from any library that implements [Standard Schema](https://standardschema.dev), such as valibot or zod.

```ts
// connectors.ts
import { connector, event, rpc } from "rack42u";
import * as v from "valibot";

export const Greeter = connector("acme.greeter/v1", {
  greet: rpc(v.object({ name: v.string() }), v.string()),
  greeted: event(v.object({ name: v.string() })),
});
```

## Ids and versions

The id has the form `<name>/v<major>`; change the major version for incompatible changes.

## Validation

The provider validates RPC input and output, and the publisher validates event payloads.
