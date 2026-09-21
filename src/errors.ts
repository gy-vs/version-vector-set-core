/**
 * Strongly typed validation error so callers can branch on `code` rather than
 * parsing message text. Every malformed input path in the library raises one.
 */
export type VVErrorCode =
  | 'BAD_REPLICA_ID'
  | 'BAD_COUNTER'
  | 'COUNTER_OUT_OF_BOUNDS'
  | 'COUNTER_UNSAFE'
  | 'RANGE_REVERSED'
  | 'RANGE_OVERLAPS_PREFIX'
  | 'RANGE_NOT_NORMALIZED'
  | 'BAD_WIRE_FORMAT'
  | 'BAD_CURSOR'
  | 'BUDGET_TOO_SMALL';

export class VersionVectorError extends TypeError {
  readonly code: VVErrorCode;

  constructor(code: VVErrorCode, message: string) {
    super(message);
    this.name = 'VersionVectorError';
    this.code = code;
  }
}

export function fail(code: VVErrorCode, message: string): never {
  throw new VersionVectorError(code, message);
}
