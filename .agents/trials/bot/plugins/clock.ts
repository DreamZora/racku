import { device, RackError } from "racku";
import { Commands, commands } from "racku/std";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

/** The time in an IANA time zone. */
export function timeIn(zone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone.trim(),
      dateStyle: "medium",
      timeStyle: "long",
    }).format(now);
  } catch {
    throw new RackError("BAD_ZONE", `unknown time zone: ${zone}`);
  }
}

export default device({
  model: "clock",
  provides: { commands: Commands },
  powerOn: () => ({
    commands: commands({
      time: {
        description: "Tells the time in a time zone, such as Europe/Berlin",
        input: toStandardJsonSchema(v.string()),
        run: (zone: string) => timeIn(zone),
      },
    }),
  }),
});
