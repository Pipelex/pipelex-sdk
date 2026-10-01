// ---------------------------------------------------------------------------
// TEST FIXTURE — not a method this app ships.
//
// The `contracts.ts` that `npm run codegen` wrote for the `summarize-pdf` method of
// pipelex-starter-js (the gallery), recorded verbatim below this banner so the
// shared code's tests run against real codegen output. The template ships no
// method, so these stand in for one. Taken at the gallery's commit
// 3bf44f0fbd3d967b8e50d171454da2278593ee95.
// ---------------------------------------------------------------------------

import type { InputForm, OutputForm, PipeIOContracts } from "@pipelex/mthds-form";

export const PIPE_IO_CONTRACTS: PipeIOContracts = {
  "summarize_pdf.summarize_pdf": {
    inputs: {
      document: {
        concept_ref: "native.Document",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: {
          description: "A document",
          properties: {
            url: {
              description: "The document URL: a storage URI, an HTTP(S) URL, or a base64 data URL",
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
              description: "The public HTTPS URL of the document",
              title: "Public Url",
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
              description: "The MIME type of the document",
              title: "Mime Type",
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
              description: "The original filename of the document",
              title: "Filename",
            },
            title: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
              default: null,
              description: "The title of the document or source",
              title: "Title",
            },
            snippet: {
              anyOf: [
                {
                  type: "string",
                },
                {
                  type: "null",
                },
              ],
              default: null,
              description: "A text snippet or excerpt from the document",
              title: "Snippet",
            },
          },
          required: ["url"],
          title: "native.Document",
          type: "object",
        },
      },
    },
    output: {
      concept_ref: "summarize_pdf.DocumentSummary",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: {
        description: "A structured summary of a document",
        properties: {
          title: {
            description: "A concise title for the document",
            title: "Title",
            type: "string",
          },
          doc_type: {
            description: "The kind of document, such as invoice, report, article, or contract",
            title: "Doc Type",
            type: "string",
          },
          key_points: {
            description: "The main takeaways from the document, one per item",
            items: {
              type: "string",
            },
            title: "Key Points",
            type: "array",
          },
        },
        required: ["title", "doc_type", "key_points"],
        title: "summarize_pdf.DocumentSummary",
        type: "object",
      },
    },
  },
};

export const INPUT_FORM = {
  "summarize_pdf.summarize_pdf": {
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
} as InputForm;

export const OUTPUT_FORM = {
  "summarize_pdf.summarize_pdf": {
    field: {
      kind: "object",
      name: "output",
      concept_ref: "summarize_pdf.DocumentSummary",
      description: "A structured summary of a document",
      required: true,
      fields: [
        {
          kind: "text",
          name: "title",
          description: "A concise title for the document",
          required: true,
        },
        {
          kind: "text",
          name: "doc_type",
          description: "The kind of document, such as invoice, report, article, or contract",
          required: true,
        },
        {
          kind: "list",
          name: "key_points",
          description: "The main takeaways from the document, one per item",
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
