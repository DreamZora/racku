/**
 * Entry point of `rack42u`: connectors, devices, rack manifests, and the rack runtime.
 *
 * @decision .agents/decisions/261115_232410-p0-scope-and-toolchain-bun-1-4-4.md#repository-layout
 * @decision .agents/decisions/261112_043034-device-api.md
 */
export {
  type Connector,
  type ConnectorInfo,
  connector,
  type EventInput,
  type EventPayload,
  type EventSpec,
  event,
  type MemberSpec,
  type Members,
  type RpcInput,
  type RpcOutput,
  type RpcParsedInput,
  type RpcReturn,
  type RpcSpec,
  rpc,
} from "./connector.ts";
export {
  type ActivateScope,
  type CallContext,
  type CallOptions,
  type ConfigOf,
  type DeviceContext,
  type DeviceDefinition,
  type DeviceLog,
  type DeviceSpec,
  device,
  type LogLevel,
  type NoPorts,
  type PortClient,
  type PortEmitter,
  type PortEvents,
  type PortImpl,
  type PortImpls,
  type Ports,
} from "./device.ts";
export {
  isRackError,
  RackError,
  type RackErrorCode,
  type WireError,
} from "./errors.ts";
export { type FetchHandler, Http, httpHandler } from "./http.ts";
export type { LogEntry, Logger } from "./log.ts";
export {
  type HttpPanelSpec,
  type PanelSpec,
  type RackManifest,
  type RackSpec,
  rack,
  type SlotOptions,
  type SlotSpec,
  slot,
} from "./manifest.ts";
export type {
  CalledRpcMetrics,
  DeviceMetrics,
  EmittedEventMetrics,
  NeedMetrics,
  PortMetrics,
  RackMetrics,
  ReceivedEventMetrics,
  ServedRpcMetrics,
} from "./metrics.ts";
export {
  type RackEvent,
  type RackHandle,
  type ReloadResult,
  type SlotState,
  type SlotStatus,
  type StartOptions,
  type SwapAction,
  start,
} from "./rack.ts";
export type { StandardSchemaV1 } from "./schema.ts";
