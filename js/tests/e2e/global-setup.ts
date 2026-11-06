/**
 * The e2e suite's global setup, once, before the first case of any file: the account check
 * (`live-account.ts`), then a single probe of the origin it decided on (`origin.ts`). A refusal or
 * an origin that answers nothing throws, which stops the whole run before any case starts, and the
 * account check comes first so that a refused run sends no request at all, the probe included.
 */

import { JS_E2E_TARGET, requireLiveAccount } from "./live-account.js";
import { requireReachable } from "./origin.js";

export default async function setup(): Promise<void> {
  const account = await requireLiveAccount(JS_E2E_TARGET);
  console.log(account.line);
  if (account.verdict !== "no_target") {
    await requireReachable(account.baseUrl, account.shown);
  }
}
