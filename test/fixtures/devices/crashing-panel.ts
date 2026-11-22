import { device } from "racku";
import panel from "../../../src/std/http-panel.ts";
import { PanelControl } from "../connectors.ts";

/**
 * The standard HTTP panel with a port that crashes it, since the panel has no port to call. It
 * keeps the panel's model, configuration, needs, and hooks, so it is named `http-panel` too.
 */
export default device({
  model: panel.model,
  config: panel.config,
  // The panel's needs come from its configuration.
  needs: panel.needsOf as never,
  provides: { control: PanelControl },
  async powerOn(ctx) {
    // The panel's hooks take its own context type; this context is the same at run time.
    await panel.powerOn?.(ctx as never);
    return {
      control: {
        crash() {
          setTimeout(() => process.exit(3), 10);
        },
      },
    };
  },
  activate: (ctx, scope) => panel.activate?.(ctx as never, scope),
});
