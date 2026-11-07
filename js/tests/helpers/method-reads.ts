/**
 * A method read narrowed to the caller's own method, for the tests that read one: `getMethod`
 * answers another organization's public method in a narrower shape, told apart by its missing
 * draft token, so a test reading its own method's draft narrows first, as a client does.
 */
import type { MethodDetail, PublicMethodDetail } from "../../src/product-models.js";

/** `method`, checked to be the caller's own: a public method of another organization fails the test. */
export function ownMethod(method: MethodDetail | PublicMethodDetail): MethodDetail {
  if (!("updated_at" in method)) {
    throw new Error(`Expected the caller's own method, read another organization's public one.`);
  }
  return method;
}
