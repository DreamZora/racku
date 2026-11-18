/**
 * Pipes that hold a device's Worker thread inside a system call until the test releases them, as
 * native code that hangs does. A device blocks by reading the pipe's path with `readFileSync`.
 * - On Linux and macOS a pipe is a FIFO, and a reader blocks opening it until a writer comes.
 * - On Windows, which has no FIFOs, it is a named pipe that this process serves without writing
 *   to it, and a reader blocks reading it.
 *
 * @decision .agents/decisions/261117_185131-ending-instances.md#tests
 * @decision .agents/decisions/261118_015204-windows.md#changes-to-the-repository-and-the-tests
 */
import { closeSync, constants, openSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

/** A path whose readers block until {@link BlockingPipe.release}. */
export interface BlockingPipe {
  /** What a device reads to block. */
  readonly path: string;
  /**
   * Lets every thread blocked on the pipe go on. A thread that reads it afterwards blocks again.
   *
   * @returns Whether a thread was blocked on it.
   */
  release(): Promise<boolean>;
  /** Lets every blocked thread go on, and on Windows stops serving the pipe. */
  close(): Promise<void>;
}

let made = 0;

/**
 * Creates a pipe: a FIFO in `dir`, or on Windows a named pipe that this process serves.
 *
 * @throws Error when the pipe cannot be created.
 */
export function blockingPipe(dir: string): Promise<BlockingPipe> {
  return process.platform === "win32" ? windowsPipe() : fifo(join(dir, `pipe-${made++}`));
}

async function fifo(path: string): Promise<BlockingPipe> {
  const created = Bun.spawnSync(["mkfifo", path]);
  if (created.exitCode !== 0) throw new Error(`mkfifo ${path}: ${created.stderr.toString()}`);
  return {
    path,
    release: () => releaseFifo(path),
    async close() {
      try {
        await releaseFifo(path);
      } catch {
        // Gone with its app directory: no thread can block on it any more.
      }
    },
  };
}

/**
 * Opens the FIFO for writing and closes it again, which lets every thread blocked opening it go
 * on.
 *
 * Once its Worker is terminated, a blocked thread leaves its open for an instant each time
 * JavaScriptCore signals it to deliver the termination, about every half millisecond, and the
 * FIFO has no reader in that instant. So an open that finds no reader is tried again, for up to
 * 100 ms.
 */
async function releaseFifo(path: string): Promise<boolean> {
  const until = performance.now() + 100;
  for (;;) {
    try {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
      return true;
    } catch (error) {
      // ENXIO: nothing has the FIFO open for reading, at least at this instant.
      if ((error as { code?: string }).code !== "ENXIO") throw error;
      if (performance.now() >= until) return false;
      await Bun.sleep(1);
    }
  }
}

async function windowsPipe(): Promise<BlockingPipe> {
  const path = `\\\\.\\pipe\\rack42u-test-${process.pid}-${made++}`;
  const readers = new Set<Socket>();
  const server = createServer((reader) => {
    readers.add(reader);
    reader.on("close", () => readers.delete(reader));
    // A reader whose thread ends drops its end of the pipe, which is no failure of the test.
    reader.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  const endReaders = (): boolean => {
    const blocked = readers.size > 0;
    for (const reader of readers) reader.end();
    readers.clear();
    return blocked;
  };
  return {
    path,
    async release() {
      // A reader's connection reaches this thread's event loop shortly after it opens the pipe.
      const until = performance.now() + 100;
      while (readers.size === 0 && performance.now() < until) await Bun.sleep(1);
      return endReaders();
    },
    async close() {
      endReaders();
      server.close();
    },
  };
}
