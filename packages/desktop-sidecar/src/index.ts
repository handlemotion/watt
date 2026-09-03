export {
  CAPABILITIES,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_FRAME_BYTES,
  MAX_IN_FLIGHT_REQUESTS,
  MAX_JSON_DEPTH,
  MAX_OUTBOUND_QUEUE_BYTES,
  MAX_OUTBOUND_QUEUE_MESSAGES,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from "./constants.js";
export { assertPayloadSize, decodePayload, encodeFrame, FrameDecoder } from "./codec.js";
export { serveConnection, SidecarServer, wireError } from "./server.js";
export { ProtocolError } from "./types.js";
export type { Capability } from "./constants.js";
export type {
  ClientEnvelope,
  ErrorEnvelope,
  HelloAckEnvelope,
  HelloEnvelope,
  HostMethod,
  HostMethodMap,
  HostStartupOptions,
  RequestEnvelope,
  ResultEnvelope,
  RunEventEnvelope,
  ServerEnvelope,
  StreamEndEnvelope,
  StreamEndReason,
  WireError,
} from "./types.js";
export { assertClientEnvelope, assertServerEnvelope, protocolSchema } from "./validate.js";
export { BoundedWriter } from "./writer.js";
