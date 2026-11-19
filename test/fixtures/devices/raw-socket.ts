import { device } from "rack42u";
import { RawSocket } from "../connectors.ts";

/** Opens a TCP echo server of its own with `Bun.listen`, which the rack neither sees nor hands over. */
export default device({
  model: "raw-socket",
  provides: { raw: RawSocket },
  powerOn() {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          socket.write(data);
        },
      },
    });
    return { raw: { port: () => server.port } };
  },
});
