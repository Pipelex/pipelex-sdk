/**
 * A method's showcases: a completed run of a method, frozen, so that people can see what the method
 * really produces without spending credit. A builder freezes a run (`freezeMethodShowcase`,
 * `POST /v1/methods/{id}/showcases`) and withdraws it (`withdrawMethodShowcase`); every reader of a
 * published version reads the showcases of the tree that version holds
 * (`listMethodVersionShowcases`, `getMethodVersionShowcase`), and the method's own organization
 * reads every showcase across every tree (`listMethodShowcases`, `getMethodShowcase`).
 *
 * A showcase holds real output, unlike a layout's written sample, which is invented, and unlike an
 * example, which is the builder's private test bench whose output is whatever its latest run left.
 * It is keyed by the digest of the method tree of its run, so a run's own content stands behind
 * what is shown. The frozen document names its stored files by `pipelex-storage://` address and
 * holds no signed link; the one place a link appears is a detail read's `files`, signed for that
 * one read over that showcase's own files.
 *
 * The readers here hold a list entry by entry, as `method-layouts.ts` does, so one showcase the SDK
 * cannot read never costs a page the others, and hold a detail and a freeze verdict whole, since
 * the caller acts on what they name.
 */

import type { InputForm, OutputForm, PipeIOContracts } from "mthds/protocol";

import { isPlainObject } from "./records.js";

/**
 * One showcase of a list: what names it and what it was frozen from. The same for every reader,
 * whoever holds the method.
 */
export interface MethodShowcaseSummary {
  /** The showcase's id, `sc_` and a time-ordered uuid, so a list reads oldest first. */
  showcase_id: string;
  /** The showcase's name, for a person reading a list. */
  name: string;
  /** The namespaced pipe the run ran, `domain_path.pipe_code`. */
  pipe_ref: string;
  /**
   * The digest of the method tree of the run the showcase was frozen from: `sha256:` and 64
   * lowercase hexadecimal characters, as a published version's `tree_digest` states it.
   */
  tree_digest: string;
  /** The moment of the freeze, ISO 8601 in UTC. */
  frozen_at: string;
}

/** One stored file of a showcase on a detail read, with a link signed for that read. */
export interface MethodShowcaseFile {
  /** The file's `pipelex-storage://` address, as the document names it. */
  address: string;
  /** The file's name inside the showcase, which is its content's hash and its extension. */
  file_name: string;
  /** The file's media type, one `type/subtype`. */
  media_type: string;
  /** The file's size in bytes. */
  size_bytes: number;
  /**
   * A short-lived presigned `GET` of the file's bytes. It is a bearer credential: it needs no API
   * key, and anyone holding it can read the file until it expires, so it is never logged and
   * belongs on a server rather than in a browser.
   */
  url: string;
}

/**
 * What a showcase shows, frozen from its run and relayed as it was stored, its addresses rewritten
 * to the showcase's own files. A renderer of an HTML output replaces each address with the `url` of
 * the matching entry of `MethodShowcaseDetail.files`.
 */
export interface MethodShowcaseDocument {
  /** The inputs the run was started with, an integer past the safe range read as a `bigint`. */
  inputs: Record<string, unknown>;
  /** The run's main output. */
  main_stuff: unknown;
  /** The input-form descriptors of the library the run executed against, keyed by `pipe_ref`. */
  input_form: InputForm | null;
  /** The output-form descriptors of that library, keyed by `pipe_ref`. */
  output_form: OutputForm | null;
  /** The per-pipe input and output contracts of that library, keyed by `pipe_ref`. */
  pipe_io_contracts: PipeIOContracts | null;
}

/** One showcase in full: its summary, the frozen document and its files, each with a link. */
export interface MethodShowcaseDetail extends MethodShowcaseSummary {
  /** The frozen inputs and output, and what describes them. */
  document: MethodShowcaseDocument;
  /** Every stored file the document names, each with a link signed for this read. */
  files: MethodShowcaseFile[];
}

/**
 * A list of showcases, oldest first, empty when none is frozen — what `listMethodShowcases` and
 * `listMethodVersionShowcases` answer.
 */
export interface MethodShowcaseList {
  items: MethodShowcaseSummary[];
}

/** The freeze — `freezeMethodShowcase`. Its wire body is closed: these members and nothing else. */
export interface MethodShowcaseInput {
  /** The `pipeline_run_id` of the completed run of this method to freeze. */
  run_id: string;
  /** The showcase's name, 1 to 200 characters and not blank. */
  name: string;
}

/** What a freeze did — the discriminant of `MethodShowcaseFreezeResult`. */
export type MethodShowcaseFreezeOutcome = "frozen" | "unchanged" | "refused";

/**
 * Why a freeze was refused:
 *
 * - `run_not_usable`: the run is not this method's in this organization, did not complete, kept no
 *   results (a blocking execute stores none), stored no output or forms, does not say which pipe
 *   it ran, or kept no record of inputs its pipe declares;
 * - `tree_not_current`: the run's tree is neither the draft's nor the latest published version's,
 *   or the run records none;
 * - `file_not_readable`: the document names a file that is gone or outside the organization, or
 *   holds a signed link the freeze could not rewrite;
 * - `too_large`: a stored artifact of the run, the document, the number of files or their total
 *   size is past what one showcase holds;
 * - `too_many`: the tree already holds as many showcases as one tree keeps.
 */
export type MethodShowcaseRefusalReason =
  "run_not_usable" | "tree_not_current" | "file_not_readable" | "too_large" | "too_many";

/** The run was frozen: `showcase` names the new showcase. */
export interface MethodShowcaseFrozen {
  outcome: "frozen";
  showcase: MethodShowcaseSummary;
}

/**
 * This run is already a showcase, whatever has happened to its tree since: `showcase` names the one
 * that stands, nothing was written and the name in the request was ignored.
 */
export interface MethodShowcaseUnchanged {
  outcome: "unchanged";
  showcase: MethodShowcaseSummary;
}

/** The run cannot be frozen, and nothing was written. */
export interface MethodShowcaseRefused {
  outcome: "refused";
  /**
   * Why: a `MethodShowcaseRefusalReason`, or the raw string of one this SDK does not know, which a
   * later platform may add. A refusal is a verdict whatever its reason, so show its `message` when
   * the reason is one you do not handle.
   */
  reason: MethodShowcaseRefusalReason | (string & {});
  /** What was refused and what to do, for a person. */
  message: string;
}

/**
 * The answer of `freezeMethodShowcase`, a `200` discriminated on `outcome`, because a run that
 * cannot be frozen is a verdict about the run and not a failure of the request. Branch on
 * `outcome`, never on the status.
 */
export type MethodShowcaseFreezeResult =
  MethodShowcaseFrozen | MethodShowcaseUnchanged | MethodShowcaseRefused;

/** The members of a showcase summary, in the order a fault names the first one missing. */
const SHOWCASE_SUMMARY_STRING_MEMBERS = [
  "showcase_id",
  "name",
  "pipe_ref",
  "tree_digest",
  "frozen_at",
] as const;

/** The members of a showcase's document that must be stated, `null` being a statement. */
const SHOWCASE_DOCUMENT_STATED_MEMBERS = [
  "main_stuff",
  "input_form",
  "output_form",
  "pipe_io_contracts",
] as const;

/** The members of a showcase's file read as strings. */
const SHOWCASE_FILE_STRING_MEMBERS = ["address", "file_name", "media_type", "url"] as const;

/**
 * What keeps `value` from reading as a showcase summary, as the end of a sentence naming it ("a
 * showcase whose `name` is not a string"), or `null` when it reads as one.
 */
export function methodShowcaseSummaryFault(value: unknown): string | null {
  if (!isPlainObject(value)) return "that is not an object";
  for (const member of SHOWCASE_SUMMARY_STRING_MEMBERS) {
    if (typeof value[member] !== "string") return `whose \`${member}\` is not a string`;
  }
  return null;
}

/**
 * A list of showcases read entry by entry, `listMethodShowcases`'s or
 * `listMethodVersionShowcases`'s `items`: each entry that reads as a summary
 * (`methodShowcaseSummaryFault`), in the answer's order, oldest first as the platform sends them,
 * and anything else left out. A value that is not an array reads as no showcase.
 */
export function readMethodShowcaseSummaries(value: unknown): MethodShowcaseSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: MethodShowcaseSummary[] = [];
  for (const entry of value as unknown[]) {
    if (methodShowcaseSummaryFault(entry) === null) {
      summaries.push(entry as MethodShowcaseSummary);
    }
  }
  return summaries;
}

/** What keeps `file` from reading as one file of a detail, or `null` when it reads as one. */
function showcaseFileFault(file: unknown): string | null {
  if (!isPlainObject(file)) return "that is not an object";
  for (const member of SHOWCASE_FILE_STRING_MEMBERS) {
    if (typeof file[member] !== "string") return `whose \`${member}\` is not a string`;
  }
  const size = file.size_bytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return "whose `size_bytes` is not a non-negative integer";
  }
  return null;
}

/**
 * What keeps `value` from reading as a showcase detail, as the end of a sentence naming it, or
 * `null` when it reads as one: a summary whose `document` is an object holding an object `inputs`
 * and stating each of its other members, `null` included, and whose `files` is an array of complete
 * entries. Unlike a list of showcases, whose entries
 * stand apart, a detail is held whole: a renderer resolves each address the document names through
 * `files`, so a file it cannot read would leave a result drawn with a hole in it.
 */
export function methodShowcaseDetailFault(value: unknown): string | null {
  const summaryFault = methodShowcaseSummaryFault(value);
  if (summaryFault !== null) return summaryFault;
  const detail = value as Record<string, unknown>;
  const frozen = detail.document;
  const files = detail.files;
  if (!isPlainObject(frozen)) return "whose `document` is not an object";
  if (!isPlainObject(frozen.inputs)) return "whose `document.inputs` is not an object";
  for (const member of SHOWCASE_DOCUMENT_STATED_MEMBERS) {
    if (frozen[member] === undefined) return `whose \`document.${member}\` is left out`;
  }
  if (!Array.isArray(files)) return "whose `files` is not an array";
  for (let index = 0; index < files.length; index += 1) {
    const fault = showcaseFileFault(files[index]);
    if (fault !== null) return `whose \`files\` holds an entry ${fault}, at [${index}]`;
  }
  return null;
}

/**
 * What keeps `answer` from reading as a freeze's verdict, as the words naming it, or `null` when it
 * reads as one: an `outcome` of `frozen` or `unchanged` with a `showcase` that reads as a summary,
 * or `refused` with a string `reason` and `message`.
 */
export function methodShowcaseFreezeFault(answer: Record<string, unknown>): string | null {
  switch (answer.outcome) {
    case "frozen":
    case "unchanged": {
      const fault = methodShowcaseSummaryFault(answer.showcase);
      if (fault === null) return null;
      return `a \`${answer.outcome}\` freeze result whose \`showcase\` is one ${fault}`;
    }
    case "refused":
      for (const member of ["reason", "message"] as const) {
        if (typeof answer[member] !== "string") {
          return `a \`refused\` freeze result whose \`${member}\` is not a string`;
        }
      }
      return null;
    default:
      return "a freeze result whose `outcome` is not `frozen`, `unchanged` or `refused`";
  }
}
