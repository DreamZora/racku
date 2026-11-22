/**
 * A client that asks for `/big?size=<size>` on 127.0.0.1:<port>, reads 1 MiB of the answer, and
 * then stops reading, as a client that hangs does. It prints `stopped` then, and once it reads
 * again, 3 s later, prints `closed <bytes>` when the connection closes.
 *
 * The test freezes this process with SIGSTOP where the system has it, since a paused socket of a
 * test's own process doesn't always stop the reads of the kernel on macOS.
 *
 * Run as `bun stalled-reader.ts <port> <size>`.
 */
import { connect } from "node:net";

const port = Number(process.argv[2]);
const size = Number(process.argv[3]);
let got = 0;
let stopped = false;
const socket = connect(port, "127.0.0.1", () => {
  socket.write(
    `GET /big?size=${size} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
});
socket.on("data", (chunk: Buffer) => {
  got += chunk.byteLength;
  if (got > 1024 * 1024 && !stopped) {
    stopped = true;
    socket.pause();
    console.log("stopped");
    setTimeout(() => socket.resume(), 3_000);
  }
});
socket.on("close", () => {
  console.log(`closed ${got}`);
  process.exit(0);
});
socket.on("error", () => {});
