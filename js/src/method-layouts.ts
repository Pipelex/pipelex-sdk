/**
 * A method's stored layouts: the layout a producer designed for one pipe of a published version,
 * which the hosted platform stores beside the method (`storeMethodLayout`,
 * `POST /v1/methods/{id}/versions/{n}/layouts`), reads back by the version
 * (`listMethodLayouts`, `GET` of the same route) and hands back on the validate of the method by id
 * that names `layouts` among its `views` (`PipelexValidationReport.layouts`).
 *
 * A layout is a data file: a tree of elements written in the vocabulary of a catalog of
 * components, every value bound to a path in the host's form state, carrying no field
 * descriptions and no data of its own. A host renders it over the input-form descriptor the same
 * validate projects, and renders the plain form instead whenever it cannot. The platform stores and
 * carries it and never judges it. The shapes are stated brand-neutrally, as the input-form
 * descriptor they are rendered over is: snake_case members with no `pipelex_` prefix. The storage
 * and the `layouts` token are the hosted plane's.
 *
 * The readers here check a layout member by member, as `readProblemItems` checks a verdict's
 * items: neither a validate nor a read of a version's layouts loses its other layouts, nor a
 * validate its verdict, to one layout it cannot read.
 */

import { isPlainObject } from "./records.js";

/**
 * How a stored layout was made, as its producer stated it when it wrote the layout. Every member
 * is present on a layout the SDK hands back.
 */
export interface LayoutProvenance {
  /** Who produced the layout, a short kebab-case slug such as `pipelex-method`. */
  producer: string;
  /** The id of the model the producer ran, such as `claude-4.8-opus`. */
  model: string;
  /** The creative seed handed to the model with the brief, verbatim; `null` when none was. */
  seed: string | null;
  /**
   * The id of the app style the layout was designed under, such as `editorial`; `null` when it
   * was designed under none. The platform holds it to the shape `^[a-z0-9-]{1,32}$` and never to
   * a list of styles, so a host reads an id it does not know as no style.
   */
  style: string | null;
  /** How many repair rounds the producer ran before the layout validated against its catalog. */
  repair_rounds: number;
}

/**
 * One stored layout — what `storeMethodLayout` answers, an entry of `listMethodLayouts`'s `items`,
 * and an entry of `PipelexValidationReport.layouts`.
 *
 * Its identity is `tree_digest`, `pipe_ref`, `catalog` and `prompt_hash` within one method: it
 * belongs to the content it was designed for, never to a version number, so it is served for
 * whatever selector of that method resolves the same tree, and a write of the same identity
 * replaces it. It names no method and no version.
 */
export interface MethodLayout {
  /**
   * The digest of the method tree the layout was produced against, `sha256:` and 64 lowercase
   * hexadecimal characters: the MTHDS standard's digest of the tree's listing, as a published
   * version's `tree_digest` states it.
   */
  tree_digest: string;
  /**
   * The namespaced pipe reference it lays out, `domain_path.pipe_code`, as the input-form
   * descriptor keys its forms.
   */
  pipe_ref: string;
  /** The id of the catalog whose vocabulary it is written in, a slug such as `composer`. */
  catalog: string;
  /** The hash of the prompt the producer's model read, 12 to 64 lowercase hexadecimal digits. */
  prompt_hash: string;
  /**
   * The layout itself, as the producer's model emitted it: JSON patch lines, one per line,
   * carried as one string exactly as written. The platform never parses it.
   */
  jsonl: string;
  /** How it was made. */
  provenance: LayoutProvenance;
  /** The moment the write that stored it landed, ISO 8601 in UTC: the one member the platform sets. */
  stored_at: string;
  /**
   * A written sample of the result the layout was designed over, as one JSON text the platform
   * stores and never reads, so a host can draw a designed result page before anyone has run the
   * method; `null` when none was stored, and from a platform that predates it. Parse it yourself,
   * and treat it as untrusted: nothing but the JSON syntax was checked.
   */
  sample_json: string | null;
}

/**
 * The layouts stored for a published version's content — what `listMethodLayouts` answers. `items`
 * is newest first, at most 16, and empty when none is stored.
 */
export interface MethodLayoutList {
  items: MethodLayout[];
}

/**
 * The provenance a write states — `MethodLayoutInput.provenance`. A `null` or omitted optional
 * member is not sent, and the platform stores its default: no seed, no style, no repair round.
 */
export interface LayoutProvenanceInput {
  /** Who produced the layout, a slug: 1 to 64 lowercase letters, digits and hyphens, not starting with a hyphen. */
  producer: string;
  /** The id of the model the producer ran: 1 to 128 characters, none of them a control character. */
  model: string;
  /** The creative seed handed to the model with the brief, verbatim, at most 4,000 characters. */
  seed?: string | null;
  /** The id of the app style the layout was designed under, of the shape `^[a-z0-9-]{1,32}$`. */
  style?: string | null;
  /** How many repair rounds the producer ran before the layout validated, from 0 to 100. */
  repair_rounds?: number | null;
}

/**
 * The write — `storeMethodLayout`, `POST /v1/methods/{id}/versions/{n}/layouts`: the stored layout
 * without `stored_at`. The wire body is closed at both levels, so the client sends these members
 * and nothing else; a `MethodLayout` read back can be passed as it is, its `stored_at` left out and
 * its `sample_json` sent when it holds one.
 * The bounds below are the platform's, which refuses a member breaking one with a `422`
 * `request.invalid` naming it, `provenance.<member>` for one of the provenance's.
 */
export interface MethodLayoutInput {
  /**
   * The digest of the tree the layout was produced against, which must be the `tree_digest` of the
   * version the call names (`MethodVersionSummary.tree_digest`): `sha256:` and 64 lowercase
   * hexadecimal characters.
   */
  tree_digest: string;
  /**
   * The pipe it lays out, `domain_path.pipe_code`: two or more dot-separated identifiers, at most
   * 256 characters in all.
   */
  pipe_ref: string;
  /** The catalog's id, a slug of the same shape as `provenance.producer`. */
  catalog: string;
  /** The hash of the prompt the producer's model read, 12 to 64 lowercase hexadecimal digits. */
  prompt_hash: string;
  /**
   * The layout as the producer's model emitted it, not empty, at most 128 KiB of UTF-8, holding
   * no raw control character but the tab, the line feed and the carriage return.
   */
  jsonl: string;
  /** How it was made. */
  provenance: LayoutProvenanceInput;
  /**
   * A written sample of the result the layout was designed over, one JSON text of at most 64 KiB of
   * UTF-8, which the platform refuses if it does not parse. A `null` or omitted sample is not sent,
   * and the write stores none, whatever the layout it replaces held.
   *
   * **Only a written sample belongs here, invented from the description of the result and holding
   * no customer's data, never a run's output.** A layout's readers include the method's runners
   * and, for a public method, other organizations, and the platform never reads the sample, so
   * keeping that rule is the producer's.
   */
  sample_json?: string | null;
}

/**
 * The members the write takes besides `provenance`, `required` ones sent each time and `optional`
 * ones only when given and not `null`. Checked against `MethodLayoutInput` with `satisfies`, so a
 * member the interface gains and this list lacks fails the build rather than being dropped from
 * the body without a word.
 */
export const LAYOUT_INPUT_MEMBERS = {
  tree_digest: "required",
  pipe_ref: "required",
  catalog: "required",
  prompt_hash: "required",
  jsonl: "required",
  sample_json: "optional",
} as const satisfies Record<
  Exclude<keyof MethodLayoutInput, "provenance">,
  "required" | "optional"
>;

/**
 * The members of the write's provenance, `required` ones sent each time and `optional` ones only
 * when given and not `null`, checked against `LayoutProvenanceInput` as `LAYOUT_INPUT_MEMBERS` is.
 */
export const PROVENANCE_INPUT_MEMBERS = {
  producer: "required",
  model: "required",
  seed: "optional",
  style: "optional",
  repair_rounds: "optional",
} as const satisfies Record<keyof LayoutProvenanceInput, "required" | "optional">;

/** The members of a layout read as strings, in the order a fault names the first one missing. */
const LAYOUT_STRING_MEMBERS = [
  "tree_digest",
  "pipe_ref",
  "catalog",
  "prompt_hash",
  "jsonl",
  "stored_at",
] as const;

/** The members of a layout's provenance read as strings. */
const PROVENANCE_STRING_MEMBERS = ["producer", "model"] as const;

/**
 * What keeps `value` from reading as a stored layout, as the end of a sentence naming it ("a
 * layout whose `jsonl` is not a string"), or `null` when it reads as one: an object whose
 * `tree_digest`, `pipe_ref`, `catalog`, `prompt_hash`, `jsonl` and `stored_at` are strings and
 * whose `provenance` is an object with a string `producer` and `model`. The provenance's optional
 * members never keep a layout from reading (`readMethodLayout`).
 */
export function methodLayoutFault(value: unknown): string | null {
  if (!isPlainObject(value)) return "that is not an object";
  for (const member of LAYOUT_STRING_MEMBERS) {
    if (typeof value[member] !== "string") return `whose \`${member}\` is not a string`;
  }
  const provenance = value.provenance;
  if (!isPlainObject(provenance)) return "whose `provenance` is not an object";
  for (const member of PROVENANCE_STRING_MEMBERS) {
    if (typeof provenance[member] !== "string") {
      return `whose \`provenance.${member}\` is not a string`;
    }
  }
  return null;
}

/**
 * `value` read as a stored layout, or `null` when it does not read as one (`methodLayoutFault`).
 * The layout's `sample_json` and the provenance's `seed` and `style` are kept only when each is a
 * string, and read as `null` otherwise, and its `repair_rounds` only when it is a non-negative
 * integer, and read as `0` otherwise: the platform's own defaults, so each member is what
 * `MethodLayout` and `LayoutProvenance` declare. The rest is returned as it came.
 */
export function readMethodLayout(value: unknown): MethodLayout | null {
  if (methodLayoutFault(value) !== null) return null;
  const layout = value as Record<string, unknown> & { provenance: Record<string, unknown> };
  const { seed, style, repair_rounds: rounds } = layout.provenance;
  return {
    ...layout,
    sample_json: typeof layout.sample_json === "string" ? layout.sample_json : null,
    provenance: {
      ...layout.provenance,
      seed: typeof seed === "string" ? seed : null,
      style: typeof style === "string" ? style : null,
      repair_rounds: Number.isSafeInteger(rounds) && (rounds as number) >= 0 ? rounds : 0,
    },
  } as unknown as MethodLayout;
}

/**
 * A list of layouts read entry by entry, a valid report's `layouts` or `listMethodLayouts`'s
 * `items`: each entry that reads as a layout (`readMethodLayout`), in the answer's order, newest
 * first as the platform sends them, and anything else left out. A value that is not an array reads
 * as no layout.
 */
export function readMethodLayouts(value: unknown): MethodLayout[] {
  if (!Array.isArray(value)) return [];
  const layouts: MethodLayout[] = [];
  for (const entry of value as unknown[]) {
    const layout = readMethodLayout(entry);
    if (layout !== null) layouts.push(layout);
  }
  return layouts;
}
