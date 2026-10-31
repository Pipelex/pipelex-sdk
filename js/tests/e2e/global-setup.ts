/**
 * The e2e suite's global setup: the account check, once, before the first case of any file
 * (`live-account.ts`). A refusal throws, which stops the whole run before any case starts.
 */

import { JS_E2E_TARGET, requireLiveAccount } from "./live-account.js";

export default async function setup(): Promise<void> {
  console.log(await requireLiveAccount(JS_E2E_TARGET));
}
