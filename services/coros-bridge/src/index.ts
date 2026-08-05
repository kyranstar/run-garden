export {
  COROS_BRIDGE_CAPABILITIES,
  COROS_HOSTS,
  CorosApiError,
  CorosClient,
  type CorosClientOptions,
  type CorosDashboardSubset,
  type CorosDayDetail,
  type CorosErrorCategory,
  type CorosRegion,
  type CorosWriteResponse,
} from "./coros-client.js";
export {
  executeMoveJob,
  executeStudioJob,
  type MoveJob,
  type MoveJobResult,
  type StudioExecutors,
  type StudioJob,
  type StudioJobOptions,
} from "./write-executor.js";
export {
  buildStrengthProgram,
  createWorkout,
  deleteWorkout,
  type CreateFailureReason,
  type CreateResult,
  type CreateWorkoutOptions,
  type CreateWorkoutSpec,
  type DeleteRefusal,
  type DeleteResult,
  type DeleteWorkoutOptions,
  type DeleteWorkoutTarget,
} from "./create-executor.js";
export {
  buildActivityBackfill,
  type ActivityBackfillChunk,
  type BackfillOptions,
} from "./backfill.js";
export {
  buildSnapshot,
  COROS_LOCALE_URL,
  loadNameResolver,
  type BridgeSnapshot,
  type NormalizedLap,
} from "./snapshot.js";
export {
  createBridgeState,
  handleLine,
  handleRequest,
  type BridgeResponse,
  type BridgeState,
} from "./protocol.js";
export {
  CloudSync,
  generateDeviceKeypair,
  publicKeyRawFromPrivate,
  type CloudSyncOptions,
} from "./cloud-sync.js";
