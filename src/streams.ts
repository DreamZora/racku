/**
 * Byte streams in calls: both ends of a stream on one channel, a link or the data channel.
 *
 * A stream travels as `stream` messages multiplexed with the calls of its channel. The sending
 * end copies each chunk into buffers of its own, at most {@link STREAM_PIECE} bytes each, and
 * moves them. The receiving end grants {@link STREAM_WINDOW} bytes of credit when the stream
 * opens and returns credit for each chunk its reader takes, so the sending end reads its source
 * only as fast as the reader takes chunks. Each end fails the stream with `RACK_TIMEOUT` when
 * nothing moves for the stream's idle timeout, and every stream ends with its channel.
 *
 * @decision .agents/decisions/261118_071155-backplane-streams.md#streams-in-calls
 * @decision .agents/decisions/261118_071155-backplane-streams.md#transport
 * @decision .agents/decisions/261118_071155-backplane-streams.md#flow-control
 * @decision .agents/decisions/261118_071155-backplane-streams.md#timeouts
 * @decision .agents/decisions/261118_071155-backplane-streams.md#cancellation-and-errors
 */
import { fromWireError, RackError, toWireError, type WireError } from "./errors.ts";
import type { StreamMetrics } from "./metrics.ts";

/** The credit a receiving end grants when a stream opens: the most bytes of a stream in flight. */
export const STREAM_WINDOW = 256 * 1024;

/** The largest piece of a chunk on a channel; a larger chunk travels in pieces. */
export const STREAM_PIECE = 1024 * 1024;

/** The longest delay a timer can wait; Bun runs a timer with a longer one after 1 ms. */
export const LONGEST_TIMER = 2 ** 31 - 1;

/**
 * Where a call's input or result carries its stream: the key of the top-level property, or
 * `null` for the value itself, and the stream's id on the channel.
 */
export type StreamSlot = [key: string | null, id: number];

/** Sending end to receiving end: the next piece of the stream, moved. */
export interface StreamChunk {
  t: "stream";
  k: "chunk";
  s: number;
  data: ArrayBuffer;
}

/** Sending end to receiving end: the stream ended. */
export interface StreamEnd {
  t: "stream";
  k: "end";
  s: number;
}

/** Sending end to receiving end: the stream failed. */
export interface StreamFailure {
  t: "stream";
  k: "error";
  s: number;
  error: WireError;
}

/** Receiving end to sending end: bytes the sending end may send. */
export interface StreamCredit {
  t: "stream";
  k: "credit";
  s: number;
  bytes: number;
}

/** Receiving end to sending end: the stream is cancelled, or failed at the receiving end. */
export interface StreamCancel {
  t: "stream";
  k: "cancel";
  s: number;
  error: WireError;
}

/**
 * A message of a stream. `s` is the stream's id, which the sending end chose: unique among the
 * streams that end sends on the channel.
 */
export type StreamMessage = StreamChunk | StreamEnd | StreamFailure | StreamCredit | StreamCancel;

/** What each end of a stream needs from the call that carries it. */
export interface StreamOptions {
  /** Idle timeout in ms: the stream fails with `RACK_TIMEOUT` when nothing moves for so long. */
  idle: number;
  /** `<need>.<member>` or `<device>.<port>.<member>`, for messages. */
  where: string;
  /** The counters of the member whose call carries the stream. */
  counters: StreamMetrics;
  /** Runs once, when the stream has ended, failed, or been cancelled; `error` unless it ended. */
  onEnd: (error: RackError | undefined) => void;
}

/**
 * Arms a timer, or none for an infinite delay. A finite delay longer than a timer can wait
 * waits the longest it can, about 24.8 days.
 *
 * @returns The timer, or `undefined` when `ms` is infinite or not a number.
 */
export function armTimer(ms: number, task: () => void): ReturnType<typeof setTimeout> | undefined {
  if (!Number.isFinite(ms)) return undefined;
  return setTimeout(task, Math.min(Math.max(0, ms), LONGEST_TIMER));
}

/** Errors of cancelling a source are the source's own; the stream has ended either way. */
function ignore(): void {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Sets a property as `{ ...value }` would, also for a key such as `__proto__`. */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A stream taken out of a call's input or result; see {@link takeStream}. */
export interface TakenStream {
  /** The value without the stream: the stream's property is `null`, or the value is `null`. */
  value: unknown;
  /** The key of the stream's property, or `null` when the value was the stream. */
  key: string | null;
  stream: ReadableStream<unknown>;
}

/**
 * Finds the stream that a call's input or result carries: the value itself, or a top-level
 * property of a plain object. A stream anywhere else stays in the value, which then can't be
 * cloned, as any value that holds one.
 *
 * @param code The error code when the value carries more than one stream.
 * @param where `<need>.<member>` or `<device>.<port>.<member>`, for the message.
 * @returns The stream and the value without it, or `undefined` when the value carries none.
 * @throws RackError with `code` when the value carries more than one stream at the top level.
 */
export function takeStream(value: unknown, code: string, where: string): TakenStream | undefined {
  if (value instanceof ReadableStream) return { value: null, key: null, stream: value };
  if (!isPlainObject(value)) return undefined;
  let found: { key: string; stream: ReadableStream<unknown> } | undefined;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (!(item instanceof ReadableStream)) continue;
    if (found !== undefined) {
      throw new RackError(
        code,
        `${where}: carries more than one stream; a call carries at most one in its input and one in its output`,
      );
    }
    found = { key, stream: item };
  }
  if (found === undefined) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) define(copy, key, key === found.key ? null : value[key]);
  return { value: copy, key: found.key, stream: found.stream };
}

/**
 * Puts a received stream back where the sending end took it from.
 *
 * @param value The value as it arrived, a structured clone that no one else holds.
 * @returns The value with the stream in place.
 */
export function putStream(
  value: unknown,
  key: string | null,
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
): unknown {
  if (key === null) return stream;
  if (isPlainObject(value)) define(value, key, stream);
  return value;
}

/**
 * Cancels the streams at the top level of a value, for a call or a result that fails before
 * they can go. A stream that something is reading can't be cancelled, and stays as it is.
 */
export function cancelStreams(value: unknown, error: RackError): void {
  const cancel = (stream: ReadableStream<unknown>) => {
    if (!stream.locked) stream.cancel(error).catch(ignore);
  };
  if (value instanceof ReadableStream) cancel(value);
  else if (isPlainObject(value)) {
    for (const item of Object.values(value)) if (item instanceof ReadableStream) cancel(item);
  }
}

/** Copies a chunk into pieces of at most {@link STREAM_PIECE} bytes, each in a buffer of its own. */
function split(chunk: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < chunk.byteLength; offset += STREAM_PIECE) {
    const end = Math.min(chunk.byteLength, offset + STREAM_PIECE);
    // A buffer of the piece's own size, never one from a pool that other views share.
    const piece = new Uint8Array(end - offset);
    piece.set(chunk.subarray(offset, end));
    pieces.push(piece);
  }
  return pieces;
}

function countEnd(counters: StreamMetrics, error: RackError | undefined): void {
  counters.open--;
  if (error !== undefined) counters.errors[error.code] = (counters.errors[error.code] ?? 0) + 1;
}

/**
 * The sending end of a stream: it reads the source while it has credit, and sends what it reads.
 * It takes the stream at once, so a call owns its stream from the moment it is made.
 */
export class StreamSender {
  /** The source's reader; the stream types of Bun and of `node:stream/web` both fit it. */
  readonly #reader: {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel(reason?: unknown): Promise<void>;
  };
  readonly #invalid: string;
  readonly #options: StreamOptions;
  #channel: StreamChannel | undefined;
  #id = 0;
  /** Bytes the receiving end let this end send, minus the bytes sent; below 0 after a big piece. */
  #credit = 0;
  /** Pieces of the chunk read last that are not sent yet. */
  #pieces: Uint8Array<ArrayBuffer>[] = [];
  #reading = false;
  #done = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Takes the source: locks it and starts the idle timeout. Nothing is read or sent until the
   * stream is attached to a channel and the receiving end grants credit.
   *
   * @param invalid The error code of a chunk that isn't a `Uint8Array`, and of a locked source:
   *   `RACK_INVALID_INPUT` for a stream in the input, `RACK_INVALID_OUTPUT` in the output.
   * @throws RackError with `invalid` when the source is locked.
   */
  constructor(source: ReadableStream<unknown>, invalid: string, options: StreamOptions) {
    if (source.locked) {
      throw new RackError(invalid, `${options.where}: the stream is locked by a reader`);
    }
    this.#reader = source.getReader();
    this.#invalid = invalid;
    this.#options = options;
    options.counters.opened++;
    options.counters.open++;
    this.#arm();
  }

  /** The stream has ended, failed, or been cancelled. */
  get done(): boolean {
    return this.#done;
  }

  /** Called by {@link StreamChannel.attach}: the stream goes out on `channel` with `id`. */
  bind(channel: StreamChannel, id: number): void {
    this.#channel = channel;
    this.#id = id;
  }

  /** The receiving end granted `bytes`. */
  credit(bytes: number): void {
    if (this.#done) return;
    this.#credit += bytes;
    this.#arm();
    this.#flush();
  }

  /** The receiving end cancelled the stream, or failed: the source is cancelled with `error`. */
  cancelled(error: WireError): void {
    this.#end(fromWireError(error), false, true);
  }

  /** Cancels the stream: the source and the receiving end both get `error`. */
  cancel(error: RackError): void {
    this.#end(error, true, true);
  }

  /** The channel is gone: the source is cancelled with `error`, and no message goes out. */
  lost(error: RackError): void {
    this.#end(error, false, true);
  }

  #flush(): void {
    while (!this.#done && this.#pieces.length > 0) {
      const piece = this.#pieces[0] as Uint8Array<ArrayBuffer>;
      // A piece larger than the credit left goes once nothing of the stream is in flight.
      if (piece.byteLength > this.#credit && this.#credit < STREAM_WINDOW) return;
      this.#pieces.shift();
      // Counted before the post, which detaches the piece's buffer and empties the piece.
      const size = piece.byteLength;
      this.#credit -= size;
      this.#channel?.post({ t: "stream", k: "chunk", s: this.#id, data: piece.buffer }, [
        piece.buffer,
      ]);
      this.#options.counters.bytesSent += size;
      this.#arm();
    }
    if (!this.#done && this.#channel !== undefined && this.#credit > 0 && !this.#reading) {
      this.#read();
    }
  }

  #read(): void {
    this.#reading = true;
    this.#reader.read().then(
      ({ done, value }) => {
        this.#reading = false;
        if (this.#done) return;
        if (done) {
          this.#channel?.post({ t: "stream", k: "end", s: this.#id });
          this.#finish(undefined);
          return;
        }
        if (!(value instanceof Uint8Array)) {
          const where = this.#options.where;
          this.#end(
            new RackError(this.#invalid, `${where}: a stream chunk must be a Uint8Array`),
            true,
            true,
          );
          return;
        }
        this.#pieces = split(value);
        this.#flush();
      },
      (error: unknown) => {
        this.#reading = false;
        // The source failed, and its reader with it: the receiving end gets the source's error.
        this.#end(fromWireError(toWireError(error)), true, false);
      },
    );
  }

  #arm(): void {
    clearTimeout(this.#timer);
    const { idle, where } = this.#options;
    this.#timer = armTimer(idle, () => {
      const error = new RackError(
        "RACK_TIMEOUT",
        `${where}: the stream moved nothing for ${idle} ms`,
      );
      this.#end(error, true, true);
    });
  }

  #end(error: RackError, notify: boolean, cancelSource: boolean): void {
    if (this.#done) return;
    if (notify) {
      this.#channel?.post({ t: "stream", k: "error", s: this.#id, error: toWireError(error) });
    }
    if (cancelSource) this.#reader.cancel(error).catch(ignore);
    this.#finish(error);
  }

  #finish(error: RackError | undefined): void {
    this.#done = true;
    clearTimeout(this.#timer);
    this.#pieces = [];
    this.#channel?.forgetSender(this.#id);
    countEnd(this.#options.counters, error);
    this.#options.onEnd(error);
  }
}

/**
 * The receiving end of a stream: a `ReadableStream` for device code, which gets each piece as
 * the reader takes it and returns credit for it.
 */
export class StreamReceiver {
  /** The stream device code reads. */
  readonly stream: ReadableStream<Uint8Array<ArrayBuffer>>;
  readonly #channel: StreamChannel;
  readonly #id: number;
  readonly #options: StreamOptions;
  #controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
  /** Pieces that arrived and the reader hasn't taken; the credit bounds them. */
  #queue: Uint8Array<ArrayBuffer>[] = [];
  #ended = false;
  /** The source's error, which the reader gets once it has taken the pieces sent before it. */
  #failure: RackError | undefined;
  #done = false;
  #wake: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** Opens the receiving end and grants the window. Use {@link StreamChannel.receive}. */
  constructor(channel: StreamChannel, id: number, options: StreamOptions) {
    this.#channel = channel;
    this.#id = id;
    this.#options = options;
    this.stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: (controller) => this.#pull(controller),
        cancel: (reason) => this.#cancelledByReader(reason),
      },
      // Nothing waits in the stream itself: a piece leaves the queue only when a read asks.
      { highWaterMark: 0 },
    );
    options.counters.opened++;
    options.counters.open++;
    channel.post({ t: "stream", k: "credit", s: id, bytes: STREAM_WINDOW });
    this.#arm();
  }

  /** The stream has ended, failed, or been cancelled. */
  get done(): boolean {
    return this.#done;
  }

  /** A piece arrived. */
  chunk(data: ArrayBuffer): void {
    if (this.#done) return;
    this.#options.counters.bytesReceived += data.byteLength;
    this.#queue.push(new Uint8Array(data));
    this.#arm();
    this.#wakeUp();
  }

  /** The sending end ended the stream. */
  end(): void {
    if (this.#done) return;
    this.#ended = true;
    if (this.#queue.length === 0) this.#close();
    this.#wakeUp();
  }

  /**
   * The sending end failed the stream. The reader still gets the pieces that arrived before,
   * then the error.
   */
  failed(error: WireError): void {
    if (this.#done) return;
    if (this.#queue.length === 0) {
      this.#fail(fromWireError(error), false);
      return;
    }
    this.#failure = fromWireError(error);
  }

  /** Cancels the stream: the reader's stream errors with `error`, and the source is cancelled. */
  cancel(error: RackError): void {
    this.#fail(error, true);
  }

  /** The channel is gone: the reader's stream errors with `error`, and no message goes out. */
  lost(error: RackError): void {
    this.#fail(error, false);
  }

  #pull(
    controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>,
  ): Promise<void> | void {
    if (this.#done) return;
    const piece = this.#queue.shift();
    if (piece !== undefined) {
      controller.enqueue(piece);
      this.#channel.post({ t: "stream", k: "credit", s: this.#id, bytes: piece.byteLength });
      this.#arm();
      if (this.#queue.length === 0) {
        if (this.#failure !== undefined) this.#fail(this.#failure, false);
        else if (this.#ended) this.#close();
      }
      return;
    }
    if (this.#ended) {
      this.#close();
      return;
    }
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
    }).then(() => this.#pull(controller));
  }

  #wakeUp(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #close(): void {
    if (this.#done) return;
    try {
      this.#controller?.close();
    } catch {
      // The reader cancelled the stream already, which ended it at this end too.
    }
    this.#finish(undefined);
  }

  #cancelledByReader(reason: unknown): void {
    if (this.#done) return;
    // A reader in the rack may cancel with a code of its own; any other reason is a cancel.
    const error =
      reason instanceof RackError
        ? reason
        : new RackError(
            "RACK_CANCELLED",
            `${this.#options.where}: the reader cancelled the stream`,
          );
    this.#channel.post({ t: "stream", k: "cancel", s: this.#id, error: toWireError(error) });
    this.#queue = [];
    this.#finish(error);
    this.#wakeUp();
  }

  #fail(error: RackError, notify: boolean): void {
    if (this.#done) return;
    if (notify) {
      this.#channel.post({ t: "stream", k: "cancel", s: this.#id, error: toWireError(error) });
    }
    this.#controller?.error(error);
    this.#queue = [];
    this.#finish(error);
    this.#wakeUp();
  }

  #arm(): void {
    clearTimeout(this.#timer);
    const { idle, where } = this.#options;
    this.#timer = armTimer(idle, () => {
      const error = new RackError(
        "RACK_TIMEOUT",
        `${where}: the stream moved nothing for ${idle} ms`,
      );
      this.#fail(error, true);
    });
  }

  #finish(error: RackError | undefined): void {
    this.#done = true;
    clearTimeout(this.#timer);
    this.#channel.forgetReceiver(this.#id);
    countEnd(this.#options.counters, error);
    this.#options.onEnd(error);
  }
}

/** The streams of one end of a channel, in both directions. */
export class StreamChannel {
  readonly #post: (message: StreamMessage, transfer?: ArrayBuffer[]) => void;
  /** Streams this end sends, by the id it chose. */
  readonly #senders = new Map<number, StreamSender>();
  /** Streams the other end sends, by the id it chose. */
  readonly #receivers = new Map<number, StreamReceiver>();
  #nextId = 1;

  /** @param post Posts a message on the channel, moving the buffers in `transfer`. */
  constructor(post: (message: StreamMessage, transfer?: ArrayBuffer[]) => void) {
    this.#post = post;
  }

  /** Streams open at this end, in both directions. */
  get open(): number {
    return this.#senders.size + this.#receivers.size;
  }

  /**
   * Sends a stream on the channel. It waits for credit, which the receiving end grants once the
   * call or the result that names the stream reaches it.
   *
   * @returns The stream's id, for the call or the result that carries it.
   */
  attach(sender: StreamSender): number {
    const id = this.#nextId++;
    this.#senders.set(id, sender);
    sender.bind(this, id);
    return id;
  }

  /** Opens the receiving end of the stream that the other end sends with `id`. */
  receive(id: number, options: StreamOptions): StreamReceiver {
    const receiver = new StreamReceiver(this, id, options);
    if (!receiver.done) this.#receivers.set(id, receiver);
    return receiver;
  }

  /** Refuses a stream that the other end sends, for a call that nobody waits for any more. */
  refuse(id: number, error: RackError): void {
    this.post({ t: "stream", k: "cancel", s: id, error: toWireError(error) });
  }

  /** Handles a stream message from the other end; messages of ended streams are dropped. */
  onMessage(message: StreamMessage): void {
    switch (message.k) {
      case "chunk":
        this.#receivers.get(message.s)?.chunk(message.data);
        return;
      case "end":
        this.#receivers.get(message.s)?.end();
        return;
      case "error":
        this.#receivers.get(message.s)?.failed(message.error);
        return;
      case "credit":
        this.#senders.get(message.s)?.credit(message.bytes);
        return;
      case "cancel":
        this.#senders.get(message.s)?.cancelled(message.error);
        return;
    }
  }

  /** The channel is gone: every stream on it fails with `error`, and no message goes out. */
  close(error: RackError): void {
    for (const sender of [...this.#senders.values()]) sender.lost(error);
    for (const receiver of [...this.#receivers.values()]) receiver.lost(error);
  }

  /** Posts a message of one of the channel's streams. */
  post(message: StreamMessage, transfer?: ArrayBuffer[]): void {
    try {
      this.#post(message, transfer);
    } catch {
      // The port is closed: the other end is gone, and the channel's close ends its streams.
    }
  }

  /** Called by a sending end once it has ended. */
  forgetSender(id: number): void {
    this.#senders.delete(id);
  }

  /** Called by a receiving end once it has ended. */
  forgetReceiver(id: number): void {
    this.#receivers.delete(id);
  }
}
