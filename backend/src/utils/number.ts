/** A JSON value that is a usable number, or undefined for anything else (null, NaN, a string). */
export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
