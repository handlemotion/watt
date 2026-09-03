import type { HostEvent, RunResult } from "@watt/host";
import {
  ProtocolError,
  type HostMethod,
  type HostMethodMap,
  type HostStartupOptions,
  type WireError,
} from "@watt/host-protocol";

import type { Capability } from "./constants.js";

export { ProtocolError };
export type { HostMethod, HostMethodMap, HostStartupOptions, WireError };

export type HelloEnvelope = {
  type: "hello";
  protocolVersionMin: number;
  protocolVersionMax: number;
  capabilities: Capability[];
  host: HostStartupOptions;
};

export type RequestEnvelope<M extends HostMethod = HostMethod> = {
  type: "request";
  version: 1;
  requestId: string;
  method: M;
  params: HostMethodMap[M]["params"];
};

export type ClientEnvelope = HelloEnvelope | RequestEnvelope;
export type HelloAckEnvelope = {
  type: "hello_ack";
  version: 1;
  capabilities: Capability[];
};
export type ResultEnvelope = {
  type: "result";
  version: 1;
  requestId: string;
  result: unknown;
};
export type ErrorEnvelope = {
  type: "error";
  version: 1;
  requestId?: string;
  fatal: boolean;
  error: WireError;
  supportedVersions?: number[];
  capabilities?: Capability[];
};
export type RunEventEnvelope = {
  type: "run_event";
  version: 1;
  subscriptionId: string;
  runId: string;
  event: HostEvent;
};
export type StreamEndReason =
  | RunResult["status"]
  | "unsubscribed"
  | "shutdown"
  | "consumer_too_slow"
  | "protocol_error"
  | "sidecar_disconnected";
export type StreamEndEnvelope = {
  type: "stream_end";
  version: 1;
  subscriptionId: string;
  runId: string;
  reason: StreamEndReason;
  result?: RunResult;
  error?: WireError;
};
export type ServerEnvelope =
  | HelloAckEnvelope
  | ResultEnvelope
  | ErrorEnvelope
  | RunEventEnvelope
  | StreamEndEnvelope;
