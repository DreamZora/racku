/**
 * The dashboard's page: it reads the rack through the dashboard, and shows it.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#the-page
 */
import type { SlotStatus } from "../../reports.ts";

const app = document.getElementById("app");
// A page in another site's frame shows nothing.
// @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
if (app !== null && window.top === window.self) {
  const devices: SlotStatus[] = [];
  app.textContent = `racku dashboard: ${devices.length} devices`;
}
