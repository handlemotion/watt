import { once } from "node:events";
import type { Writable } from "node:stream";

import { MAX_OUTBOUND_QUEUE_BYTES, MAX_OUTBOUND_QUEUE_MESSAGES } from "./constants.js";
import { encodeFrame } from "./codec.js";
import { ProtocolError } from "./types.js";

type QueueItem = {
  frame: Buffer;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class BoundedWriter {
  readonly #stream: Writable;
  readonly #queue: QueueItem[] = [];
  readonly #capacityWaiters = new Set<() => void>();
  #running = false;
  #queuedBytes = 0;
  #failure: unknown;
  #closed = false;

  constructor(stream: Writable) {
    this.#stream = stream;
    stream.once("error", (error) => this.#fail(error));
    stream.once("close", () => this.#fail(new Error("output closed")));
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get queuedMessages(): number {
    return this.#queue.length;
  }

  async send(value: unknown): Promise<void> {
    const frame = encodeFrame(value);
    while (
      !this.#failure &&
      !this.#closed &&
      (this.#queue.length >= MAX_OUTBOUND_QUEUE_MESSAGES ||
        this.#queuedBytes + frame.length > MAX_OUTBOUND_QUEUE_BYTES)
    ) {
      await new Promise<void>((resolve) => this.#capacityWaiters.add(resolve));
    }
    if (this.#failure) throw this.#failure;
    if (this.#closed) {
      throw new ProtocolError("output is closed", "sidecar_disconnected");
    }
    await new Promise<void>((resolve, reject) => {
      this.#queue.push({ frame, resolve, reject });
      this.#queuedBytes += frame.length;
      this.#start();
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    while (this.#running || this.#queue.length > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.#stream.destroyed) this.#stream.end();
  }

  #start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        if (this.#failure) throw this.#failure;
        const item = this.#queue[0];
        if (!item) break;
        if (!this.#stream.write(item.frame)) await once(this.#stream, "drain");
        this.#queue.shift();
        this.#queuedBytes -= item.frame.length;
        item.resolve();
        this.#wakeCapacity();
      }
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#running = false;
      if (this.#queue.length > 0 && !this.#failure) this.#start();
    }
  }

  #wakeCapacity(): void {
    for (const resolve of this.#capacityWaiters) resolve();
    this.#capacityWaiters.clear();
  }

  #fail(error: unknown): void {
    if (this.#failure || (this.#closed && this.#queue.length === 0)) return;
    this.#failure = error;
    for (const item of this.#queue.splice(0)) item.reject(error);
    this.#queuedBytes = 0;
    this.#wakeCapacity();
  }
}
