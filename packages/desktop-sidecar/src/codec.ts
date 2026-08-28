import { TextDecoder } from "node:util";

import {
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  MAX_PAYLOAD_BYTES,
} from "./constants.js";
import { ProtocolError } from "./types.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function assertJsonDepth(json: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) {
        throw new ProtocolError(
          `JSON nesting exceeds ${MAX_JSON_DEPTH}`,
          "json_too_deep",
          { fatal: true },
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) {
        throw new ProtocolError("malformed JSON nesting", "malformed_json", {
          fatal: true,
        });
      }
    }
  }
}

export function payloadBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ProtocolError(
      "payload is not JSON serializable",
      "invalid_payload",
    );
  }
  return Buffer.byteLength(encoded);
}

export function assertPayloadSize(value: unknown): void {
  if (payloadBytes(value) > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError(
      `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      "payload_too_large",
    );
  }
}

export function encodeFrame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new ProtocolError(
      "frame is not JSON serializable",
      "invalid_payload",
    );
  }
  assertJsonDepth(json);
  const payload = Buffer.from(json, "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `frame exceeds ${MAX_FRAME_BYTES} bytes`,
      "frame_too_large",
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodePayload(payload: Buffer): unknown {
  if (payload.length === 0) {
    throw new ProtocolError("empty frame", "malformed_frame", { fatal: true });
  }
  if (payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      `frame exceeds ${MAX_FRAME_BYTES} bytes`,
      "frame_too_large",
      { fatal: true },
    );
  }
  let json: string;
  try {
    json = utf8.decode(payload);
  } catch (cause) {
    throw new ProtocolError("frame is not valid UTF-8", "invalid_utf8", {
      fatal: true,
      cause,
    });
  }
  assertJsonDepth(json);
  try {
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new ProtocolError("frame is not valid JSON", "malformed_json", {
      fatal: true,
      cause,
    });
  }
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    for (;;) {
      if (this.#buffer.length < 4) return values;
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) {
        throw new ProtocolError("empty frame", "malformed_frame", {
          fatal: true,
        });
      }
      if (length > MAX_FRAME_BYTES) {
        throw new ProtocolError(
          `frame exceeds ${MAX_FRAME_BYTES} bytes`,
          "frame_too_large",
          { fatal: true },
        );
      }
      if (this.#buffer.length < length + 4) return values;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      values.push(decodePayload(payload));
    }
  }

  finish(): void {
    if (this.#buffer.length > 0) {
      throw new ProtocolError("truncated frame", "malformed_frame", {
        fatal: true,
      });
    }
  }
}
