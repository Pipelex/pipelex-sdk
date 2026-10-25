/**
 * How the SDK reads the problem items a verdict lists: the `errors` of an invalid validate verdict
 * (`PipelexInvalidReport`), of an invalid crate verdict (`CrateInvalidReport`) and of a pipe I/O
 * answer that does not load, and the `warnings` of a valid validate verdict, the runner's verdict
 * a refused publish carries (`MethodPublishRefused.validation`) included. The Python twin,
 * `pipelex-sdk`, reads them the same way in `pipelex_sdk.problem_items`.
 *
 * The items are read tolerantly, member by member, so that one malformed member never costs the
 * caller the fault it belongs to: an entry that is no object, or whose `code` or `detail` is not a
 * string, names no fault and is skipped, and each optional member the standard declares
 * (`params`, `location`, `suggestions`, `suggested_fix`) is kept only when the standard's own
 * check accepts it (`isProblemItem` in `mthds/protocol`), and left out of its item otherwise. A
 * member the standard does not declare is kept as received.
 */

import { isProblemItem } from "mthds/protocol";
import type { ProblemItem } from "mthds/protocol";
import { isPlainObject } from "./records.js";

/** The members of an item the standard declares and checks, beyond `code` and `detail`. */
const CHECKED_MEMBERS = ["params", "location", "suggestions", "suggested_fix"] as const;

/**
 * A code the standard accepts, standing in for an item's own while one of its members is checked
 * alone, so that an item whose code breaks the code pattern still keeps its well-formed members.
 */
const PROBE_CODE = "client.argument_invalid";

/** Whether `value` is well-formed as the item member `name`, by the standard's own check. */
function memberFits(name: (typeof CHECKED_MEMBERS)[number], value: unknown): boolean {
  return isProblemItem({ code: PROBE_CODE, detail: "", [name]: value });
}

/** One entry of a verdict's `errors` or `warnings` read as a problem item, or `undefined` when it names no fault. */
export function readProblemItem(entry: unknown): ProblemItem | undefined {
  if (!isPlainObject(entry) || typeof entry.code !== "string" || typeof entry.detail !== "string") {
    return undefined;
  }
  const item: Record<string, unknown> = { ...entry };
  for (const name of CHECKED_MEMBERS) {
    if (Object.hasOwn(item, name) && !memberFits(name, item[name])) delete item[name];
  }
  return item as ProblemItem;
}

/** A verdict's `errors` or `warnings` read as problem items; anything but an array reads as none. */
export function readProblemItems(entries: unknown): ProblemItem[] {
  if (!Array.isArray(entries)) return [];
  const items: ProblemItem[] = [];
  for (const entry of entries) {
    const item = readProblemItem(entry);
    if (item !== undefined) items.push(item);
  }
  return items;
}
