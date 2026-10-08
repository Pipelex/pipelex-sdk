/**
 * How the command names a method and a pipe: the forms of `--method`, the qualified form of
 * `--pipe`, and the names and quoting `script` derives from them.
 */

import { parseMethodSelector, RequestArgumentError } from "../index.js";
import { usageError } from "./io.js";

/** The prefix of a published method's address. */
export const ADDRESS_PREFIX = "github.com/";
/** The prefix of a stored method's catalog id. */
export const CATALOG_ID_PREFIX = "mt_";

/** A `--method` value, told apart by its shape alone. */
export type MethodSelector =
  | { readonly kind: "address"; readonly methodRef: string }
  | { readonly kind: "catalog"; readonly methodId: string }
  | { readonly kind: "path"; readonly path: string };

/** A catalog id without its version suffix: `mt_` and the characters the API's run route accepts. */
const CATALOG_ID_SHAPE = /^mt_[A-Za-z0-9_-]+$/;

/**
 * Tell a `--method` value's form by its shape: `mt_…` is a catalog id, `github.com/…` an address,
 * and anything else a path to a `.mthds` file or a bundle directory. A file or directory that
 * happens to be named `mt_…` is reached as `./mt_…`, so that what a value names never depends on
 * what the current directory holds.
 *
 * A catalog id may carry a version suffix, `mt_…@<n>` for a fixed published version or
 * `mt_…@draft` for the draft; it is kept whole, since the API resolves it.
 *
 * @throws {CommandError} A usage error for an `mt_…` value whose id holds a character no catalog
 *   id holds (a letter, a digit, `_` or `-`), such as `mt_review.mthds`, which is a path written
 *   without its `./`; and for a version suffix the selector grammar refuses, with the grammar's
 *   own reason — a suffix that is neither a positive number without a leading zero nor `draft`,
 *   or a number too large to address exactly. Both name the `./` form too, since an `mt_…`
 *   value such as `mt_review@v2.mthds` may be a path written without it.
 */
export function classifyMethod(value: string): MethodSelector {
  if (value.startsWith(CATALOG_ID_PREFIX)) {
    const at = value.indexOf("@");
    const bareId = at < 0 ? value : value.slice(0, at);
    const pathHint = `To name a local file or directory whose name starts with mt_, write it as ./${value}.`;
    if (!CATALOG_ID_SHAPE.test(bareId)) {
      throw usageError(
        `--method "${value}" is not a catalog id: a catalog id holds only letters, digits, _ and -.`,
        [pathHint],
      );
    }
    // The id is well formed, so the selector grammar refuses the suffix alone, and its message
    // says which way: a suffix of no known form, or a number too large to address exactly.
    try {
      parseMethodSelector(value);
    } catch (error) {
      if (!(error instanceof RequestArgumentError)) throw error;
      throw usageError(`--method ${error.message}`, [
        `Pass ${bareId} for its latest published version, or ${bareId}@draft for its draft.`,
        pathHint,
      ]);
    }
    return { kind: "catalog", methodId: value };
  }
  if (value.startsWith(ADDRESS_PREFIX)) return { kind: "address", methodRef: value };
  return { kind: "path", path: value };
}

/**
 * Hold `--pipe` to the qualified ref, `domain.pipe_code`, which the input preparation and the
 * pipe I/O route require. A bare code is refused, and so is an `alias->domain.pipe_code` ref,
 * which names a dependency package's pipe rather than one of the method's own.
 */
export function checkPipeRef(value: string): void {
  if (value.includes("->")) {
    throw usageError(
      `--pipe "${value}" names a dependency package's pipe; name one of the method's own pipes as domain.pipe_code.`,
    );
  }
  if (!value.includes(".")) {
    throw usageError(
      `--pipe takes a pipe's qualified ref, domain.pipe_code, and "${value}" has no domain.`,
      [`Write it as <domain>.${value}, the domain being the one its .mthds file declares.`],
    );
  }
}

/** Whether a value holds a control character, which no line of a written script may carry. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * An address's tag, the text after its last `@`, or `undefined` for an address with none. An
 * empty tag counts as none.
 */
export function addressTag(methodRef: string): string | undefined {
  const at = methodRef.lastIndexOf("@");
  if (at < 0) return undefined;
  const tag = methodRef.slice(at + 1);
  return tag === "" ? undefined : tag;
}

/** An address's last path segment, without its tag: the default name of the script it gets. */
export function addressName(methodRef: string): string {
  const at = methodRef.lastIndexOf("@");
  const base = at < 0 ? methodRef : methodRef.slice(0, at);
  const segments = base.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
}

/**
 * A catalog method's name as a script's file name: decomposed (NFKD), stripped of its combining
 * marks, lowercased, every run of characters outside `a-z` and `0-9` turned into one `-`, and
 * trimmed of `-` at both ends. `Résumé Review (v2)` becomes `resume-review-v2`; a name of no
 * letter or digit becomes the empty string.
 */
export function kebabCase(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Why a script's file name cannot be used, or `undefined` when it can. */
export function scriptNameProblem(name: string): string | undefined {
  if (name === "") return "is empty";
  if (name === "." || name === "..") return `"${name}" names a directory`;
  if (name.includes("/")) return `"${name}" holds a /, and --dir is where the script goes`;
  // On every platform, so both SDKs refuse the same names: Windows reads a \ as a /, and
  // `..\outside` would leave --dir there.
  if (name.includes("\\")) {
    return `"${name}" holds a \\, which Windows reads as a /, and --dir is where the script goes`;
  }
  if (hasControlCharacter(name)) return "holds a control character";
  return undefined;
}

/** A value as one single-quoted shell word, an inner `'` spelled `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
