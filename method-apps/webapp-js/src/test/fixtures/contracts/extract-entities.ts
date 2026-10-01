// ---------------------------------------------------------------------------
// TEST FIXTURE — not a method this app ships.
//
// The `contracts.ts` that `npm run codegen` wrote for the `extract-entities` method of
// pipelex-starter-js (the gallery), recorded verbatim below this banner so the
// shared code's tests run against real codegen output. The template ships no
// method, so these stand in for one. Taken at the gallery's commit
// 3bf44f0fbd3d967b8e50d171454da2278593ee95.
// ---------------------------------------------------------------------------

import type { InputForm, OutputForm, PipeIOContracts } from "@pipelex/mthds-form";

export const PIPE_IO_CONTRACTS: PipeIOContracts = {
  "extract_entities.extract_entities": {
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
      concept_ref: "extract_entities.ExtractedEntities",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: {
        description: "Named entities extracted from a piece of text.",
        properties: {
          people: {
            description: "Names of people mentioned in the text",
            items: {
              type: "string",
            },
            title: "People",
            type: "array",
          },
          orgs: {
            description: "Names of organizations mentioned in the text",
            items: {
              type: "string",
            },
            title: "Orgs",
            type: "array",
          },
          dates: {
            description: "Dates or time references mentioned in the text",
            items: {
              type: "string",
            },
            title: "Dates",
            type: "array",
          },
        },
        required: ["people", "orgs", "dates"],
        title: "extract_entities.ExtractedEntities",
        type: "object",
      },
    },
  },
};

export const INPUT_FORM = {
  "extract_entities.extract_entities": {
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
  "extract_entities.extract_entities": {
    field: {
      kind: "object",
      name: "output",
      concept_ref: "extract_entities.ExtractedEntities",
      description: "Named entities extracted from a piece of text.",
      required: true,
      fields: [
        {
          kind: "list",
          name: "people",
          description: "Names of people mentioned in the text",
          required: true,
          item: {
            kind: "text",
            required: true,
          },
        },
        {
          kind: "list",
          name: "orgs",
          description: "Names of organizations mentioned in the text",
          required: true,
          item: {
            kind: "text",
            required: true,
          },
        },
        {
          kind: "list",
          name: "dates",
          description: "Dates or time references mentioned in the text",
          required: true,
          item: {
            kind: "text",
            required: true,
          },
        },
      ],
    },
  },
} as OutputForm;
