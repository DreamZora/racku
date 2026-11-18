import { listenerDevice } from "../listener-device.ts";

/** Serves HTTP and WebSocket on listeners of its own, replaced by cold swaps. */
export default listenerDevice("listener", false, "cold");
