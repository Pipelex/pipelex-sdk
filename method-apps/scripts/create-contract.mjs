/**
 * The `make create` contract: the variables the scaffold skill and the family's
 * initializers may pass to a template's `make create`. It is the one list.
 * `create-contract.test.mjs` holds every template's Makefile to it, and
 * `initializers.test.mjs` holds every initializer's table of templates to it,
 * so an initializer's flags are checked against this list rather than kept by
 * hand beside it.
 */

/** What may be passed to any template's `make create`. */
export const SHARED = [
  "METHOD",
  "NAME",
  "TITLE",
  "DESCRIPTION",
  "PIPE",
  "AUTHOR_NAME",
  "AUTHOR_EMAIL",
  "REPO_URL",
  "LICENSE",
  "LICENSE_HOLDER",
  "LICENSE_YEAR",
  "DRY_RUN",
];

/** The variables that are switches: given as `1`, forwarded as a flag alone. */
export const SWITCHES = new Set(["DRY_RUN"]);

/**
 * What a template's gesture takes beyond the shared set. The scaffold passes
 * one only to that template, in answer to a refusal that names it.
 */
export const EXTRAS = {
  "webapp-js": ["METHOD_NAME", "LABEL"],
};

/** The required variable, forwarded in every run. */
export const REQUIRED = "METHOD";
