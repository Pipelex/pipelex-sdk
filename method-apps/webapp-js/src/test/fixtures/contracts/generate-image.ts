// ---------------------------------------------------------------------------
// TEST FIXTURE — not a method this app ships.
//
// The `contracts.ts` that `npm run codegen` wrote for the `generate-image` method of
// pipelex-starter-js (the gallery), recorded verbatim below this banner so the
// shared code's tests run against real codegen output. The template ships no
// method, so these stand in for one. Taken at the gallery's commit
// 3bf44f0fbd3d967b8e50d171454da2278593ee95.
// ---------------------------------------------------------------------------

import type { InputForm, OutputForm, PipeIOContracts } from "@pipelex/mthds-form";

export const PIPE_IO_CONTRACTS: PipeIOContracts = {
  "generate_image.generate_image": {
    inputs: {
      image_prompt: {
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
      concept_ref: "native.Image",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: {
        description: "An image",
        properties: {
          url: {
            description: "The image URL: a storage URI, an HTTP(S) URL, or a base64 data URL",
            title: "Url",
            type: "string",
          },
          public_url: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The public URL of the image",
            title: "Public Url",
          },
          source_prompt: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The source prompt of the image",
            title: "Source Prompt",
          },
          source_negative_prompt: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The source negative prompt of the image",
            title: "Source Negative Prompt",
          },
          caption: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The caption of the image",
            title: "Caption",
          },
          mime_type: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The MIME type of the image",
            title: "Mime Type",
          },
          width: {
            anyOf: [
              {
                exclusiveMinimum: 0,
                type: "integer",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The width of the image, in pixels",
            title: "Width",
          },
          height: {
            anyOf: [
              {
                exclusiveMinimum: 0,
                type: "integer",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The height of the image, in pixels",
            title: "Height",
          },
          filename: {
            anyOf: [
              {
                type: "string",
              },
              {
                type: "null",
              },
            ],
            default: null,
            description: "The original filename of the image",
            title: "Filename",
          },
        },
        required: ["url"],
        title: "native.Image",
        type: "object",
      },
    },
  },
};

export const INPUT_FORM = {
  "generate_image.generate_image": {
    fields: [
      {
        kind: "prose",
        name: "image_prompt",
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
  "generate_image.generate_image": {
    field: {
      kind: "image",
      name: "output",
      concept_ref: "native.Image",
      description: "An image",
      required: true,
    },
  },
} as OutputForm;
