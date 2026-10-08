/**
 * Method selectors: a stored method's catalog id with an optional version suffix.
 *
 * A bare `mt_…` names the method's latest published version, `mt_…@<n>` the fixed version
 * `n`, and `mt_…@draft` its draft. The run routes and the tooling routes take a selector as
 * their `method_id`, and the platform resolves it. The method routes (`getMethod`,
 * `writeDraft`, `renameMethod`, `publishMethod`, the version reads) take the bare id and
 * address the method itself, so a caller holding a selector strips it here first.
 *
 * The grammar is the hosted platform's, case-sensitive:
 *
 * ```
 * selector  = method-id [ "@" ( version / "draft" ) ]
 * method-id = "mt_" 1*( ALPHA / DIGIT / "_" / "-" )
 * version   = %x31-39 *DIGIT   ; a positive decimal integer without a leading zero
 * ```
 */

import { RequestArgumentError } from "./errors.js";

/** A catalog id, which never contains an `@`. */
const METHOD_ID_PATTERN = /^mt_[A-Za-z0-9_-]+$/;

/** A version number: a positive decimal integer without a leading zero. */
const VERSION_PATTERN = /^[1-9][0-9]*$/;

/** The suffix that names a method's draft, in lower case only. */
const DRAFT_SUFFIX = "draft";

/** A method selector split into the bare id and the version it names. */
export interface ParsedMethodSelector {
  /** The bare catalog id — what the method routes and the run history take. */
  method_id: string;
  /**
   * The version the suffix names: its number for `mt_…@<n>`, `"draft"` for `mt_…@draft`, and
   * `null` for a bare id, which names the latest published version.
   */
  version: number | "draft" | null;
}

/**
 * Split a method selector into its bare catalog id and the version it names.
 *
 * `parseMethodSelector("mt_abc")` is `{ method_id: "mt_abc", version: null }`,
 * `parseMethodSelector("mt_abc@3")` is `{ method_id: "mt_abc", version: 3 }` and
 * `parseMethodSelector("mt_abc@draft")` is `{ method_id: "mt_abc", version: "draft" }`.
 * Nothing is sent: it is the local half of what the platform does at its edge.
 *
 * @throws {RequestArgumentError} When the value is not a selector: an id that is not `mt_`
 *   followed by letters, digits, `_` or `-`, or a suffix the platform refuses with a `422` — an
 *   empty one, `@0`, a number with a leading zero or a sign, any word but `draft`, `draft` in
 *   another case, or two suffixes. Also for a number too large to address exactly, since
 *   reading it would name another version than the one written.
 */
export function parseMethodSelector(selector: string): ParsedMethodSelector {
  if (typeof selector !== "string") {
    throw new RequestArgumentError("parseMethodSelector() takes a method selector string (mt_…).");
  }
  const at = selector.indexOf("@");
  const methodId = at < 0 ? selector : selector.slice(0, at);
  if (!METHOD_ID_PATTERN.test(methodId)) {
    throw new RequestArgumentError(
      `"${selector}" is not a method selector: a catalog id is mt_ followed by letters, digits, _ or -.`,
    );
  }
  if (at < 0) return { method_id: methodId, version: null };

  const suffix = selector.slice(at + 1);
  if (suffix === DRAFT_SUFFIX) return { method_id: methodId, version: "draft" };
  if (!VERSION_PATTERN.test(suffix)) {
    throw new RequestArgumentError(
      `"${selector}" names no version: the suffix of a catalog id is @<version>, a positive ` +
        "number without a leading zero, or @draft.",
    );
  }
  const version = Number(suffix);
  if (!Number.isSafeInteger(version)) {
    throw new RequestArgumentError(
      `"${selector}" names a version number too large to address exactly.`,
    );
  }
  return { method_id: methodId, version };
}
