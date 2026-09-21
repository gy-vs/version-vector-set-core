export { ReplicaId } from './replicaId.js';
export { VersionVectorError, type VVErrorCode } from './errors.js';
export {
  VersionVectorSet,
  MAX_COUNTER,
  normalizeCounter,
  type CounterInput,
  type VectorEntry,
  type VectorEntryWire,
} from './versionVectorSet.js';
export {
  nextMissingRequest,
  allMissingRequestPages,
  byteSize,
  type MissingRequest,
} from './missingRequest.js';
export type { Seg, SegState } from './intervals.js';
