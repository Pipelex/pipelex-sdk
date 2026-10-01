import { describe, it, expect } from "vitest";
import {
  computeReadiness,
  fieldsForContract,
  rjsfDataFromRunValues,
  type InputForm,
  type PipeIOContracts,
} from "@pipelex/mthds-form";
import { gateRunInputs, requireContract, requireInputForm } from "./runInputs";
import { INPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/extract-entities/contracts";
import {
  INPUT_FORM as PDF_INPUT_FORM,
  PIPE_IO_CONTRACTS as PDF_CONTRACTS,
} from "@/generated/summarize-pdf/contracts";
import {
  INPUT_FORM as COMPLEX_INPUT_FORM,
  PIPE_IO_CONTRACTS as COMPLEX_CONTRACTS,
} from "@/generated/complex-form/contracts";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "extract_entities", "extract_entities");
/** A file-shaped input, to cover the `{url}` envelope alongside `{text}`. */
const PDF_CONTRACT = requireContract(PDF_CONTRACTS, "summarize_pdf", "summarize_pdf");

describe("requireContract", () => {
  it("looks a pipe up by domain and pipe code", () => {
    expect(Object.keys(CONTRACT.inputs)).toEqual(["text"]);
  });

  it("throws naming the available keys when the lookup misses", () => {
    // The kernel returns `undefined` on a miss, which renders as an empty form
    // with a live Run button — a silent failure. Loud is the point here.
    expect(() => requireContract(PIPE_IO_CONTRACTS, "extract_entities", "nope")).toThrow(
      /extract_entities\.nope/,
    );
    expect(() => requireContract(PIPE_IO_CONTRACTS, "extract_entities", "nope")).toThrow(
      /extract_entities\.extract_entities/,
    );
  });
});

describe("requireInputForm", () => {
  it("looks a pipe's descriptor up by domain and pipe code", () => {
    const descriptor = requireInputForm(INPUT_FORM, "extract_entities", "extract_entities");
    expect(descriptor.fields.map((field) => field.name)).toEqual(["text"]);
  });

  it("throws naming the available keys when the lookup misses", () => {
    // Same failure mode as a missed contract, and worse: `fieldsForContract`
    // returns `[]` without the descriptor, so the miss IS the empty form.
    expect(() => requireInputForm(INPUT_FORM, "extract_entities", "nope")).toThrow(
      /extract_entities\.nope/,
    );
    expect(() => requireInputForm(INPUT_FORM, "extract_entities", "nope")).toThrow(
      /extract_entities\.extract_entities/,
    );
  });
});

describe("gateRunInputs", () => {
  it("turns schema-shaped data into the runtime's {concept, content} envelope", () => {
    const result = gateRunInputs(CONTRACT, { text: { text: "Ada met Charles" } });
    expect(result).toEqual({
      ok: true,
      inputs: { text: { concept: "native.Text", content: { text: "Ada met Charles" } } },
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "x"],
    ["an array", []],
  ])("classifies %s as a bad request instead of throwing", (_label, payload) => {
    // A Server Action is a public endpoint and Next does not enforce the
    // declared parameter type. The kernel takes `data` as `unknown` and
    // normalizing it is its gate's own first step, so a hostile body gets a
    // verdict naming what is missing — never a TypeError that Next would strip
    // to an opaque digest, the one outcome this module promises never happens.
    let result: ReturnType<typeof gateRunInputs> | undefined;
    expect(() => {
      result = gateRunInputs(CONTRACT, payload);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.title).toBe("Input required");
    expect(result.error.message).toContain("text");
  });

  it("drops an input the contract does not declare", () => {
    // The gate is the trust boundary, and the PDF action scans exactly what it
    // returns — so a key smuggled past it would reach `prepareInputs`
    // unexamined by `checkFileInputs`. The property holds because the kernel
    // builds the envelope from the *contract's* keys rather than the caller's;
    // nothing here would notice a kernel bump that changed that.
    const result = gateRunInputs(CONTRACT, {
      text: { text: "Ada met Charles" },
      smuggled: { url: "/etc/passwd" },
    });
    expect(result).toEqual({
      ok: true,
      inputs: { text: { concept: "native.Text", content: { text: "Ada met Charles" } } },
    });
  });

  it("returns a bad_request error naming the input the caller left out", () => {
    const result = gateRunInputs(CONTRACT, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(result.error.title).toBe("Input required");
    expect(result.error.message).toContain("text");
    expect(result.error.details).toContain("text");
  });

  it("rejects a required input that arrived present but empty", () => {
    // The schema is satisfied here — ajv's `required` only asserts the key is
    // present, and the contracts carry no `minLength`. This is the payload the
    // kernel itself produces from an untouched form (`rjsfDataFromRunValues`),
    // so an empty string reaching a paid run is the natural failure, not a
    // contrived one. The browser refuses it via readiness; so must this side.
    const result = gateRunInputs(CONTRACT, { text: { text: "" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(result.error.title).toBe("Input required");
    expect(result.error.details).toContain("text");
  });

  it("rejects an empty file input, where the byte check cannot catch it", () => {
    // The file-shaped equivalent, and the costlier one. The gate has to catch
    // it: an empty `url` is a well-formed shape, so nothing about the schema
    // objects to it, and a run would start on an input the user never filled.
    const result = gateRunInputs(PDF_CONTRACT, { document: { url: "" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBe("Input required");
    expect(result.error.details).toContain("document");
  });

  it("accepts a file input that carries a URL but no bytes", () => {
    // The kernel's "paste a URL instead" path — filled, so the gate passes it
    // and resolving it is `prepareInputs`' job.
    const result = gateRunInputs(PDF_CONTRACT, { document: { url: "https://example.com/a.pdf" } });
    expect(result.ok).toBe(true);
  });

  it("falls back to the kernel's error descriptions when nothing can be named missing", () => {
    // A value of the wrong shape passes the missing-input scan (the key is
    // present) but fails ajv, so the verdict carries `errors` and no
    // `missingInputs`. Without the fallback that rejection would be blank.
    // An object where a string belongs: the kernel's ajv runs `coerceTypes`, so
    // a number would quietly become `"42"` — this is a shape it cannot repair.
    const result = gateRunInputs(CONTRACT, { text: { text: { nested: true } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBe("Invalid input");
    // Assert the rendered wording, not merely that *something* was rendered:
    // `invalidInputsError` falls back to a fixed sentence when the lines come
    // back empty, so `not.toBe("")` would hold even if the translator produced
    // nothing. This is the only test that exercises `VALIDATION_MESSAGES`.
    expect(result.error.details).toContain("must be string");
  });

  it("omits an optional input the caller left blank, so the runtime sees a real absence", () => {
    const withOptional: PipeIOContracts = {
      "d.p": {
        inputs: {
          note: {
            concept_ref: "native.Text",
            presence: "optional",
            multiplicity: "single",
            item_count: null,
            ...textSchema(),
          },
        },
        output: {
          concept_ref: "native.Text",
          multiplicity: "single",
          item_count: null,
          optional: false,
          json_schema: {},
        },
      },
    };
    const contract = requireContract(withOptional, "d", "p");
    expect(gateRunInputs(contract, {})).toEqual({ ok: true, inputs: {} });
  });
});

/**
 * The invariant the gate exists to hold, asserted by running *both* sides.
 *
 * `gateRunInputs` is only trustworthy if it refuses everything the Run button
 * refuses; it is only usable if it accepts everything the Run button accepts.
 * Neither direction can be established by reading the two implementations —
 * they call different kernel functions on differently-shaped values — so this
 * table drives the real `computeReadiness` and the real gate over the same
 * inputs and demands the same verdict.
 *
 * The structured case is the one that matters most. The synthetic contracts
 * below predate `methods/complex-form/`, and they are kept rather than replaced
 * by it: they isolate one shape each, including shapes no committed method has
 * (a struct with required children, a half-filled struct). For a `prose` or
 * `document` field — all the other three methods derive to those —
 * `fieldFilled` collapses to `isFilled`, so a gate built on the wrong predicate
 * still looks correct against them.
 */
describe("the gate agrees with the Run button", () => {
  const person: PipeIOContracts = {
    "d.p": {
      inputs: {
        person: {
          concept_ref: "d.Person",
          presence: "plain",
          multiplicity: "single",
          item_count: null,
          json_schema: {
            type: "object",
            title: "Person",
            properties: {
              first_name: { type: "string", title: "First name" },
              last_name: { type: "string", title: "Last name" },
            },
            required: ["first_name", "last_name"],
          },
        },
      },
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: {},
      },
    },
  };

  /** The wire descriptor `person` would ride beside — hand-built to the spec. */
  const personForm: InputForm = {
    "d.p": {
      fields: [
        {
          kind: "object",
          name: "person",
          concept_ref: "d.Person",
          required: true,
          presence: "plain",
          gating: true,
          fields: [
            { kind: "text", name: "first_name", required: true },
            { kind: "text", name: "last_name", required: true },
          ],
        },
      ],
    },
  };

  const allOptional: PipeIOContracts = {
    "d.p": {
      inputs: {
        opts: {
          concept_ref: "d.Options",
          presence: "plain",
          multiplicity: "single",
          item_count: null,
          json_schema: {
            type: "object",
            title: "Options",
            properties: {
              tone: { type: "string", title: "Tone" },
              style: { type: "string", title: "Style" },
            },
          },
        },
      },
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: {},
      },
    },
  };

  /**
   * `allOptional`'s descriptor. A required struct gates even when every child
   * is optional — the wire states `gating: true` and the kernel's readiness
   * asks the value bridge whether anything inside was touched.
   */
  const allOptionalForm: InputForm = {
    "d.p": {
      fields: [
        {
          kind: "object",
          name: "opts",
          concept_ref: "d.Options",
          required: true,
          presence: "plain",
          gating: true,
          fields: [
            { kind: "text", name: "tone", required: false },
            { kind: "text", name: "style", required: false },
          ],
        },
      ],
    },
  };

  /**
   * A variable-plural input — an `array` json_schema, which is exactly what the
   * kernel's `isPluralInput` keys off. A variable list never gates, even
   * declared non-optional: its empty form IS the empty list. (A fixed-count
   * `Concept[N]` list is the exception — the method declared the count, so it
   * gates.) `methods/complex-form/` declares one too; this isolates the branch.
   */
  const plural: PipeIOContracts = {
    "d.p": {
      inputs: {
        pages: {
          concept_ref: "native.Text",
          presence: "plain",
          multiplicity: "variable",
          item_count: null,
          json_schema: {
            type: "array",
            title: "Pages",
            items: {
              type: "object",
              title: "TextContent",
              properties: { text: { type: "string", title: "Text" } },
              required: ["text"],
            },
          },
        },
      },
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: {},
      },
    },
  };

  /**
   * `plural`'s descriptor. The required arm's one underivable fact, stated on
   * the wire: a variable list is required yet `[]` satisfies it, so
   * `gating: false`. The `item` carries no `name` — the index labels items.
   */
  const pluralForm: InputForm = {
    "d.p": {
      fields: [
        {
          kind: "list",
          name: "pages",
          concept_ref: "native.Text",
          required: true,
          presence: "plain",
          gating: false,
          item: { kind: "prose", concept_ref: "native.Text", required: true },
        },
      ],
    },
  };

  const cases: Array<{
    label: string;
    contracts: PipeIOContracts;
    inputForm: InputForm;
    domain: string;
    pipe: string;
    /** Form values as the browser holds them, not the wire shape. */
    values: Record<string, unknown>;
  }> = [
    {
      label: "text untouched",
      contracts: PIPE_IO_CONTRACTS,
      inputForm: INPUT_FORM,
      domain: "extract_entities",
      pipe: "extract_entities",
      values: {},
    },
    {
      label: "text filled",
      contracts: PIPE_IO_CONTRACTS,
      inputForm: INPUT_FORM,
      domain: "extract_entities",
      pipe: "extract_entities",
      values: { text: "Ada met Charles" },
    },
    {
      label: "document untouched",
      contracts: PDF_CONTRACTS,
      inputForm: PDF_INPUT_FORM,
      domain: "summarize_pdf",
      pipe: "summarize_pdf",
      values: {},
    },
    {
      label: "document pasted as a URL",
      contracts: PDF_CONTRACTS,
      inputForm: PDF_INPUT_FORM,
      domain: "summarize_pdf",
      pipe: "summarize_pdf",
      values: { document: { url: "https://example.com/a.pdf" } },
    },
    {
      label: "struct untouched",
      contracts: person,
      inputForm: personForm,
      domain: "d",
      pipe: "p",
      values: {},
    },
    // A required struct whose children are all optional gates until *touched* —
    // and reads filled the moment anything inside it is. Both directions used
    // to disagree between the two sides; see the named-missing test below.
    {
      label: "all-optional struct untouched",
      contracts: allOptional,
      inputForm: allOptionalForm,
      domain: "d",
      pipe: "p",
      values: {},
    },
    {
      label: "all-optional struct touched",
      contracts: allOptional,
      inputForm: allOptionalForm,
      domain: "d",
      pipe: "p",
      values: { opts: { tone: "formal" } },
    },
    // Half-filled: `isFilled` says yes (some child), `fieldFilled` says no (a
    // required child is empty). The gate must side with the button.
    {
      label: "struct half-filled",
      contracts: person,
      inputForm: personForm,
      domain: "d",
      pipe: "p",
      values: { person: { first_name: "Ada", last_name: "" } },
    },
    {
      label: "struct filled",
      contracts: person,
      inputForm: personForm,
      domain: "d",
      pipe: "p",
      values: { person: { first_name: "Ada", last_name: "Lovelace" } },
    },
    {
      label: "plural input untouched",
      contracts: plural,
      inputForm: pluralForm,
      domain: "d",
      pipe: "p",
      values: {},
    },
    {
      // A bare string array, which is what a `kind: "list"` over a text item
      // holds. The item-shaped `[{text: "first page"}]` looks right and is not:
      // `rjsfDataFromRunValues` drops the content, this case collapses onto the
      // untouched row above, and the filled-plural envelope goes untested.
      label: "plural input with one entry",
      contracts: plural,
      inputForm: pluralForm,
      domain: "d",
      pipe: "p",
      values: { pages: ["first page"] },
    },
    // The complex-form example, from its committed contract — the one method in
    // `methods/` that reaches the structured and plural branches for real. Every
    // state its form can be in belongs here, because a redesign of that method
    // is the likeliest way to reintroduce the failure the next row describes.
    {
      label: "complex-form untouched",
      contracts: COMPLEX_CONTRACTS,
      inputForm: COMPLEX_INPUT_FORM,
      domain: "complex_form",
      pipe: "extract_brief",
      values: { text: "Ada met Charles" },
    },
    {
      label: "complex-form with the optional struct's enum picked",
      contracts: COMPLEX_CONTRACTS,
      inputForm: COMPLEX_INPUT_FORM,
      domain: "complex_form",
      pipe: "extract_brief",
      values: { text: "Ada met Charles", focus: { audience: "legal" } },
    },
    {
      label: "complex-form with only the optional struct's free-text child",
      contracts: COMPLEX_CONTRACTS,
      inputForm: COMPLEX_INPUT_FORM,
      domain: "complex_form",
      pipe: "extract_brief",
      values: { text: "Ada met Charles", focus: { notes: "formal names" } },
    },
    {
      label: "complex-form fully filled",
      contracts: COMPLEX_CONTRACTS,
      inputForm: COMPLEX_INPUT_FORM,
      domain: "complex_form",
      pipe: "extract_brief",
      values: {
        text: "Ada met Charles",
        focus: { audience: "legal", notes: "formal names" },
        must_include: ["Cupertino"],
      },
    },
  ];

  it.each(cases)("$label", ({ contracts, inputForm, domain, pipe, values }) => {
    const contract = requireContract(contracts, domain, pipe);
    const fields = fieldsForContract(contract, requireInputForm(inputForm, domain, pipe));
    const runButtonLive = computeReadiness(fields, values).missing.length === 0;

    // Exactly what the form sends: the hook's `toData()`.
    const gate = gateRunInputs(contract, rjsfDataFromRunValues(values, fields));

    expect(gate.ok).toBe(runButtonLive);
  });

  // The disagreement kernel 0.3.0 had on this shape is fixed, and this pins the
  // *names* on both sides — the agreement rows above only compare verdicts. A
  // required struct input with no required children now has to be touched:
  // readiness reports it missing by variable name, and the gate refuses the
  // absent input naming the same variable (it used to quote only ajv's
  // `must have required property 'opts'`).
  it("names a required struct input with no required children, on both sides", () => {
    const contract = requireContract(allOptional, "d", "p");
    const fields = fieldsForContract(contract, requireInputForm(allOptionalForm, "d", "p"));

    expect(computeReadiness(fields, {}).missing).toEqual(["opts"]);

    const gate = gateRunInputs(contract, rjsfDataFromRunValues({}, fields));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error.details).toContain("Missing required input: opts");
  });

  it("carries a filled list's items into the wire envelope", () => {
    // Agreement alone cannot catch a fixture whose content is silently dropped:
    // both sides say "ready" for an empty list too, so the row above passes
    // either way. Assert the payload the plural case is there to exercise.
    const contract = requireContract(plural, "d", "p");
    const fields = fieldsForContract(contract, requireInputForm(pluralForm, "d", "p"));
    const gate = gateRunInputs(contract, rjsfDataFromRunValues({ pages: ["first"] }, fields));
    expect(gate).toEqual({
      ok: true,
      inputs: { pages: { concept: "native.Text", content: [{ text: "first" }] } },
    });
  });
});

function textSchema() {
  return {
    json_schema: {
      type: "object",
      title: "TextContent",
      properties: { text: { type: "string", title: "Text" } },
      required: ["text"],
    },
  };
}
