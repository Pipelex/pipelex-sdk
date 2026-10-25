/**
 * Problem documents as the hosted API answers them, for the tests that mock its refusals: every
 * core member, a `pipelex.*` code as freely as a core one, and the extra members a test gives.
 */

/** The members a test gives a problem document beyond its code and status. */
export interface ProblemMembers {
  detail?: string;
  domain?: string;
  retry?: string;
  next_step?: { kind: string; detail: string };
  [member: string]: unknown;
}

/** A problem document coded `code` with the HTTP status `status`, `members` written over it. */
export function problemDocument(
  code: string,
  status: number,
  members: ProblemMembers = {},
): Record<string, unknown> {
  return {
    type: `https://docs.pipelex.com/errors/${code}`,
    title: `The title of ${code}`,
    status,
    detail: `The detail of ${code}.`,
    code,
    domain: "input",
    retry: "no",
    next_step: { kind: "change_input", detail: `The next step of ${code}.` },
    ...members,
  };
}

/** An answer carrying `problemDocument(code, status, members)` as `application/problem+json`. */
export function problemResponse(
  code: string,
  status: number,
  members: ProblemMembers = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(problemDocument(code, status, members)), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
}
