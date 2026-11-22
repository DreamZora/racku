import { rack } from "racku";
import { httpPanel } from "racku/std";

export default rack("bot", {
  devices: [
    "./devices",
    httpPanel({
      port: Number(process.env.PORT ?? 3000),
      routes: { "/messages": "bot.http", "/commands": "bot.http" },
    }),
  ],
  hotplug: ["./plugins"],
  roots: ["http-panel"],
});
