"use client";

import { useCallback, useMemo, useState } from "react";
import {
  computeReadiness,
  fieldsForContract,
  narrowFileFormats,
  rjsfDataFromRunValues,
  type PipeInputFormDescriptor,
  type PipeIOContract,
  type RunField,
} from "@pipelex/mthds-form";

export interface RunInputsState {
  /** The method's inputs as kernel descriptors — hand these to `<RunInputsForm>`. */
  fields: RunField[];
  values: Record<string, unknown>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  /** Every gating input has a value — what the Run button should gate on. */
  ready: boolean;
  /** The schema-shaped data dict to hand the Server Action, built on demand. */
  toData: () => Record<string, unknown>;
}

export interface RunInputsOptions {
  /**
   * The media types the method's upload action grants — its `ALLOWED_MIMES`.
   * Each file field is narrowed to the formats among them, so the dropzone's
   * hint, its file picker's filter and its own check offer exactly what the
   * action will grant, rather than every format the kernel knows for the kind.
   * Omitted, a file field keeps its kind's whole list.
   *
   * The kernel's `narrowFileFormats` throws when a field would be left
   * accepting nothing: a list naming none of a file input's formats is a
   * configuration error, and the form refuses to render rather than offering a
   * dropzone that refuses every file.
   */
  allowedMimes?: readonly string[];
  initialValues?: Record<string, unknown>;
}

/**
 * Form-value state derived from a method's wire input-form descriptor and its
 * IO contract — both committed by `npm run codegen`.
 *
 * Every field, its control, its label and its readiness rule come from the
 * descriptor (the contract is co-walked for the scalar wrapper key and nested
 * list bounds, the two facts the wire deliberately omits) — swap the method,
 * re-run codegen, and the form follows. Nothing here knows what
 * `extract_entities` is.
 *
 * The companion to `useRun`: this hook owns what goes *in*, `useRun` owns the
 * run itself and what comes *out*.
 */
export function useRunInputs(
  contract: PipeIOContract,
  descriptor: PipeInputFormDescriptor,
  { allowedMimes, initialValues }: RunInputsOptions = {},
): RunInputsState {
  const fields = useMemo(() => {
    const derived = fieldsForContract(contract, descriptor);
    return allowedMimes === undefined ? derived : narrowFileFormats(derived, allowedMimes);
  }, [contract, descriptor, allowedMimes]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues ?? {});

  // Optional and variable-plural inputs never gate, and a whitespace-only
  // string counts as unfilled — the kernel's readiness scan knows all of that,
  // so this is one line rather than a per-form `!text.trim()`.
  const ready = computeReadiness(fields, values).missing.length === 0;

  // Built on submit, not per keystroke: the wire shape only matters at Run.
  const toData = useCallback(() => rjsfDataFromRunValues(values, fields), [values, fields]);

  return { fields, values, setValues, ready, toData };
}
