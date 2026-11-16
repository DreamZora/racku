import { device } from "rack42u";

/** A device file whose top-level code throws, so it fails to load. */
throw new Error("broken at load");

// Unreachable; keeps the file shaped like a device file.
export default device({ model: "never" });
