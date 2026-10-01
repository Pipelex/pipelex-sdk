// ---------------------------------------------------------------------------
// TEST FIXTURE — not a method this app ships.
//
// The `contracts.ts` that `npm run codegen` wrote for the `text-stats` method of
// pipelex-starter-js (the gallery), recorded verbatim below this banner so the
// shared code's tests run against real codegen output. The template ships no
// method, so these stand in for one. Taken at the gallery's commit
// 3bf44f0fbd3d967b8e50d171454da2278593ee95.
// ---------------------------------------------------------------------------

import type { InputForm, OutputForm, PipeIOContracts } from "@pipelex/mthds-form";

export const PIPE_IO_CONTRACTS: PipeIOContracts = {
  "text_stats.analyze_text": {
    inputs: {
      text: {
        concept_ref: "native.Text",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: {
          description: "A text",
          properties: {
            text: {
              description: "The text",
              title: "Text",
              type: "string",
            },
          },
          required: ["text"],
          title: "native.Text",
          type: "object",
        },
      },
    },
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: {
        description: "A text",
        properties: {
          text: {
            description: "The text",
            title: "Text",
            type: "string",
          },
        },
        required: ["text"],
        title: "native.Text",
        type: "object",
      },
    },
  },
};

export const INPUT_FORM = {
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

export const OUTPUT_FORM = {
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
