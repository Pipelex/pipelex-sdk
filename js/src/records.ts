/**
 * Small readers of JSON records the SDK checks member by member before handing them back. Internal:
 * nothing here is exported from the package.
 */

/** Whether a value is a plain object: an object that is neither `null` nor an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop each of `fields` from `record` when it is present and fails `fits`. `null` always fits,
 * since every field of the shapes read this way allows it. The run status read's degradation
 * (`readRunDegradation` in `runs.ts`) is checked with it.
 */
export function dropUnfit(
  record: Record<string, unknown>,
  fields: readonly string[],
  fits: (value: unknown) => boolean,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value !== null && !fits(value)) delete record[field];
  }
}
