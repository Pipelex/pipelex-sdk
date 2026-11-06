# The live suites' account

These suites in this repository call the hosted API for real: the TypeScript SDK's e2e suite (`js/tests/e2e/`), the Python SDK's live legs (`python/tests/e2e/`), the starters' live checks, `starter-js`'s Playwright specs and `starter-python`'s tests marked `pipelex_api`, the JavaScript templates' `make codegen-verify`, which asks the engine whether each committed generated tree is still what its method resolves to, and the method-app templates' live checks, `webapp-js`'s Playwright specs and the live proofs of `make create` in `webapp-js` and `cli-python` ([`live-create-proofs.md`](live-create-proofs.md)). Against the hosted plane each of them acts for one registered test account, QA Builder (dev) in QA SDK (dev), the organization the Pipelex team's registry of test accounts keeps for the SDKs' and the starters' hosted end-to-end tests. Each checks that account before its first case, and none of them reads its key from an env file while `test-account run` hands one over.

The registry is `test-accounts.toml` at the root of the Pipelex workspace, and its guide is the workspace's `docs/workspace/test-accounts.md`. It names the key `dev-sdk.builder`, the membership of QA Builder (dev) in QA SDK (dev), and records what that key must be: the organization's platform id, the role `member` and the account's email.

## Running a suite

On a laptop, every live run goes through the workspace's `test-account run`, which reads the key from the team's shared secret, checks it against the registry, and runs the command with the key in `PIPELEX_API_KEY`, its expectations beside it, `PIPELEX_BASE_URL` naming the dev plane, `DO_NOT_TRACK=1`, and every other Pipelex or MTHDS credential and endpoint taken out of the environment. The registry declares the SDK suites and the starters' checks as consumers, each naming the variables it reads, and the templates' `codegen-verify` and the method-app templates' checks run as the membership `dev-sdk.builder` itself:

| Suite | Command, from the repository's root |
| --- | --- |
| The TypeScript SDK's e2e suite | `PIPELEX_E2E_METHOD_ID=mt_7a01d1bf-f5cb-4db4-a200-7fa396ac15e8 test-account run pipelex-sdk-js-e2e -- make -C js test-e2e` |
| The Python SDK's live legs | `PIPELEX_E2E_METHOD_ID=mt_7a01d1bf-f5cb-4db4-a200-7fa396ac15e8 test-account run pipelex-sdk-python-e2e -- make -C python e2e-test` |
| `starter-js`'s live specs | `test-account run pipelex-sdk-starters -- make live-starter IN=starter-js` |
| `starter-python`'s live tests | `test-account run pipelex-sdk-starters -- make live-starter IN=starter-python` |
| The JavaScript templates' `codegen-verify` | `test-account run dev-sdk.builder -- make live-codegen-verify`, `IN=<template>` to narrow |
| `webapp-js`'s live specs | `test-account run dev-sdk.builder -- make live-method-app IN=method-apps/webapp-js` |
| `webapp-js`'s create proofs | `test-account run dev-sdk.builder -- make live-create IN=method-apps/webapp-js` |
| `cli-python`'s create proofs | `test-account run dev-sdk.builder -- make live-create IN=method-apps/cli-python` |

The SDK suites' consumers also hand over `PIPELEX_E2E_BASE_URL`, the variable those suites read for their target, set to the dev plane. The templates' `codegen-verify` and the method-app templates' checks read `PIPELEX_API_KEY` alone, which a membership hands over with no consumer entry. The starters' live checks spend a model call each, `webapp-js`'s an image generation, and both JavaScript templates' `make test-e2e` ask before they spend unless `CONFIRM=1` is set; `cli-python`'s create proofs spend a few model calls and ask the same way, while `webapp-js`'s spend none, and neither does `codegen-verify`, which asks for each method's typed artifacts and contracts again and writes nothing. `make live-codegen-verify` runs each template's own `make codegen-verify` where the template's `methods/` holds a method, reports every method before its verdict, and names a template that holds none, as `webapp-js` ships, since it has no committed tree to verify: its create proofs run its codegen against today's engine instead. A run that verified no template at all fails. A CI job that cannot reach the workspace sets the same variables from the registry and runs the same commands without `test-account run`.

The SDK suites also run against a local runner, with no account at all: a base URL whose host is `localhost`, a subdomain of it, `127.x.x.x` or `::1` holds no registered test account, so the check says so and the run goes ahead. The TypeScript suite's default is the local runner `http://localhost:8081`, and the Python legs skip when `PIPELEX_E2E_BASE_URL` is unset. The TypeScript suite's `lint` and `format` cases run against a local runner only: a hosted origin does not expose those routes, so they skip there, as the `method_id` cases below skip without a stored method.

## What the check compares

`test-account run` sets the key's expectations beside it, in variables named after the key's: `PIPELEX_API_KEY_EXPECTED_ORG_ID`, `PIPELEX_API_KEY_EXPECTED_ROLE` and `PIPELEX_API_KEY_EXPECTED_EMAIL`. Before the first case, the check asks `GET /v1/me` with the key, through the SDK's own `getMe()` or `get_me()`, and compares the answer's `organization.org_id`, `organization.role_in_org` and `email`, the email ignoring case. Any difference stops the run once, with one line per difference naming the variable, the value found and the value expected, and the message says that the registry's owner restores the account: a key of another organization, a persona whose role changed and a key the platform refuses are not something to work around by changing the key or its expectations.

Nothing is sent, and the run stops, in each of these cases:

- the base URL is not an http or https URL. Its value is not shown, since nothing says which of its characters are a secret;
- the base URL is the production API, `https://api.pipelex.com`, its host compared without case or the trailing dot that names the same host to DNS, whether a variable names it or the starters fall back to it because `PIPELEX_BASE_URL` is unset, unless `PIPELEX_E2E_ALLOW_PRODUCTION=1` asks for it. Asked for, production is checked like any hosted plane, expectations included, for the day a canary account exists there; no test account exists in production today;
- the base URL is hosted and `PIPELEX_API_KEY` is unset;
- an expectation is unset. The message names `test-account run`, since a key with no expectations says nothing about which account it must act for.

The TypeScript suite's global setup probes the origin's `/v1/version` once, and only after the check went ahead, so that an origin answering nothing is reported once rather than by every file; `make -C js test-e2e` sends nothing before it. A `/v1/me` the check cannot read, whether the platform gave no answer, the SDK refused the base URL before sending, or a 2xx was no profile, stops the run with its cause and is never reported as the account's.

Every line and message the check prints shows the base URL as its scheme and its host alone, and names any credentials, path, query or fragment it carried without their text, as the SDKs' own refusal of a base URL does: those parts are where a secret travels in a URL, and the lines reach a terminal or a CI log.

A platform whose `/v1/me` answer has no `organization` member predates it. The check reports that as "the platform does not state the key's organization yet" and stops the run, because nothing but the email could then be compared; that is never a pass.

Both SDKs' suites implement the check, `js/tests/e2e/live-account.ts` as the TypeScript suite's global setup and `python/tests/e2e/live_account.py` through a hook of the Python legs' `conftest.py`, which runs once collection is done, so neither depends on which cases were selected or which of them skip, and both run the same cases, `js/tests/fixtures/live-account-cases.json`, whose copy in `python/tests/fixtures/` the root's `make shared-files` writes. The root's `make live-starter`, `make live-method-app`, `make live-codegen-verify` and `make live-create` run the Python one as a command, `make -C python live-account`, before a template's live checks start.

## Why the templates' check lives at the root

A starter or a method-app template is a template, and every file in it ships to the projects made from it. In such a project the live checks run on the person's own key, from `.env.local` or `.env`, against the plane `PIPELEX_BASE_URL` names, production by default. A check against the Pipelex team's registry, or a refusal of production, has no place there, and neither does the proof of a gesture the project no longer has. So the maintainers run the templates' live checks through the root: `make live-starter` and `make live-method-app` check the account and then run the template's own suite, `make live-codegen-verify` checks it and then runs each JavaScript template's own `make codegen-verify`, `make live-create` checks it and then takes the create proofs through `scripts/live-create.mjs`, and the templates themselves are unchanged.

## Keeping the key handed over the one in use

A key parked in an env file must never silently replace the one `test-account run` hands over. The suites keep to that as follows:

- `js/`'s `make test-e2e` reads `.env` for `PIPELEX_E2E_BASE_URL` and `PIPELEX_E2E_METHOD_ID` only when the environment does not set them, and never for the key.
- `python/`'s `Makefile` reads no `.env`, since an included one overrides the environment make was started with.
- `make live-starter`, `make live-method-app`, `make live-codegen-verify` and `make live-create` hand the suite, the check or the proof `PIPELEX_BASE_URL` set to the URL the check decided on, the production default included, so no template's env file can point it at a plane the check never saw.
- `starter-js` and `webapp-js` load `.env.local` the way Next.js does, which never overrides a variable already set, and so do their codegen scripts, which is why `make live-codegen-verify` runs a template's own `make codegen-verify` in place. `make live-starter` and `make live-method-app` first refuse a port anything already listens on, since Playwright reuses a server it finds there whatever key it holds, then run the suite with `ALLOW_OWN` empty, so Playwright starts the template's own dev server with the handed key. `webapp-js`'s result-tile spec creates an app of its own from a copy of the template that leaves out `.env` and `.env.local`, and runs it with the same environment.
- `starter-python`'s `Makefile` includes its `.env` over the environment, so `make live-starter` runs its tests through pytest directly; its `conftest.py` loads `.env` without overriding a variable already set.
- The create proofs run in copies of what git tracks or would track in the template, which hold no env file of the checkout, since the templates' `.gitignore` names both. The gesture writes the copy's own env file with an empty key line, which the proof checks, and the created web app and command load it without overriding the handed key.

## The stored method the `method_id` cases need

The TypeScript suite's `crate` and `prepare-inputs` files and the Python legs' `pipe-io` file each have a case that reads the contract of a method stored in the key's organization, or prepares its inputs, the method named by `PIPELEX_E2E_METHOD_ID`; it is skipped when that variable is unset. It is not a credential, so `test-account run` neither hands it over nor takes it out. The method is `mt_7a01d1bf-f5cb-4db4-a200-7fa396ac15e8`, `sdk-e2e-document`, saved and published in QA SDK (dev) by QA Builder: one `PipeLLM`, `summarize_document`, whose input `document` is a `Document`. The cases read its contract and prepare its inputs, and none runs it, so they spend no credit. Against another organization, or a local runner, leave the variable unset.
