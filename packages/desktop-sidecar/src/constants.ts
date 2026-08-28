export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 768 * 1024;
export const MAX_JSON_DEPTH = 64;
export const MAX_IN_FLIGHT_REQUESTS = 64;
export const MAX_ACTIVE_SUBSCRIPTIONS = 64;
export const MAX_OUTBOUND_QUEUE_MESSAGES = 256;
export const MAX_OUTBOUND_QUEUE_BYTES = 8 * 1024 * 1024;

export const CAPABILITIES = [
  "host.projects.v1",
  "host.workspaces.v1",
  "host.sessions.v1",
  "host.runs.v1",
  "run-stream.v1",
  "graceful-shutdown.v1",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
