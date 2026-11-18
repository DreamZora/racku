import { device } from "rack42u";
import streamer from "./streamer.ts";

/** The streams device, replaced by cold swaps: its old instance stops before the new one starts. */
export default device({ ...streamer, swap: "cold" });
