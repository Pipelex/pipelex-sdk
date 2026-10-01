/**
 * Recorded API responses the `add-method` tests read.
 *
 * Data, never re-fetched: every value below was measured live on 2026-09-05
 * against `api-dev.pipelex.com` (hosted 0.11.2, engine 0.56.0) and is recorded
 * in the campaign's `measurements.md`. A test that fetched instead would need a
 * key, would cost a round trip, and would go red for a reason that has nothing
 * to do with the code under test.
 *
 * The two methods cover the two shapes the scaffold has to handle:
 *
 *  - `github.com/Pipelex/methods/text_stats@v0.1.1` — one pipe, one prose
 *    input, a single `native.Text` output. The template's shipped slice.
 *  - `github.com/Pipelex/methods/documents` — several pipes and NO
 *    bundle-level `main_pipe`, a `document` file input, and a plural
 *    `native.Page` output. Every branch `text_stats` does not reach.
 *
 * The codegen artifacts are trimmed to the export lines `bindOutput` reads:
 * their job here is to be a projection whose exports can be looked up, not to
 * be a faithful copy of a generated file.
 */
import type { GeneratedArtifact, InputForm, OutputForm, PipeIOContracts } from "@pipelex/sdk";

/** `native.Text`'s content model, the schema both text_stats slots carry. */
const NATIVE_TEXT_SCHEMA = {
  description: "A text",
  properties: { text: { description: "The text", title: "Text", type: "string" } },
  required: ["text"],
  title: "native.Text",
  type: "object",
};

/** `native.Document`'s, on the `documents` inputs. */
const NATIVE_DOCUMENT_SCHEMA = {
  description: "A document",
  properties: { url: { title: "Url", type: "string" } },
  required: ["url"],
  title: "native.Document",
  type: "object",
};

/** `native.Page`'s, on the plural `documents` outputs. */
const NATIVE_PAGE_SCHEMA = {
  description: "A page",
  properties: { items: { items: { type: "object" }, type: "array" } },
  required: ["items"],
  title: "native.Page",
  type: "object",
};

export const TEXT_STATS_CONTRACTS: PipeIOContracts = {
  "text_stats.analyze_text": {
    inputs: {
      text: {
        concept_ref: "native.Text",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: NATIVE_TEXT_SCHEMA,
      },
    },
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: NATIVE_TEXT_SCHEMA,
    },
  },
};

export const TEXT_STATS_INPUT_FORM = {
  "text_stats.analyze_text": {
    fields: [
      {
        kind: "prose",
        name: "text",
        concept_ref: "native.Text",
        description: "A text",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
} as InputForm;

/**
 * The other half of the same contract: one node saying what the pipe resolves
 * to. No `presence` and no `gating` — those are input-slot facts an output has
 * none of — and the `name` is the engine's own `"output"`, an address rather
 * than a label.
 */
export const TEXT_STATS_OUTPUT_FORM = {
  "text_stats.analyze_text": {
    field: {
      kind: "prose",
      name: "output",
      concept_ref: "native.Text",
      description: "A text",
      required: true,
    },
  },
} as OutputForm;

/**
 * The lock the codegen route returned for `text_stats@v0.1.1`, verbatim.
 * `crate_fingerprint` is the semantic signal the trust chain turns on.
 */
export const TEXT_STATS_LOCK = `# codegen.lock — generated artifact set (Pipelex codegen). Do not edit by hand.

lock_version = 1
crate_fingerprint = "28f776a299e6ab8d2c14fafae459f5daa50bd030ee1191d149e566f0f37d38e2"
engine_version = "0.56.0"

[[artifacts]]
path = "binder.ts"
content_hash = "703b1d8634f409cc6d47384ceb9d5e449b88df56515f00f136ef620991e5a353"

[[artifacts]]
path = "types.ts"
content_hash = "4b3c7c45005976c7e678c04aa3332c83671b69a082b925ac0ab9a8241e2fc144"
`;

/**
 * The projection, trimmed to the exports `bindOutput` looks for. `text_stats`
 * declares no concept of its own, so its whole crate is the materialized
 * `native.Text` — which is exactly why the narrower can still be typed.
 */
export const TEXT_STATS_ARTIFACTS: GeneratedArtifact[] = [
  {
    path: "types.ts",
    content:
      'import { z } from "zod";\n\nexport const TextSchema = z.object({ text: z.string() });\nexport type Text = z.infer<typeof TextSchema>;\n',
  },
  {
    path: "binder.ts",
    content:
      'import { TextSchema, type Text } from "./types";\n\nexport function parseText(wire: unknown): Text {\n  return TextSchema.parse(wire);\n}\n',
  },
];

/** One `documents` pipe's contract, in the two shapes the package's table shows. */
function documentsPipe(output: { concept: string; plural: boolean }): PipeIOContracts[string] {
  return {
    inputs: {
      document: {
        concept_ref: "native.Document",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: NATIVE_DOCUMENT_SCHEMA,
      },
    },
    output: {
      concept_ref: output.concept,
      multiplicity: output.plural ? "variable" : "single",
      item_count: null,
      optional: false,
      json_schema: output.plural ? NATIVE_PAGE_SCHEMA : NATIVE_TEXT_SCHEMA,
    },
  } as PipeIOContracts[string];
}

/**
 * `github.com/Pipelex/methods/documents` — seven pipes, and `main_pipe` null on
 * the blueprint with `default_pipe_ref` set all the same (the package
 * manifest's entry pipe). That pairing is the whole reason the pipe rule reads
 * `default_pipe_ref` rather than `main_pipe`.
 */
export const DOCUMENTS_CONTRACTS: PipeIOContracts = {
  "documents.extract_document_text": documentsPipe({ concept: "native.Text", plural: false }),
  "documents.extract_document_markdown": documentsPipe({ concept: "native.Text", plural: false }),
  "documents.extract_text_pages": documentsPipe({ concept: "native.Page", plural: true }),
  "documents.extract_markdown_pages": documentsPipe({ concept: "native.Page", plural: true }),
  "documents.extract_page_contents": documentsPipe({ concept: "native.Page", plural: true }),
};

export const DOCUMENTS_INPUT_FORM = Object.fromEntries(
  Object.keys(DOCUMENTS_CONTRACTS).map((ref) => [
    ref,
    {
      fields: [
        {
          kind: "document",
          name: "document",
          concept_ref: "native.Document",
          description: "A document",
          required: true,
          presence: "plain",
          gating: true,
        },
      ],
    },
  ]),
) as InputForm;

/**
 * The output half, keyed off the same contracts so the two artifacts cannot
 * disagree about which pipes are plural.
 *
 * Plurality is on the DESCRIPTOR, never on the concept: a `native.Page[]` pipe
 * gets a `list` node whose `item` is the element with its name stripped, which
 * is the one place a producer of this artifact does real work — and the shape a
 * renderer reads to lay a plural result out as a list rather than as one record.
 */
export const DOCUMENTS_OUTPUT_FORM = Object.fromEntries(
  Object.entries(DOCUMENTS_CONTRACTS).map(([ref, contract]) => {
    const plural = contract.output.multiplicity !== "single";
    const element = {
      kind: plural ? "object" : "prose",
      concept_ref: contract.output.concept_ref,
      required: true,
      ...(plural ? { fields: [] } : {}),
    };
    return [
      ref,
      {
        field: plural
          ? { kind: "list", name: "output", required: true, item: element }
          : { ...element, name: "output" },
      },
    ];
  }),
) as OutputForm;
