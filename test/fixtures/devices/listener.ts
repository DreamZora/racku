import { listenerDevice } from "../listener-device.ts";

/** Serves HTTP and WebSocket on listeners of its own, without a state handover. */
export default listenerDevice("listener", false);
