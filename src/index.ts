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
  stream,
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
  type Every,
  type EveryEvents,
  every,
  isEvery,
  isOwn,
  isPatched,
  type LogLevel,
  type Need,
  type NeedConnector,
  type Needs,
  type NoPorts,
  type Own,
  own,
  type Patched,
  type PortClient,
  type PortEmitter,
  type PortEvents,
  type PortImpl,
  type PortImpls,
  type PortSet,
  type Ports,
  patched,
  type ReachedDevice,
  type Watchdog,
} from "./device.ts";
export {
  isRackError,
  RackError,
  type RackErrorCode,
  type WireError,
} from "./errors.ts";
export type { ListenerState, WatchdogStatus } from "./instance.ts";
export {
  fileResponse,
  type Listener,
  type ListenerHandler,
  type ListenerHandlers,
  type ListenerMethod,
  type ListenerRoute,
  type ListenerRouteHandler,
  type ListenerTls,
  type ListenerWebSocket,
  type ServeOptions,
  wholeResponse,
} from "./listeners.ts";
export type { LogEntry, Logger } from "./log.ts";
export {
  type PlacedRackSpec,
  type RackManifest,
  type RackSpec,
  rack,
  type ScannedRackSpec,
  type ScanSpec,
  type SlotOptions,
  type SlotSpec,
  slot,
} from "./manifest.ts";
export type {
  CalledRpcMetrics,
  DeviceMetrics,
  EmittedEventMetrics,
  LoopMetrics,
  NeedMetrics,
  OutsideMetrics,
  PortMetrics,
  RackMetrics,
  ReceivedEventMetrics,
  ServedRpcMetrics,
  StreamMetrics,
} from "./metrics.ts";
export type { CertificateInfo } from "./protocol.ts";
export {
  type RackEvent,
  type RackHandle,
  type ReloadMode,
  type ReloadResult,
  type RestartOptions,
  type RollbackOptions,
  type SlotState,
  type SlotStatus,
  type StartOptions,
  type StuckThread,
  type SwapAction,
  start,
  type UpdateCause,
  type UpdateRecord,
} from "./rack.ts";
export type { StandardSchemaV1 } from "./schema.ts";
