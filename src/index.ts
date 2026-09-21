export {
  VersionVectorError,
  MAX_COUNTER,
  MAX_ID_BYTES,
  compareBytes,
  parseCounter,
  parseHexId,
  toHex,
  validateCounter,
  validateId,
} from "./errors.js";
export type { VectorErrorCode } from "./errors.js";
export { VersionVector, subtractIntervals } from "./vector.js";
export type {
  Segment,
  VectorEntry,
  EncodedVector,
  EncodedEntry,
  EncodedRange,
} from "./vector.js";
export { VectorDiff } from "./diff.js";
export type { MissingRequest, DiffEntry } from "./diff.js";
