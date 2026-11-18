import { listenerDevice } from "../listener-device.ts";

/** Serves HTTP and WebSocket on listeners of its own, and hands its count over in a swap. */
export default listenerDevice("listener-state", true);
