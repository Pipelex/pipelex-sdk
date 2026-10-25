// The not-found answers the scripts' tests throw, as the hosted API sends
// them: a problem document of the API's own, with the type, title, domain,
// retry verdict and next step of its code's registry entry, and the detail
// that entry's template gives for its parameters. A route the base URL does
// not serve is no such document: it is a bare `404`, which the SDK reads as
// `request.not_found`.

/** A method address no repository resolves: `method.not_found`, from the MTHDS core registry. */
export function methodNotFoundBody(methodRef: string): string {
  return JSON.stringify({
    type: "https://mthds.ai/errors/method.not_found",
    title: "No method at this address",
    status: 404,
    detail: `No method is found at '${methodRef}'.`,
    code: "method.not_found",
    domain: "input",
    retry: "no",
    next_step: {
      kind: "change_input",
      detail: "Correct the method's address, then send the request again.",
    },
    params: { method_ref: methodRef },
    request_id: "req_method_404",
  });
}

/** A catalog id the organization does not hold: `pipelex.catalog.not_found`, from Pipelex's registry. */
export function catalogNotFoundBody(methodId: string): string {
  return JSON.stringify({
    type: "https://docs.pipelex.com/errors/pipelex.catalog.not_found",
    title: "The saved method does not exist",
    status: 404,
    detail: `The organization's catalog holds no method matching the request for the method '${methodId}'.`,
    code: "pipelex.catalog.not_found",
    domain: "input",
    retry: "no",
    next_step: {
      kind: "change_input",
      detail:
        "List the organization's catalog to find the method, then send the request again with one that exists.",
    },
    params: { resource: "method", method_id: methodId },
    request_id: "req_catalog_404",
  });
}
