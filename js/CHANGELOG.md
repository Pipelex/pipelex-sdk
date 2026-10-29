# Changelog

## [Unreleased]

### Added

- **A run-history row says whether its results are stored**: `RunHistoryItem`, each row of `listRuns` and `iterateRuns`, gains the optional `results_stored`, `true` exactly when the run is `COMPLETED` with its results stored, so `getRunResult` can read them, and `false` otherwise. Only while the run is queued or running does `false` mean "not yet"; it is `false` for good on a run that ended any other way than `COMPLETED`, and on a `COMPLETED` run whose result went inline to the caller that started it, as a blocking `execute` run's does, whose results read answers `404 run.results_not_stored`, so a history asks for no results on such a row. Where the results are stored stays off the list, and a platform that predates the field leaves it out, which does not mean `false` (`docs/architecture.md`).

## [v0.57.0] - 2026-10-29

### Changed

- **The `mthds` floor moves from `^0.33.0` to `^0.34.0` (Breaking)**: `mthds` 0.34.0 follows the MTHDS standard's `8.0.1` cut, and what this package re-exports from `mthds/protocol` follows it: `MTHDS_PROTOCOL_VERSION` is `2.0.1`, which only states the order of a files map's refusals, `MTHDS_ERROR_REGISTRY_VERSION` is `8.0.1`, and `CORE_REGISTRY` and every problem `buildProblem` builds for a code a run can raise carry the registry's new titles and next steps, written for someone following a run of a method they did not write, `pipe.output_invalid` now reading "A step's result does not have the structure the method declares" where it read "A pipe's output does not fit its concept". No code, domain, retry verdict or step kind changes, so code that branches on a problem's `code` is unaffected while code matching a title's text follows the new wording. A project that also imports `mthds` itself moves to 0.34 with it, so that one copy is installed.

## [v0.56.0] - 2026-10-28

### Changed

- **`listRuns` and `iterateRuns` take the method as an optional filter (Breaking)**: `listRuns(query?)` and `iterateRuns(query?)` take the method as `methodId` in their query, sent as `method_id`, where it was a required first argument, and without it they list the organization's runs of every method, newest first, with `createdBy`, `status`, `createdFrom` and `createdTo` applying as they do with a method. Move the id into the query, `listRuns(methodId, query)` becoming `listRuns({ ...query, methodId })`, and pass a cursor back with the same `methodId`, since the cursor of one list is refused on another. A call still passing the id first is rejected with a `RequestArgumentError` before any request, for `iterateRuns` at the call rather than when iteration begins, instead of listing every method's runs.
- **A run-history row names its method and its author (Breaking)**: `RunHistoryItem` gains `method_id`, the bare catalog id of the method the run ran, and `created_by_user_id`, the canonical user id of the member who started it, both required, so a list across methods can name each row's method from the catalog and its author from the organization's members; a row built by hand, as in a test, now carries both.

## [v0.55.0] - 2026-10-26

### Added

- **The method version of each file use's run**: `FileUse`, each use in the page `getFile` answers, gains `method_version`, the published version number its run ran or `"draft"` for a run of the draft, so a client tells a run of a published version from a run of the draft without reading any run; it is `null` on an example's use, on a run of an inline source and on a use recorded before the platform carried it, and `getFile` reads a use answered without it, by a platform that predates it, or with anything but an integer or `"draft"`, as `null` too (`docs/files.md`).

### Changed

- **The `.mthds` check hook's lint engine moves to `@pipelex/tools-wasm` 0.6.1**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.6.1, a dependency refresh whose engine is built past its dependencies' security advisories and loads its WebAssembly through `@wasm-tool/rollup-plugin-rust` 3; its MTHDS schema and its API are those of 0.6.0, so the hook blocks and passes the same forms as before. The published package is unchanged, since the engine is a development dependency.

## [v0.54.1] - 2026-10-25

### Added

- **Who made each file use's holder**: `FileUse`, each use in the page `getFile` answers, gains `created_by`, the member who started the run or saved the example, so a client tells its own runs among a file's uses without reading any run; it is `null` on a use recorded before the platform carried it, and `getFile` reads a use answered without it, by a platform that predates it, or with a member that is not a string, as `null` too (`docs/files.md`).

## [v0.53.0] - 2026-10-25

### Added

- **`readProblemItems`**: reads a verdict's `errors` or `warnings` as the standard's `ProblemItem`s member by member, so an item whose `code` or `detail` is not a string is skipped and a member that does not fit is left out of its item, as every verdict of the SDK reads them.
- **`RunFailedError.runError` and the failed arm's `problem`**: a failed run's error and the `failed` arm of `getRunResult` carry the results read's `run.failed` document as `problem`, and the run's own problem, which it nests as `run_error`, as `runError` on the error and `error` on the arm, under its own code (`run.cancelled`, `model.unavailable`, `method.invalid`, …).
- **A shared case file of the problems the SDK builds**: `tests/fixtures/sdk-problems.json`, copied from `js/` into `python/`, pins every failure the SDK detects itself, every class's problem and the reading of every bare answer to its problem code, and both suites run it.

### Changed

- **Every error carries its failure as one problem document (Breaking)**: every error the SDK throws is the standard's `ProblemError`, carrying an RFC 9457 problem document with the MTHDS core members as `problem` and reading it through `code`, `domain`, `retry`, `nextStep`, `retryAfter` and `requestId`; a hosted refusal is the problem document the API answered, a failed run's problem is the one the platform stored, and a failure the SDK detects itself, such as a refused argument, a request that got no answer, an answer it cannot read or a start whose outcome is unknown, is a problem it builds under a `client.*` code or another core code. Branch on `code`, never on the class, the status or the message, which stays the SDK's own sentence.
- **`ApiResponseError` reads the answer as its problem (Breaking)**: its `problem` is the body as received when it is a problem document, a `pipelex.*` code and every member the standard does not name included, and otherwise the reading of the edge's bare answer by its status, `client.outcome_unknown` for a `start` or an `execute` the gateway cut off; `apiUrl`, `status`, `statusText` and `responseBody` keep the answer itself. `ApiResponseErrorOptions` is `{ cause, problem, headers, mayStartRun }`: `details` is `problem` again, as the Python twin names it.
- **A start whose outcome is unknown reads as `retry: "outcome_unknown"` (Breaking)**: an error from a `start` or a blocking `execute` that may have created a run although the call failed carries `client.outcome_unknown`, whose `retry` is `outcome_unknown`, where it carried `runMayHaveStarted: true`; `PipelineExecuteTimeoutError` always carries it.
- **A failed run's error is the run's problem (Breaking)**: `RunPublic.error`, which the status read carries, the `failed` arm's `error`, `RunHistoryItem.error` and `PipelineRun.error` are the run's own problem document, or `null`, read leniently so that anything but a problem document reads as `null`, where they were the stored `RunErrorReport`; `RunFailedError` loses `error` for `runError`.
- **A progress invocation's `last_failure` carries its problem (Breaking)**: `ProgressFailure` is `{ problem, at? }`, losing `message` for `problem`, the standard's `Problem` in the caller's view: the problem that ended the invocation, or that of the latest failure of an attempt being tried again; `getRunProgress` keeps a `last_failure` only when its `problem` is a problem document, and its `at` only when it is a string, so read `last_failure.problem` and branch on its `code`.
- **Verdicts list their faults as problem items (Breaking)**: `PipelexInvalidReport.errors` and `CrateInvalidReport.errors`, a valid verdict's `warnings`, and `MethodLoadError`'s `problem.errors` are the standard's `ProblemItem`s, read from the answer's `errors` member by member, where they were `validation_errors` of `ValidationErrorItem`s; `MethodLoadError` loses `validationErrors`, and the `pipelex-sdk` command lists a method's faults from them.
- **A refused publish's verdict is read as `validate` reads one**: the `refused` arm of `publishMethod` reads its `validation` member by member, so an entry of its `errors` that names no fault is left out and a verdict listing none lists an empty `errors`, and a refusal whose `validation` is not a verdict object with a boolean `is_valid` throws the `ApiResponseError` of an answer the SDK cannot read.
- **The results read's `409` is read by its code (Breaking)**: `getRunResult` reads a `409` `run.failed` as the `failed` arm and a `409` `run.not_finished` as the `running` arm, whose `retry_after_seconds` is the problem's `retry_after` rounded up to whole seconds, else the `Retry-After` header's, and throws any other `409` as an `ApiResponseError`, where every `409` was the `failed` arm.
- **A missing route is a 404 that names no code of its own, or `request.not_found` (Breaking)**: the lifecycle start and reads, progress included, throw `RunLifecycleUnavailableError` for a `404` whose body is not a JSON object naming a non-empty string `code`, such as a bare runner's `{"detail": "Not Found"}`, and for a `request.not_found` problem document, the one a runner answers for a path no route serves from pipelex-api 0.90 on, where a body carrying any `code` member was an `ApiResponseError`; every other coded `404`, such as `run.not_found` or a method that does not exist, stays an `ApiResponseError`.
- **The method and idempotency codes are registry codes (Breaking)**: `MethodErrorCode` is `pipelex.catalog.update_conflict`, `pipelex.catalog.being_deleted`, `pipelex.catalog.not_published`, `pipelex.catalog.not_found`, `pipelex.org.not_found` and `pipelex.catalog.copy_too_large`, and `IdempotencyErrorCode` is `request.idempotency_key_in_use` and `request.idempotency_conflict`.
- **A failure's own vocabulary is its `reason` (Breaking)**: `RejectedAssetError`, `TestFileRefusedError`, `UploadTransportError`, `ArtifactFetchError` and `MethodFileTransferError` name why they failed as `reason`, typed `RejectedAssetReason`, `TestFileRefusalReason`, `UploadTransportReason` and `MethodFileTransferReason`, so `code` is the problem's alone, and `ApiUnreachableError` names its network failure `networkCode`.
- **The codegen and exact-integer errors carry problems (Breaking)**: `CodegenLockError` and `ExactJsonUnsupportedError` are `ProblemError`s, the first stating its cause (`client.file_unreadable` for a malformed lock, `client.tool_outdated` for a format this build does not read, `client.argument_invalid` for a caller's mistake), the second `client.tool_outdated` naming the JavaScript runtime.
- **The `.mthds` check hook names the verdict's problem items**: when the server sends no Markdown, the hook built by `npm run build:hook` words its block from the invalid verdict's `errors[]`, naming each MTHDS problem item by its code, its sentence and where it happened, with its suggested fix on a line of its own, and it no longer reads `validation_errors[]`. The items are read as every verdict of the SDK reads them (`readProblemItems`), so an entry with no code or sentence is skipped and a location or a fix the standard's check refuses is left out of its item (`docs/hook-bundle.md`).

### Fixed

- **A download failure the SDK cannot place reads as `unknown`**: an item of `downloadArtifacts` that failed for a reason neither the fetch nor the write of its file names carries the `error.code` `unknown`, where it carried `network`, which read as a failure a retry can pass, as `pipelex-sdk` labels it.

### Removed

- **The verdict vocabulary (Breaking)**: `errorVerdictOf`, `problemVerdict`, `ErrorVerdict`, `ErrorDomain`, `runMayHaveStartedOf` and every error's `retryable`, `errorDomain` and `runMayHaveStarted` are gone, as is the fallback table that decided a verdict from the status; read `domain` and `retry` off the problem.
- **The hosted members of `ApiResponseError` (Breaking)**: `errorType`, `serverMessage`, `code` (now the problem's), `type`, `title`, `instance`, `errorCategory`, `userAction`, `model`, `provider`, `providerMetadata`, `migration`, `errors`, `validationErrors` and `problemDocument` are gone; every one of them is a member of `problem`, read there.
- **The hand-written error and verdict types (Breaking)**: `RunErrorReport`, `UserAction`, `ProviderErrorMetadata`, `MigrationErrorBlock`, `FieldError`, `ProblemDetails`, `ValidationErrorItem`, `ValidationErrorCategory`, `SuggestedFix`, `FixSafety`, `FixOpKind`, `FixOp` and its variants, and the `TomlScalar`, `TomlValue` and `FixValue` types are gone, replaced by the standard's `Problem`, `ProblemItem`, `SuggestedFix` and `FixOp` from `mthds/protocol`.

## [v0.52.0] - 2026-10-24

### Changed

- **A duplicate refused for a bundle naming the original's run files**: `MethodCopyRefused`, `MethodCopyRefusalReason`, `BundleStorageReference`, `copyMethod` and `docs/method-copy.md` describe the refusal the platform now answers a duplicate too, when a `.mthds` file names a stored file under the original method's own run files (`pipelex-storage://<org_id>/<method_id>/…`), which erasing the original would remove, beside the references the destination cannot read; the verdict, its reason `bundle_names_other_storage` and its shape are unchanged, so a caller branching on `outcome` needs nothing new.

### Fixed

- **The copy's documented refusals**: `copyMethod`'s JSDoc, `MethodCopyRequestOptions` and `docs/method-copy.md` match the platform's answers: the `409` `conflict` of a tree the organization no longer holds whole is `runtime` and told from a reused key's `input` one by `errorDomain`, the `413` also refuses a `name` that leaves the copy's row no room for a publish, the `500` is not retryable when the platform has no storage credentials, and the `503` also covers a DynamoDB failure, its `detail` naming the copy's method id when the row could not be confirmed, a copy that may stand and that a retry may make twice; a copy of an empty draft, and its `copied_from`, carry a `null` `draft_digest`.

## [v0.51.0] - 2026-10-23

### Added

- **A method copied into another organization**: `copyMethod(methodId, { destination_org_id, name, expected_draft_updated_at }, { idempotencyKey })` sends `POST /v1/methods/{method_id}/copy`, which makes a new, unpublished method in an organization the caller may change methods in, the method's own for a duplicate, holding the original's draft tree, its form inputs and its saved examples, with the stored files they name copied into the destination, and leaves the original as it was. It answers a `MethodCopyResult` discriminated on `outcome`: `copied`, a `MethodCopied` with the copy as `method`, `examples_copied` and `stored_files_copied`, or `refused`, a `MethodCopyRefused` naming every `BundleStorageReference` of a `.mthds` file that names storage the destination cannot read, nothing written. Only a web session may copy. The `idempotencyKey`, held to a start's rule, is sent as the `Idempotency-Key` header, so a copy whose answer was lost can be sent again and makes one copy; the new `MethodCopyRequestOptions` type carries it (`docs/method-copy.md`).
- **The copies of a method**: `listMethodCopies(methodId, { limit, cursor })` reads `GET /v1/methods/{method_id}/copies`, a `MethodCopyPage` of the `MethodCopyMarker` rows the original keeps, each naming the copy, its destination by id alone, the member who made it and when, its `next_cursor` read as `nextCursor`.
- **`copied_from` on a method**: `MethodData`, and so every method read, gains `copied_from`, a `MethodCopiedFrom` naming the original organization, method and draft digest on a copy, `null` on a method created afresh and absent from a platform that predates copies.
- **The copy's codes**: `MethodErrorCode` gains `organization_not_found`, a destination the caller does not belong to or that does not exist, answered alike, and `method_copy_too_large`, a copy past its bounds on the stored files it copies, whose `problemDocument.limit` the new `MethodCopyLimit` type reads. `MethodCopyInput`, `MethodCopyOutcome`, `MethodCopyRefusalReason` and `ListMethodCopiesQuery` are exported with them.

## [v0.50.0] - 2026-10-23

### Added

- **One file read, renamed and linked**: `getFile(fileId, query)` reads `GET /v1/files/{file_id}`, a `FileDetail` holding the whole `FileRecord` (the row's fields with `source_uri`, `original_name`, `sha256`, `role` and `state`), the `method_ids` whose lists hold it and one page of its uses, paged by `usesLimit` and `usesCursor`; `getFilesByUri(uri, { runId })` reads `GET /v1/files/by-uri`, every record holding an address, the one a surface shows first; `renameFile(fileId, { name })` sends `PATCH /v1/files/{file_id}` and answers the record under the name the platform's rule saved; and `linkFiles(files)` sends `POST /v1/files/links` and answers one `FileLink` per file named by `file_id` or `uri`, in order, each a fifteen-minute link naming the file for its download or an `error`, a `200` either way, with every link hidden from the error of an answer the SDK cannot read (`docs/files.md`).
- **A zip of files**: `requestFileArchive(request)` asks `POST /v1/files/archives` for one zip of chosen `file_ids`, or of a `run_id`'s inputs and outputs, under an optional `name`, and answers the `FileArchive`, `queued`; `getFileArchive(archiveId)` reads it until its `state` is `ready`, with a fresh link to the zip, or `failed`, with its `failure`. A request naming both or neither of `file_ids` and `run_id` is refused with `RequestArgumentError` before sending, and a selection past a cap is a `422` `file_archive_too_large` whose `problemDocument.limit`, typed `FileArchiveLimit`, names the cap and how far over the selection is.
- **A run's files**: `listRunFiles(runId, query)` reads `GET /v1/runs/{run_id}/files`, a `RunFilesPage` of what went in, what came out, what was made along the way and the inputs given as web links, each entry with its `mark` and the `FileRecord` a surface shows, its `state` `listing` until every file of the run is recorded and its `next_cursor` read as `nextCursor`.
- **Adding a file to a method's draft**: `copyFileIntoDraft(methodId, { file_id, path, expected_updated_at })` sends `POST /v1/methods/{method_id}/draft/files/from-file`, which copies one of the organization's files into the draft at `path` without its bytes crossing the client, and answers a `DraftFileFromFileResult` discriminated on `blob`, `copied` or `already_held`, with the file as the tree names it and the method carrying the new draft token.
- **The build assistant's save**: `saveAssistantMethodExample(methodId, { name, inputs, example_id, input_revision })` sends `POST /v1/methods/{method_id}/examples/assistant-save`, which writes the inputs into the named example only while it is still the assistant's at the revision read, and otherwise saves them as a new example flagged as the assistant's, never writing over a person's edit, and answers a `MethodExampleAssistantSaveResult` discriminated on `outcome`, `kept` or `created`, with the example (`docs/method-examples.md`).
- **`describeUpload`, a file described for its upload grant**: `describeUpload(file, { filename?, maxBytes? })`, on `@pipelex/sdk/upload` and the main entry, reads a `File`'s or a `Blob`'s name, type and size and computes the SHA-256 of its bytes with Web Crypto, the description `requestUploadGrant` takes as is. It leaves the hash out, and the grant works as it does without one, for a file larger than `maxBytes`, 50 MiB by default, which it never reads, so that the grant route's `413` refuses it where the deployment's limit is no larger and a deployment with a larger `max_bytes` grants it without a hash, under a fresh name and with no deduplication, the description's missing `sha256` saying so, and where the runtime offers no Web Crypto digest, as on a page served over plain `http` from any host but the local one (`docs/input-preparation.md`).
- **The file's record on the upload answer**: `UploadedFile`, the answer of `upload` (`POST /v1/upload`), gains `file_id`, the record the platform wrote for the file, as a grant and `uploadWithGrant` now answer it; it is absent from a deployment that predates file records.
- **The upload grant request takes the file's hash and its kind**: `UploadGrantInput` gains `sha256`, with which the platform names the object after its bytes and holds the upload to them, and `kind` (`uploaded` or `test`) with `method_id` for a method's test file, as `UploadInput` takes them.

### Changed

- **An example carries `kept_by_assistant` (Breaking)**: `MethodExample` gains the required boolean `kept_by_assistant`, true on the example the build assistant keeps current and false from a person's first inputs edit, and every example the client hands back is checked to carry it, so an example answered without it, by a platform predating it, is an `ApiResponseError` of an answer the SDK cannot read, and code building a `MethodExample` by hand, such as a test fixture, adds the field.
- **The upload grant answers whether the bytes are already stored (Breaking)**: `UploadGrant` gains `file_id` and `stored`, both absent from a deployment that predates them, and its `url`, `headers` and `expires_at` are `null` when `stored` is true, the organization already holding those bytes, so code reading `grant.url` branches on `grant.stored` first. `uploadWithGrant` sends nothing for a stored grant, and resolves to `{ uri, file_id }` where it resolved to `{ uri }`, `file_id` present whenever the grant carried one.
- **`uploadWithGrant` reads a `412` as stored and sends a `409` again**: for a grant that names the file by its bytes, told by the `x-amz-checksum-sha256` it signs, storage's `412` means those bytes were stored there meanwhile, by another upload or by the platform's copy of a run's file, and resolves as stored with the grant's `uri` and `file_id`, while a grant asked for without a hash still meets `grant_used`; a `409 ConditionalRequestConflict` is sent again after short pauses, within the call's time limit, before it fails with `conflict`; and a `400 BadDigest`, bytes other than the hashed ones, is a `store_refused` that says so.

## [v0.49.0] - 2026-10-23

### Added

- **`listFiles` and `iterateFiles`, an organization's files**: `listFiles(query)` reads one page of `GET /v1/files`, a `FilePage` of `FileSummary` rows (`file_id`, `uri`, `name`, `media_type`, `format`, `size`, `kind`, `origin`, `created_at`, `created_by`), newest first, each `uri` taken by a run's inputs as any address, and `iterateFiles(query)` follows its cursor through filtered pages that come back short or empty. `ListFilesQuery` takes `q`, `kind`, `format` and `mediaType`, each of the last two sent as one repeated parameter per value and refused with `RequestArgumentError` when empty, `methodId`, `runId`, `createdBy`, `createdFrom`, `createdTo`, `limit` and `cursor`; `FileKind`, `FileOrigin`, `FilePage`, `FileSummary` and `ListFilesQuery` are exported (`docs/files.md`).
- **An upload recorded as a method's test file**: `UploadInput` gains `kind` (`uploaded` or `test`) and `method_id`, which `upload` sends to `POST /v1/upload`, `uploadFile` takes the same pair among its options, and `prepareInputs` takes it as its nested `upload` member for every file it uploads, each checked before any file is read, `kind: "test"` requiring a bare `method_id` and only a test file naming one. The upload route's refusals of a test file, a role that may not change methods, an unknown method or one being erased, are a `TestFileRefusedError` with a `code`, rather than a refused credential or a deployment without upload; `UploadKind`, `UploadKindOptions`, `TestFileRefusedError` and `TestFileRefusalCode` are exported.
- **An organization's branding, read and written**: `getBranding()` reads the active organization's name, light and dark colour sets and square and wide logos (`GET /v1/branding`), for any role and by API key too, and `updateOrganizationBranding(orgId, input)` is an admin's write of them (`PATCH /v1/organizations/{org_id}/branding`), where a key given a value is set, a key given `null` cleared and a key left out kept. Both answer an `OrganizationBranding`, whose logo `uri` is the platform's own copy under `branding/`, which sent back unchanged keeps the logo, with the exported types `BrandingColors`, `LogoDescriptor`, `OrganizationBrandingUpdate` and `BrandingColorsUpdate` (`docs/organization-branding.md`).
- **`LogoRefusalCode`, the codes of a refused logo**: a branding write that refuses a logo names its slot in `ApiResponseError.errors`, each entry's `field` being `square_logo` or `wide_logo`, its `code` one of the logo codes this type names, and its `detail` the sentence to show under that slot; a refused colour is named by its dotted key, such as `colors.action`.

## [v0.48.1] - 2026-10-22

### Fixed

- **The main entry bundles for the browser**: `@pipelex/sdk` bundles for a browser or edge target with nothing marked external, so a Next.js app whose client code imports it renders under `next dev`, where 0.48.0 made Turbopack panic on `node:fs` and answer `500`. Listing a `directory`, `writeMethodTree`, `downloadArtifacts`, reading a path string and the artifact fetch's dispatcher reach `node:fs/promises`, `node:path`, `undici` and the `mthds` package's lister through the package's own `#node-host` import, which resolves to them under the `node` condition and to nothing under a browser's, outside Node a `directory` and `writeMethodTree` are refused with `RequestArgumentError`, a `directory` before the version handshake. Inside Node, each of these refusals keeps its class and verdict but says what happened: in a bundle resolved without the `node` condition, that condition and how to bundle with it; in a toolchain that cannot load `#node-host` because it does not resolve the `imports` map of `package.json`, such as Jest before 29.4, that the host could not be loaded, with the import's own error as its `cause`.
- **The `.mthds` check hook keeps a method's secret files home**: the hook built by `npm run build:hook` screens every file of the method's tree before its validation sends anything, by the workshop's secret-guard rule, so a file whose name is a known secret file's or whose text holds a well-known key format, such as a `key.pem`, a `secrets.yaml` holding an API key or a cloud service-account export, no longer travels with the method, while a public `id_rsa.pub` or a prompt naming a private key's header in prose still does; since 0.48.0 the hook sent every file of the tree, and a `.gitignore` above the method's directory protects nothing in it. The method is validated without such a file, and the verdict comes with a note after its text, inside the block when the verdict is invalid, that names the first files kept home and counts the rest, each with why and never quoted, each path written so that no file name can break out of it; a validation that returns no verdict passes silently as before, with no note. When the file is a bundle or the `METHODS.toml` manifest, which every validation reads, nothing is sent and a non-blocking note says so in place of a verdict (`docs/hook-bundle.md`).

## [v0.48.0] - 2026-10-20

### Added

- **`directory`, a method's tree listed from disk**: `createMethod` and `writeDraft`, like the runs, `validate` and the crate routes, take the method's tree as `directory`, a directory on disk listed in Node by the `mthds` package's lister under the standard's membership rule and the deployment's limits, and send it as they send a `tree` (`docs/method-trees.md`).
- **`CrateRouteOptions`, a `signal` for the crate routes**: `resolve`, `codegen` and `pipeIo` take a second argument whose `signal` is read before each step a `directory`, `tree` or `contents` costs — the version handshake, the directory's listing, the blob route, each read and upload of a missing blob — and before the request, and handed to each of those steps, so an abort stops the one under way and starts nothing further, while the route's own request, once sent, runs to its end; `prepareInputs` passes its own `signal` there.
- **The files each validated step reads, typed**: `PipelexValidationReport` declares `tree_files_read`, mapping each validated step's `pipe_ref` to the files of the method's tree it reads, each a `TreeFileRead` with its `tree_path` and its `use`, a `TreeFileUse` (`template`, `template_asset` or `python_module`) read open so a use a later runner adds still type-checks, and `tree_file_readers`, mapping each of those files to the steps that read it. Both are optional, absent on a runner predating them, and `TreeFileRead` and `TreeFileUse` are exported (`docs/method-trees.md`).

### Changed

- **Runs and `validate` take the method's tree (Breaking)**: `execute`, `start` and `startAndWaitForResult`, its blocking fallback included, take the method as its tree in one of four forms, `directory`, `contents`, `tree` or `files`, sent as a save sends it, and lose `mthds_contents`, `bundle_b64` and `resources`, which a runner still reading them gets only through `extra`; a file a step reads, such as a `PipeDocGen` step's template, rides the tree at the path the step names. `validate(source, allowSignatures?, options?)` takes a `PipelexValidateSource`, exactly one of the tree, a `method_ref` or a `method_id`, with `render`, `views`, `timeoutMs` and `signal` in its `ValidateOptions`, so a call that passed inline texts, `mthds_sources` or positional `render` and `views` passes `{ files }` or `{ contents }` and the options object. Two forms of the tree, an empty `files`, `contents` or `tree`, a `method_ref` beside the tree and a suffixed `method_id` beside it are refused with `RequestArgumentError` before anything is listed or sent, and so are a `directory` that is not a string and a `tree` that is not a listed tree. A file of the tree that could not be uploaded throws `MethodFileTransferError`, and the run or the validation is then not sent. `startAndWaitForResult` prepares the tree once, under its `signal`, which stops the handshake, the listing, the blob route and the uploads under way so no run starts, and its fallback to the blocking execute sends the same files. A start whose body can be large, a tree, a `method_ref` or a bundle riding `extra` as `mthds_contents` or `bundle_b64`, gets the client's request ceiling rather than the 30-second start budget.
- **A method's tree travels by the `mthds` package's rule**: a `directory`, `tree` or `contents`, on a save as on every other call, travels by the rule the `mthds` package's `MthdsApiClient` follows: after the version handshake, inline when its map weighs no more than the lower of `INLINE_TREE_MAX_BYTES` and the announced `max_inline_bytes`, and otherwise by hash; to an API keeping no blob store it travels inline whatever its weight, and one past its `max_inline_bytes` is refused with `RequestArgumentError` before anything is sent, a tree whose files alone pass it before any file is read (`docs/method-trees.md`). The handshake is kept five minutes, and as `mthds` does, a `404` from the blob route or a `422` refusing the prepared tree's size drops it and sends once more on a fresh one, and a `422` `request.blobs_missing` naming blobs of the tree uploads them and sends once more; a start under an idempotency key is not sent again after a size refusal, the platform binding the key to it.
- **`methodTreeLimits` reads a handshake at most five minutes old**: the client keeps the handshake's answer five minutes for `methodTreeLimits` and every tree it sends, where it kept it for its lifetime, and asks again once it is older or a refusal shows it stale.
- **The `.mthds` check hook validates the method's tree**: the hook built by `npm run build:hook` sends the tree a run would send, the edited file's directory listed by the `mthds` package's lister and rooted at the nearest `METHODS.toml`, where it gathered the directory's `.mthds` files and the template files their steps name, so every file of the method reaches the dry run. It passes silently, as before when it cannot check, for a tree holding a symbolic link or a directory it cannot read, for an edited file the standard's rule keeps out of its tree, and past its caps of 100 files, 5 MiB for one file or 12 MiB in all, and the whole validation, the handshake, the blob route and the uploads included, runs under one ten-second deadline, past which it passes silently (`docs/hook-bundle.md`).
- **The `mthds` floor moves from `^0.32.1` to `^0.33.0` (Breaking)**: what this package re-exports from `mthds/protocol` follows it: `RunRequest` carries the method's tree as a `files` map and loses `mthds_contents` and `bundle_b64`, `assertOneMethodSource` and `hasMethodSource` replace `assertExclusiveRunSources` and `hasBundlePayload`, and `MethodTreeSource` and the protocol's file-entry types are exported.
- **The crate routes take the method's tree (Breaking)**: `resolve`, `codegen`, `pipeIo` and `prepareInputs` take the method as `files`, the MTHDS protocol's map from tree path to file entry, or as a `directory`, `tree` or `contents` sent inline or by hash as a save sends them, with `dependencies`, the method packages it calls by address, and `read_scope` beside it, which the hosted platform stamps itself and drops when a caller sends it (`docs/crate-routes.md`). An empty `files`, `contents` or `dependencies` map, and `files: null`, is absent and not sent, and a request carrying a `read_scope` asks `POST /v1/blobs/missing` under it, so its blobs land in the store its hash entries are read from. A file of the tree that could not be uploaded throws `MethodFileTransferError`, and the request is then not sent. `resources` is gone, a file a step reads riding the tree, and `MthdsFileItem` and the list of `{ content, source }` items are gone, so a call that sent `files: [{ content, source }]` sends `files: { [source]: content }`, a `prepareInputs` given the old list, a `contents` or `dependencies` that is not a map of what it holds, or a `tree` that is not a listed tree or holds no file throws `InputPreparationError` before any request, and `PipeIOValidReport.files` echoes a map from tree path to bundle text. A request whose `files` carry more than `INLINE_TREE_MAX_BYTES` inline gets the client's request ceiling rather than the 30-second static-route budget.

### Removed

- **`validateFiles`, `MthdsFile`, `ValidateFilesOptions`, `BundleResources` and `BundleResourceBytes` (Breaking)**: a method's files are validated by passing its tree to `validate`, and the files a step reads ride that tree, so the inline-file validator and the `resources` types are gone, with no alias.

## [v0.47.0] - 2026-10-20

### Added

- **A saved method's tree, saved by hash**: `createMethod` and `writeDraft` take the method's tree as `files`, the MTHDS standard's map of file entries sent as given, as `tree`, any `MethodTreeSource` such as the `MethodTree` the `mthds` package's `listMethodTree` lists from a directory, or as `contents`, each file's bytes or text by tree path; the last two travel inline when their map weighs `INLINE_TREE_MAX_BYTES` or less, and otherwise by hash, after `POST /v1/blobs/missing` names the files the organization lacks and the client uploads those once, each checked against the tree's listing first, so a large method saves in a small request (`docs/method-trees.md`). A tree holding no file is refused before any request, and an answer asking for a blob the tree does not hold is an `ApiResponseError` of an answer the SDK cannot read.
- **A saved method's tree, read and written to disk**: `getMethod` answers a `MethodDetail` and `getMethodVersion` a `MethodVersion` whose `files` list the tree, each `SavedMethodFile` with its `path`, `sha256`, `size` and a link to its bytes valid for about fifteen minutes, and `writeMethodTree(files, { destination })`, in Node, downloads them with no credential of the client, checks each against its size and SHA-256, and writes the tree into a fresh directory that takes its name only once complete. An answer of these routes the SDK cannot read, a `sha256` that is not 64 lower-case hex digits among them, reaches its `ApiResponseError` with every link redacted in `responseBody` and no `cause`, a link being a bearer credential.
- **`methodTreeLimits`**: the limits the deployment announces for a method's tree in its version handshake, in the shape `listMethodTree` takes as its `limits` option, so a tree the platform would refuse is refused while it is listed. The client asks for the handshake once and keeps its answer for `methodTreeLimits` and every save by hash.
- **`requestTimeoutMs`**: a `PipelexApiClient` option setting the client's request ceiling, twenty minutes by default as before: the time limit of a request given no `timeoutMs` of its own, the blocking `execute` and a save carrying a method's tree among them, since a tree sent inline to a platform with no blob store has no size bound, and of each upload before a save and each download by `writeMethodTree`, which it bounds whole, the body included.
- **`MethodFileTransferError`**: thrown when a file of a method's tree could not be uploaded before a save or downloaded by `writeMethodTree`, with its `operation`, a `code` (`unreachable`, `storage_error`, `refused` or `mismatch`) deciding whether it is retryable, the file's `sha256` and `path`, and storage's `status`, and never the link, which is a bearer credential, nor a `cause`.
- **`RunDetail.tree_digest` and `RunDetail.crate_fingerprint`**: the digest of the method tree a run sent and the crate the runner loaded it into, each `null` for a run that recorded none.

### Changed

- **A saved method is a tree, and its source fields are gone (Breaking)**: `MethodData`, `MethodVersion`, `MethodWriteInput` and `MethodDraftInput` lose `mthds` and `python`, and `MethodVersionSummary.source_digest` is now `tree_digest`, so code reading a method's source reads its `files` instead, and a draft is unchanged since its latest version when `draft_digest` is not `null` and equals `latest_published.tree_digest`. `draft_digest` is the draft's tree digest, `sha256:` and 64 hex digits, and `null` for an empty draft. A stored method or version whose `files` is not a listing is an `ApiResponseError`, and `getMethodVersion` answers a version stored before methods were trees with a `409` whose verdict is `runtime`.
- **`writeDraft` replaces the whole tree (Breaking)**: a draft write always sends `files` and refuses a `MethodDraftInput` that gives the tree in no form, so keeping the stored files means sending them again; `files: null` empties the draft.

### Removed

- **The catalog-source readers (Breaking)**: `methodSourceToContents`, `getMethodClosure` and `EmptyMethodSourceError` are gone with the fields they read; a method's files come back as `MethodDetail.files`, and `writeMethodTree` puts them on disk.

## [v0.46.1] - 2026-10-19

### Changed

- **The `.mthds` check hook's lint engine moves to `@pipelex/tools-wasm` 0.6.0**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.6.0, whose MTHDS schema follows pipelex v0.87.0 and holds a `PipeFunc`'s `function_name` to the function's import path from the root of the method tree, such as `funcs.totals.compute_totals`, so the hook now blocks with a schema error a `function_name` holding no dot or an empty segment, such as a bare `capitalize`, `funcs..compute_totals` or `funcs.`, and accepts no form it blocked before.

## [v0.46.0] - 2026-10-19

### Added

- **`ApiResponseError.problem`, the standard's reading of the answer**: every `ApiResponseError` now also carries the same answer as the MTHDS standard reads it, typed as the standard's `Problem` and equal to the problem `mthds`'s own `ApiResponseError` carries, so a caller handling both clients branches on `problem.code`, except that on `start` and `execute` `runMayHaveStarted` decides: `client.outcome_unknown`, naming the run when the body names one, wherever a run may have started, even when the body is a core problem document, which a runner inviting a retry would otherwise have the error carry beside `runMayHaveStarted: true`, and the reading of an answer to a request that creates no run wherever none did. The hosted members read exactly as before, and the platform's `code` and `errors` stay on the error, apart from the registry's `problem.code` and the problem items of `problem.errors` (`docs/errors.md`).

### Changed

- **`ApiResponseErrorOptions.problem` is now `details` (Breaking)**: an `ApiResponseError` built by hand passes the hosted problem document's typed members as `details`, and may pass the answer's `headers`, from which the standard's reading takes a `Retry-After`.
- **The validate verdict's types stand alone (Breaking)**: `PipelexValidationReport` and `PipelexInvalidReport` no longer extend the standard's `ValidationReport` and `InvalidValidationReport`, which list problem items since protocol 2.0.0 while the hosted plane still sends `validation_errors`, so `PipelexApiClient` implements `MTHDSProtocol` for every route but `validate`, and a `PipelexValidationResult` is no longer assignable to the standard's `ValidationResult`. `ValidationErrorItem` and `SuggestedFix` keep the hosted shape, no longer pinned to the standard's, whose fix shares only its operation kinds, safeties and values.
- **`errorVerdictOf` reads an `mthds` error by its problem, and `problemVerdict` translates the standard's verdict**: the standard's client now carries its verdict on its problem, as `domain` and `retry`, so `errorVerdictOf` reads an `mthds` error as that problem's verdict in this SDK's vocabulary rather than from the `error_domain` and `retryable` a runner sent: `input` and `method` read as `input`, `account` and `operator` as `config`, `runtime` as `runtime`, and only a `retry` of `yes` is retryable. `problemVerdict` applies the same mapping to any problem of the standard.
- **The `mthds` floor moves from `^0.30.0` to `^0.32.1` (Breaking)**: `mthds` 0.32.1 is the release that reads every answer as a problem document coded from the MTHDS core error registry 8.0.0 and moves the protocol to 2.0.0, the reading this SDK's errors and verdicts now follow. What this package re-exports from `mthds/protocol` follows it: `ValidationError` is gone, the standard's `ValidationReport`, `InvalidValidationReport` and `ValidationResult` list `ProblemItem`s in `errors`, `ConceptAbstract` keeps only `code` and `domain_code`, and the standard's problem types and readers, `Problem` and `readAnswer` among them, are exported beside them. A project that also imports `mthds` itself moves to 0.32 with it, so that one copy is installed; 0.32.1 is published under the `maint-0.32` dist-tag, so install it as `mthds@^0.32.1`, since `latest` names a release outside this range.

### Fixed

- **A body the protocol refuses as JSON is an answer the SDK cannot read**: a `2xx` body nested deeper than `MAX_BODY_NESTING`, or holding a number past the range of a double, which `JSON.parse` reads as `Infinity`, throws the `ApiResponseError` of an answer the SDK cannot read, an answer read exactly such as a run's results included, and a refusal whose body is such JSON carries no hosted member, as `pipelex-sdk` reads both.

## [v0.45.0] - 2026-10-16

### Changed

- **`Membership.role_in_org` reads the `runner` role, and any later role, open (Breaking)**: the role is the newly exported `OrgRole` (`admin`, `member` or `runner`), or the raw string of a role a later platform adds, so a `switch` over a membership's role that assumed two roles needs a branch for `runner` and one for a string it does not know.

## [v0.44.0] - 2026-10-14

### Added

- **A run's progress, `getRunProgress`**: reads the run's progress snapshot on the hosted API's `GET /v1/runs/{id}/progress` and returns it as `RunProgress`: the run's `status`, a `version` and an `assembled_at` to compare snapshots by, a one-line `summary`, the status read's `degradation` when the run reads degraded, and every invocation of a pipe in the run as a `ProgressInvocation`, named by its path, with its status, its times, a batch's counts, a condition's outcome and the health annotations `attempts`, `last_failure` and `degradation`, the last reusing `RunDegradation`. A snapshot missing a member the freshness rule or a timeline leans on is an `ApiResponseError`, and a server without the route a `RunLifecycleUnavailableError` (`docs/run-results.md`).
- **`onProgress` on `waitForResult` and `startAndWaitForResult`**: given, each poll that finds the run still running also reads the progress route and calls `onProgress` with the snapshot when it is fresher than the last one delivered, so a caller can show the run advancing while it waits. A failed progress read skips that poll's snapshot and never fails the wait, a server without the route is not asked again during the wait, and without `onProgress` no progress request is made.
- **`isFresherRunProgress`**: says whether a snapshot just read should replace the one held, by the platform's rule: a snapshot of the run still going never replaces one of the run ended, then the higher `version`, then at the same version the later `assembled_at`, compared as instants. `onProgress` delivers by it, and a caller reading the route itself keeps the fresher by it.

### Removed

- **`PipeStatus` and `PipelineRun.pipe_statuses` (Breaking)**: the hosted API never sent a per-pipe status map on a run record, so the field and its type are gone; a run's per-invocation progress is the snapshot `getRunProgress` reads.

## [v0.43.0] - 2026-10-13

### Added

- **A method's saved examples**: `createMethodExample`, `listMethodExamples`, `iterateMethodExamples`, `getMethodExample`, `updateMethodExample`, `recordMethodExampleLatestRun` and `deleteMethodExample` read and write the named sets of inputs saved on a method, on the hosted API's `/v1/methods/{id}/examples` routes, with the `MethodExample` type and its input types, `MethodExamplePage` and `ListMethodExamplesQuery`. An edit of the inputs raises `input_revision` and clears `latest_run_id`; the list is paged oldest first, and `iterateMethodExamples` follows its cursor through the loop the other iterators share. An example id that is empty, `.` or `..`, a create without its `name` or `inputs` or whose `run_id` is given but empty (a `null` one reads as not given and is not sent), an edit naming neither `name` nor `inputs`, and a latest-run write without a run id or a positive integer revision are a `RequestArgumentError` before any request, a method id `iterateMethodExamples` cannot take one at the call itself, and every example the client hands back, the page rows and the verdict's included, is checked against the fields the Python SDK's model requires, with the strict types it holds them to, `latest_run_id` among them, one breaking them being an `ApiResponseError` (`docs/method-examples.md`).
- **The latest-run verdict**: `recordMethodExampleLatestRun` records a run against the revision whose inputs it used and answers a `MethodExampleLatestRunResult` discriminated on `outcome` (`MethodExampleLatestRunOutcome`), `recorded` or `stale`, each arm carrying the `example` as it stands, so a run that outlasted an edit of the inputs is a verdict to branch on rather than a thrown error.
- **Exact integers, `parseExactJson`, `stringifyExactJson` and `ExactJsonUnsupportedError`**: an integer past `Number.MAX_SAFE_INTEGER` in an example's inputs, which another client may have saved, reads as a `bigint` holding its exact digits on every example route, and every request body is written with a `bigint` as those digits, so such inputs go back unchanged to `updateMethodExample` or as a run's inputs instead of rounded; a float with no fractional part, `3.0`, still reads as `3`, so inputs holding one sent back unchanged to `updateMethodExample` raise the revision, since the platform compares inputs as canonical JSON. Both functions are exported, for a caller showing such data as JSON text, which `JSON.stringify` refuses for a `bigint`. On a runtime whose `JSON.parse` hands a reviver no source text, the reader refuses such an integer with `ExactJsonUnsupportedError`, which the client reports as an `ApiResponseError` for an answer it cannot read, rather than round it (`docs/exact-integers.md`).

### Changed

- **A run's inputs and outputs keep integers past `Number.MAX_SAFE_INTEGER` exact (Breaking)**: `getRunDetail`'s inputs, a completed run's results as `getRunResult`, `waitForResult` and `startAndWaitForResult` answer them (`main_stuff`, `working_memory`, `graph_spec` and every other field of the answer), and the answer of `execute` read such an integer as a `bigint` holding its exact digits instead of a rounded double, so inputs or an output passed back to `start`, or saved as an example's inputs, keep every digit. `graph_spec` is read exactly too, so a graph handed to a renderer can now carry a `bigint`. `JSON.stringify` throws on a `bigint`, so code showing such data as JSON text writes it with `stringifyExactJson`; the `pipelex-sdk` command prints it with its digits. The run status read and the run history read as before (`docs/exact-integers.md`).

### Fixed

- **An id a route puts in its path is refused when the URL would resolve it**: a method id given to `getMethod`, `writeDraft`, `renameMethod`, `publishMethod`, `listMethodVersions`, `getMethodVersion` or `deleteMethod`, a run id given to `getRunStatus`, `getRunResult`, `getRunDetail` or `updateRun`, an organization id given to `renameOrganization` and an API key id given to `revokePipelexApiKey` or `rotatePipelexApiKey` that is empty, `.` or `..` is now a `RequestArgumentError` before any request, as is one that is not a string and one holding a lone surrogate, for which `encodeURIComponent` threw a bare `URIError`. `encodeURIComponent` leaves the dot alone, so `.` and `..` reached the URL as dot segments, which the URL resolves before the request leaves: `getRunDetail("..")` read `GET /v1/`, `deleteMethod(".")` sent `DELETE /v1/methods/`, and an empty id addressed the route above it, `getRunDetail("")` sending `GET /v1/runs/`. Every one of these ids now goes through one guard.
- **`getMethodVersion` refuses every version it cannot take with `RequestArgumentError`**: a version that is not a number is named by its type in the refusal, where one with no prototype, `Object.create(null)`, made the refusal itself throw a `TypeError`.
- **A request body JSON cannot carry is the caller's argument, not a network failure**: a body holding a cycle, or a `bigint`, was refused by `JSON.stringify` inside the request and thrown as `ApiUnreachableError`, with `runMayHaveStarted` true on `start` and `execute`, though nothing had been sent. The body is now written before the request is made, a `bigint` as its exact digits, and one that cannot be written is a `RequestArgumentError` with the failure as its `cause`.
- **A `bigint` in a request body is sent as its digits under a `BigInt.prototype.toJSON` polyfill**: with the common polyfill `BigInt.prototype.toJSON = function () { return this.toString(); }` installed, `JSON.stringify` wrote a `bigint` in a request body as a quoted string, so the platform received text where the caller sent a number. Every request body is now written by `stringifyExactJson` in one `JSON.stringify` call whose replacer writes each `bigint` as its exact digits, the polyfill passed over, so each getter and `toJSON` in the body still runs once and an error one of them throws reaches the `RequestArgumentError` as its `cause`, never retried (`docs/exact-integers.md`).

## [v0.42.0] - 2026-10-13

### Added

- **An idempotency key on a run start**: `start` and `startAndWaitForResult` take `idempotencyKey` (declared by the new `PipelexStartRequestOptions`, part of `PipelexStartOptions`), sent as the `Idempotency-Key` header of `POST /v1/start` and never in the body, and with no key there is no header. The hosted API binds the key to the run it starts and answers the same start sent again under it with that run, so a caller whose start failed with `runMayHaveStarted` recovers the run by sending the same start again under the same key instead of risking a second run. A key that is not 1 to 255 visible ASCII characters is a `RequestArgumentError` before any request, the blocking `execute` fallback of `startAndWaitForResult` sends none, and a bare runner ignores it (`docs/errors.md`).
- **`IdempotencyErrorCode`**: the type naming the code `idempotency_key_in_use`, which the hosted API sends on a `409` when an earlier start under the same key is still being handled.

### Changed

- **The fallback verdict of a `409` with the code `idempotency_key_in_use`**: it is `runtime` and retryable, since the earlier request releases the key by finishing; every other `409` the table does not name stays `input` and not retryable.

## [v0.41.0] - 2026-10-13

### Added

- **The methods list's publish state and `published` filter**: `MethodSummary` carries `latest_version`, `latest_published` (a `MethodVersionSummary`) and `draft_digest`, each optional and `null` when it does not apply, `draft_digest` being `null` on a row that never stored one until its next draft write, so a list tells a never-published method, one whose draft matches its latest version and one whose draft is ahead apart without reading each method. `listMethods` and `iterateMethods` take `published`, sent as `published=true` or `published=false` only when given.
- **The run history's `createdBy` and `status` filters**: `listRuns` and `iterateRuns` take `createdBy: "me"`, sent as `created_by=me`, which keeps the caller's own runs, and `status`, a list of `RunStatus` sent as one repeated `status=` parameter per status in the platform's order, which keeps the runs in any of them; an empty `status` list or a name that is no `RunStatus` is a `RequestArgumentError` before any request. Under these filters, as under `q` and `published` on the methods list, a page can come back empty and still carry a `nextCursor`, and only a `null` cursor ends the list.

### Changed

- **`iterateRuns` follows the cursor through an empty page**: it stopped at the first empty page, which under the new filters is not the end of the history, and now runs the same loop as `iterateMethods`, following the cursor until it is `null` or stops advancing and throwing `PagingNotTerminatingError` past the same page ceiling.

## [v0.40.0] - 2026-10-12

### Added

- **`resources` on the routes that load a bundle sent as content**: `execute`, `start` and `startAndWaitForResult` (its blocking fallback included), `pipeIo`, `resolve`, `codegen` and `prepareInputs` with inline `files` take `resources`, and `validate` and `validateFiles` take it in their options (the new `ValidateOptions` for `validate`), the files a bundle's steps read, such as a `PipeDocGen` step's `template_file`, keyed by the path the step names, each as its bytes (`Uint8Array`, `ArrayBuffer` or `Blob`, typed `BundleResources`), and send them base64-encoded, so a bundle that fills a Word, Excel, PowerPoint or HTML template validates and runs without a local pipelex. A key that cannot name a file inside the bundle, two keys naming one file, a value that is not bytes, a `resources` that is not a plain object (a `Map` included), `resources` beside a `method_ref`, or on a run with no source for them to accompany, is a `RequestArgumentError` before any request, `resources` beside a `method_ref` or a `method_id` in `prepareInputs` an `InputPreparationError`, and `resources` is now a reserved key of `extra`. A crate route or `prepareInputs` call carrying them gets the 20-minute execute ceiling `start` and `validate` give them, since their upload can outlast the 30-second default (`docs/bundle-resources.md`).
- **The template check's locators on a validation item**: `ValidationErrorItem` declares `template_file` and `template_location`, which a `template_check_warning` item in the `validate` verdict's `warnings` carries to name the template file a `PipeDocGen` step fills and the place in it the warning concerns, each `null` when unknown.
- **The `.mthds` check hook sends a bundle's template files**: the hook built by `npm run build:hook` sends, with the `.mthds` files it validates, the template files their `PipeDocGen` steps name, each read beside the file whose step names it, so a bundle that fills a template is no longer blocked for a template file the API was never sent, and its template is checked by the dry run (`docs/hook-bundle.md`).
- **`inputFormFault`**: returns the first fault of one pipe's input-form entry, as `{ path, problem, message }` with `path` in the descriptor's own terms (`fields[3].item`), or `undefined` when `prepareInputs` can walk it, for a caller that reads an entry itself to render a form or a template (`docs/input-preparation.md`).

### Changed

- **`InvalidInputValueError` names the input (Breaking)**: the error carries `inputName` and `inputPath`, as `UploadNotAllowedError` does, and its constructor takes them as a details argument, `new InvalidInputValueError(message, { inputName, inputPath }, options?)`. Its message names the position and describes the value by its kind (`Input "dossier.attachments[1]" holds a number, which no file input takes: …`), a malformed `data:` URL's message no longer quotes the URL, and under `allowUploads: false` the message offers only the two forms that pass, an `http(s)` URL or a `pipelex-storage://` reference.

### Fixed

- **`prepareInputs` refuses a malformed input-form descriptor**: a pipe I/O answer whose descriptor for the selected pipe is malformed where preparation reads it (an entry that is not an object, a `fields` that is not a list, a field with no string `name`, a node with no string `kind`, an `object` node with no list of `fields`, a `list` node whose `item` is not a node) or names a `kind` outside the standard's vocabulary is an `InputPreparationError` with a `runtime` verdict, not retryable, naming the pipe and where in the descriptor the fault sits, checked whole before anything is uploaded, as the Python twin refuses it. It threw a bare `TypeError`, or, for a field with no name or an unknown kind, passed the caller's value through untouched, a local path at a file position included. The vocabulary is the walk's own, so a newer `mthds` installed beside the SDK cannot widen it.
- **`pipelex-sdk run --inputs-template` and `pipelex-sdk script` refuse a malformed input form**: a pipe I/O answer whose input form for the selected pipe is malformed where input preparation or the template reads it, or names a kind the SDK does not know, prints `Error: the API's pipe I/O answer describes the pipe it selected with a malformed input form.` and exits 1, the Python command's sentence. `--inputs-template` failed with an unexpected `TypeError`, or, for a field with no name, printed a template under a made-up key and exited 0, and `script` wrote the script.

## [v0.39.0] - 2026-10-12

### Added

- **`runMayHaveStarted` and `runMayHaveStartedOf`**: every SDK error carries `runMayHaveStarted`, `true` when a failed `start` or blocking `execute`, the ones `startAndWaitForResult` sends included, may have created a run whose id never reached the caller, and `false` otherwise; `runMayHaveStartedOf` reads it from anything a `catch` holds. It is `true` for an answer the SDK could not read, a `408`, every `5xx` but a `501` and the platform's `503` coded `pipeline_start_unavailable`, a transport failure that does not prove the request never left, and `PipelineExecuteTimeoutError`, whatever the timing (`docs/errors.md`).
- **`RunRead.degradation` and `DegradationReason`**: `getRunStatus` types the `degradation` the platform sends with `degraded`, as `RunDegradation` (`reason`, `message`, `failed_attempts`, `failing_since`, `ends_at`), each field checked so a malformed one never fails the poll. `degraded` no longer means only that the platform could not reach the workflow engine (`status_unavailable`): `workflow_task_failing` means the run is stuck and the platform ends it `FAILED` at `ends_at`, so code that branches on `degraded` now reads `degradation.reason` as well (`docs/run-results.md`).
- **`request_id` on a run**: `RunRead.request_id` and `RunDetail.request_id` type the id of the request that started the run, the one to quote to support.
- **`prepareInputs` without uploads**: `allowUploads: false` makes `prepareInputs` refuse every value at a file input that would need an upload — a local path, a `data:` URL, bytes — with the new `UploadNotAllowedError`, which names the input (`inputName`), where inside it the value sits (`inputPath`, such as `dossier.attachments[1]`) and what it is (`valueKind`: `local_path`, `data_url` or `bytes`), before anything is read from disk, decoded or uploaded; `http(s)` URLs and `pipelex-storage://` references pass through as before. A server preparing inputs on a caller's behalf uses it to never read a file of its own because the caller named it (`docs/input-preparation.md`).

### Changed

- **A run that may have started is not retryable (Breaking)**: on an error whose `runMayHaveStarted` is `true`, `retryable` is `false`, whatever the problem document sent and whatever the status says, so a caller that retries on `retryable` alone no longer starts a second paid run; `errorDomain` is unchanged and the server's members stay on `problemDocument`. A `start` or `execute` answered with a `500`, a `502`, an uncoded `503`, a `504` or a `408`, or cut off once the request had left, was retryable and no longer is.
- **The command's "a run may have started" line follows the SDK**: `pipelex-sdk run` prints it when the failed request's error says `runMayHaveStarted`, so it now prints it for a `500`, a `503` without the platform's `pipeline_start_unavailable` code however soon it came, and a `408`, and no longer times the start itself.
- **A failed run's report is documented as the platform's STRICT projection**: the doc comments of `RunErrorReport`, `ProviderErrorMetadata`, `RunFailedError`, the run records' `error` and `RunDegradation.message`, with `docs/errors.md`, `docs/run-results.md` and the README, now say what the hosted platform serves, where they said it served the runner's VERBOSE report: `message` and `user_action` are the author's only when `caller_facing_message` is `true` and the placeholder `An internal error occurred.` otherwise, `provider_metadata` keeps only `status_code` and `retry_after_seconds`, `model`, `provider` and `migration` are absent, and a `workflow_task_failing` degradation's `message` does not quote the worker's failure. They also say that a cancelled, terminated or timed-out run holds a report when a completion callback carried one, and a timed-out run otherwise the platform's timeout report, and `ApiResponseError.providerMetadata` says that the hosted runner's problem documents carry only `status_code` and `retry_after_seconds`, the whole of it coming only from a runner that discloses errors VERBOSE; the types are unchanged.
- **The `.mthds` check hook's lint engine moves to `@pipelex/tools-wasm` 0.5.0**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.5.0, whose MTHDS schema follows the reworked `PipeJudge` and holds stored names to the plain input-name form, so the hook no longer blocks a `PipeJudge` that carries a `prompt` beside its `question`, asks several named questions in a `questions` table, or gives its `levels` as `{ label, description }` tables, and now blocks with a schema error a `PipeJudge` that does not carry both a `prompt` and a `question` or `questions` table, which is every judge the previous engine accepted, a judge's `criteria` table missing its `yes` or its `no` side, and a `result` or `batch_as` on a `PipeSequence` step or a `PipeParallel` branch, or an `input_item_name` on a `PipeBatch`, that is not a plain input name, such as `ShoppingList` or `round.parcel`.

### Fixed

- **`start` and `execute` refuse an answer that is not the run they created**: a `start` acknowledgement whose `pipeline_run_id` is not a string or is empty, an `execute` `202` whose body is not JSON or names no run (an empty id included), and an `execute` `2xx` that is not the completed run (no string `pipeline_run_id`, or a `pipe_output` without its `pipeline_run_id` or its `working_memory` with `root` and `aliases`) are each an `ApiResponseError` the SDK could not read, `runtime`, not retryable and `runMayHaveStarted`, as the Python twin raises them. The acknowledgement was returned naming no run, the `202` was a retryable `RunStillRunningError` with an empty `runId`, and the incomplete result failed later with a bare `TypeError` or a `MissingMainStuffError`.

## [v0.38.0] - 2026-10-10

### Fixed

- **`js/`'s lockfile installs under npm 10**: `package-lock.json` is a valid install tree again, so `npm ci` in `js/` installs it under the npm that Node 22 bundles, where it stopped with `EUSAGE` because vite 8's optional `esbuild` peer could not share the `esbuild` 0.25 the package pinned; `esbuild` moves to 0.28, which the hook bundle built by `npm run build:hook` is now built with. `make install` installs from the lockfile with `npm ci` and no longer rewrites it, `make use-local` no longer rewrites the `mthds-js` checkout's lockfile either, and `make check` runs a new `make check-lock`, which refuses a lockfile whose tree `npm ls` calls invalid and names the dependency at fault.

## [v0.37.0] - 2026-10-09

### Changed

- **The `pipelex-sdk` command names `~/.pipelex/.env`**: its help and its missing-key error say that the key `pipelex login` saves in `~/.pipelex/.env`, or under `PIPELEX_HOME` when that is set, is not read, and how to load it into the shell, `set -a; . "${PIPELEX_HOME:-$HOME/.pipelex}/.env"; set +a`, word for word as the Python command says it.

## [v0.36.0] - 2026-10-09

### Changed

- **A refused artifact selection is a `RequestArgumentError` (Breaking)**: `getRunResult`, `waitForResult` and `startAndWaitForResult` throw a `RequestArgumentError`, `input` and not retryable, for an `artifacts` selection that is empty or names an unknown artifact, where they threw a `RangeError` carrying no verdict, as the Python twin raises it; a value that is not an array is a `TypeError`.

### Fixed

- **The command names what it could not read**: under `Error: the API's answer could not be read (status <n>).`, the `pipelex-sdk` command's `Reason:` line is the SDK's message, naming the route and what could not be read (`API POST /v1/start answered 202 with a body that is not JSON`), where it said that the answer gives no reason.

## [v0.35.1] - 2026-10-08

### Added

- **`MethodData.deletion_state`**: a method read types the optional `deletion_state` the platform lists among the method's fields, `pending`, `in_progress` or `failed` once its erasure has started, as `MethodSummary` and the Python twin already type it.

### Changed

- **A suffixed `method_id` beside an inline source is refused locally**: `execute`, `start` and `startAndWaitForResult` throw a `RequestArgumentError` before the run request is sent for a `method_id` carrying a version suffix (`mt_…@3`, `mt_…@draft`) beside a non-empty `mthds_contents`, `files` or `bundle_b64`, where the id is run-history linkage and the platform answers a `422`. Send the bare id, or drop the inline source to run the version the selector names.

### Fixed

- **The method and error docs match the platform's contract**: `ListMethodVersionsQuery.limit` says a `limit` outside 1 to 100 is a `422` rather than capped; `writeDraft` and `createMethod` say their `413` comes for a method that would leave no room for a publish, below the store's item limit; the run and tooling `method_id` docs describe version selectors and the `409` `method_not_published` of a bare id never published; and the error docs say a client of the platform may branch on `code`, which reads the same answer as `type` there, while a refusal the platform relays from the runner carries no `code`.

## [v0.35.0] - 2026-10-08

### Added

- **The `pipelex-sdk` command reads a catalog id's version suffix**: `run --method` and `script --method` take `mt_…@<n>` and `mt_…@draft` beside a bare `mt_…` and send the suffix whole, and a suffix that is neither a positive number without a leading zero nor `draft` is a usage error made before any request, as `parseMethodSelector` reads it. `script` reads the method's name by its bare id and keeps the suffix in the script it writes. `docs/cli.md` describes it.
- **Publishing a saved method: `publishMethod`, `listMethodVersions` and `getMethodVersion`**: `publishMethod(methodId, { expected_draft_updated_at })` publishes the draft the caller last saw as the method's next immutable version and answers a `MethodPublishResult` discriminated on `outcome`: `published` with the new version, `unchanged` when the draft's digest equals the latest version's, or `refused` with a `reason`, a `message` and the runner's validation verdict. `listMethodVersions` pages a method's versions newest first and `getMethodVersion` reads one with its sources. `docs/architecture.md` describes the model.
- **`parseMethodSelector`**: splits a method selector, `mt_…`, `mt_…@<n>` or `mt_…@draft`, into its bare id and the version it names (a number, `"draft"` or `null` for the latest published version), and refuses a malformed suffix with a `RequestArgumentError` before anything is sent, for a caller that reads by its bare id the method a pinned id names.
- **Which version a run ran**: every run record (`RunPublic`, `RunRead`, `PipelineRun`, `RunDetail`, `RunHistoryItem`) carries an optional `method_version`, a number, `"draft"` or `null` for an inline source, and `source_digest`, the digest of what ran; the start acknowledgement and the blocking execute result carry `method_version` for a `method_id` run. A platform that does not record them yet leaves them absent. `listRuns` and `iterateRuns` take the bare id, under which the history lists the runs of every version and of the draft together.
- **`MethodErrorCode`**: names the platform codes a method caller branches on in `ApiResponseError.code`: `method_update_conflict`, `method_being_deleted`, and the new `method_not_published`, a bare id of a method never published, and `method_version_not_found`, a version the method never published.

### Changed

- **A saved method has a draft and published versions, and `updateMethod` is replaced by `writeDraft` and `renameMethod` (Breaking)**: the whole-method `PUT` is gone. `writeDraft(methodId, { mthds, python?, input_data?, expected_updated_at? })` replaces the draft without validating it, and with `expected_updated_at` refuses a draft that moved since with a `409` `method_update_conflict`, writing nothing; `renameMethod(methodId, { name })` changes the name alone. `MethodData` gains the required `draft_digest`, `latest_version` and `latest_published`, its `updated_at` is the draft's token, moved by a draft write only, and `getMethodClosure` reads the draft, which a bare id no longer runs once the method is published. The method calls take a bare id, refusing a suffixed one with a `RequestArgumentError` before anything is sent.
- **The script `pipelex-sdk script` writes**: its line now runs `exec npx --yes --no-update-notifier --loglevel=warn @pipelex/sdk@X.Y.Z run …`, so the script's stderr carries the command's own lines without npm's update notice, which npm 10 and 11 print wherever their cache starts empty, or the `npm notice run …` lines npm 12 prints at every run; npm's warnings and errors still print. A script written before keeps its line, and takes the same quiet by adding the two flags after `--yes`.

## [v0.34.1] - 2026-10-08

### Added

- **`checkModelReference`**: `client.checkModelReference(reference, category?)` asks the runner whether one model reference resolves, as what kind and to which model (`GET /v1/models/check`, served by `pipelex-api` from pipelex 0.78.0 and on the hosted API), and returns the typed `ModelReferenceVerdict`, whose `kind` narrows its `matches`; a reference that resolves nowhere is a `not_found` verdict carrying the names the caller may have meant, and one the runner cannot read is an `ApiResponseError` whose `errorType` is `InvalidModelReference` or `InvalidModelCategory`. `docs/architecture.md` describes it.

## [v0.34.0] - 2026-10-08

### Highlights

**A method runs from the shell, with no project around it.** `npx @pipelex/sdk run` runs a method on the hosted API through the SDK's durable run lifecycle and prints its main output as JSON, and `npx @pipelex/sdk script` writes a shell script that runs it with this version pinned. `pipelex-sdk` on PyPI ships the same command, and both are held to one recorded table of cases.

### Added

- **`isGatewayCutOff`**: the rule the blocking `execute` applies to tell the hosted gateway's ~30-second cut-off from a refusal is now exported, as `isGatewayCutOff(error, elapsedMs)`: a `503` or `504` answer, or the client's own time limit (`ABORT_TIMEOUT`), at least ~28 seconds after the request was sent. A caller timing its own start, from `startAndWaitForResult`'s `onStarting` for one, reads it to learn that a start the gateway gave up on may still create the run, as the `pipelex-sdk` command does. `docs/errors.md` describes it.
- **`signal` on `prepareInputs` and `uploadFile`**: the request of `prepareInputs` takes an optional `signal`, which stops the preparation between its steps, a file's read and its upload included: once it has aborted, neither the pipe I/O request nor any upload starts, and `prepareInputs` throws the abort. `uploadFile`'s options take the same `signal`, read once the file's bytes are in hand, right before the upload request. A request already sent runs to its end. `docs/input-preparation.md` describes it.
- **`filename` on every upload failure**: `UploadAuthenticationError`, `UnsupportedUploadCapabilityError` and `UploadTransportError` now carry `filename`, the file `uploadFile` was sending, as `RejectedAssetError` already did, so a consumer preparing several files says which one failed without parsing the message. `uploadWithGrant` leaves it undefined.
- **`InvalidInputValueError` and `MethodLoadError`**: `prepareInputs` now tells the inputs' own mistakes from a method that does not load by class. A `data:` URL at a file input that does not decode, and a value of a type no file input takes, throw `InvalidInputValueError`, where they threw a plain `InputPreparationError`; a pipe I/O answer saying the method does not load (`is_valid: false`) throws `MethodLoadError`, carrying the answer's `validationErrors` and its own message as `serverMessage`, where only the first item's message reached the caller, inside the error's sentence. Both derive from `InputPreparationError`, keep its verdict (`input`, not retryable) and keep their messages, so a `catch` on the base is unchanged. `docs/input-preparation.md` lists each preparation failure.
- **The `pipelex-sdk` command**: the package now declares a `bin`, so `npx @pipelex/sdk run --method <address | mt_id | bundle> --inputs inputs.json` runs a method on the hosted API through the SDK's durable run lifecycle and prints its main output as JSON on stdout, the run id, each uploaded file and every error going to stderr; `--inputs-template` prints the object `--inputs` takes; Ctrl-C leaves the run going and names it, and a failure that leaves a run going, or possibly created, says so. `npx @pipelex/sdk script --method <address | mt_id>` checks the method and writes a shell script that runs it with this SDK's version pinned. The key comes from `PIPELEX_API_KEY` only and no `.env` file is read. The command adds no runtime dependency, and the package entry does not export it. `docs/cli.md` describes it, and `tests/fixtures/cli-cases.json` records its behaviour case by case, which the Python SDK's command of the same name runs too.
- **`onStarted` and `onStarting` on `startAndWaitForResult`**: the second argument is now `StartAndWaitForResultOptions`, the wait's options plus `onStarted`, called once with the start acknowledgement as soon as the durable run exists and before the first poll, so a caller that waits through `startAndWaitForResult` holds the run's id while it waits, to show it, log it or resume the run by it after an interrupt; it is never called on the blocking path, which has no run id to give. `onStarting` is called right before each request that may create a run is sent, the start or the blocking execute, so a caller that stops waiting before then knows that no run was started; it is never called once the `signal` has aborted. `docs/run-results.md` describes them.

### Fixed

- **The blocking `execute` times its request on the monotonic clock**: it measured the time to the hosted gateway's ~30-second cut-off with `Date.now`, so a change of the system's time while the request was out, such as a time sync stepping the clock, could turn a fast `503` into a `PipelineExecuteTimeoutError` or hide a real cut-off. It now uses `performance.now`, which no such change moves.
- **`startAndWaitForResult` sends nothing once its signal has aborted**: an abort that landed while the `GET /v1/version` handshake was in flight stopped nothing, so the start or the blocking execute was sent once the handshake answered, and a run was created for a caller that had already given up. The signal is now read after the handshake and before the fallback to the blocking execute, and the call throws the abort without creating a run. `docs/run-results.md` describes it.
- **A success answer that is not UTF-8 is an answer the SDK cannot read**: every route read a `2xx` body as `Response.text()` does, a byte that is not UTF-8 turning into U+FFFD, so a JSON answer holding such a byte could hand back a mangled value, a run id included. It now throws the `ApiResponseError` of an answer the SDK cannot read, as the Python SDK refuses one; a refusal's body is still read leniently for its reason.
- **A start carrying an inline bundle gets the blocking ceiling**: `start()` gave a request whose bundle was inline as `mthds_contents` the poll's 30-second limit, so a large bundle on a slow uplink timed out on `POST /v1/start` while the same payload succeeded on the blocking execute; it now gets the blocking ceiling, as a bundle in `files` or `bundle_b64` and a `method_ref` already did.
- **An unanswered version handshake throws at once**: a `GET /v1/version` that got no answer was taken for a hosted API for the client's lifetime, and `startAndWaitForResult` sent the start anyway; it now throws its `ApiUnreachableError` at once, sends no start and caches nothing, so the next call asks again. An answer that is no usable version, a body that arrived and does not decode, such as a broken gzip stream, included, is still taken for a hosted API, as the Python SDK takes it.
- **A refused base URL is no longer echoed whole**: the `RequestArgumentError` the constructor throws for a base URL that is not host-only quoted the value verbatim, so the credentials, the path or the query token the rule exists to keep out reached logs and any page that shows an error's message. The refusal now shows the scheme and the host alone and names the parts beyond them without their text (`Invalid API base URL "https://api.example.com" with credentials and a query (not shown): …`), and a value that is not an http or https URL is not shown at all.

## [v0.33.0] - 2026-10-07

### Added

- **A verdict on every error: `retryable`, `errorDomain` and `errorVerdictOf`**: every error class the package exports now carries `retryable`, whether asking again can succeed, and `errorDomain`, who can fix the failure (`input`, `config` or `runtime`), both always decided, and `errorVerdictOf(err)` reads the pair from anything a `catch` holds, returning `undefined` for an error that is not the SDK's, such as an argument of the wrong type or range, or the caller's own abort. The classes now derive from the new abstract `PipelexRequestError`, itself a `PipelineRequestError`; `ErrorDomain` and `ErrorVerdict` are exported, `InputPreparationError` and `ArtifactOperationError` take an optional `verdict` in their options for a subclass of your own, `RunFailedError` takes its verdict from the run's report, and `CodegenLockError` carries the two members too. `docs/errors.md` lists each class's verdict.
- **`RequestArgumentError`**: the error the client throws when it refuses a call's arguments before sending any request, a `PipelexRequestError` whose verdict is `input` and not retryable unless its options declare another, as the client does with `config` for a base URL that is not host-only.

### Changed

- **`ApiResponseError.retryable` and `ApiResponseError.errorDomain` are always decided (Breaking)**: `retryable` is now `boolean` and `errorDomain` is `ErrorDomain` instead of `boolean | undefined` and `string | undefined`. Each is the problem document's member when the server sent a valid one, and otherwise the SDK's fallback, read from the status, the platform `code` and whether the body names what it refused; a domain outside the three reads as absent, and when the server sent a valid domain but no `retryable`, an `input` or `config` domain is not retryable, as a failed run's report that says nothing is not, while a `runtime` one takes the fallback's. Code that tested either for `undefined` to learn what the server sent now reads `problemDocument`.
- **`iterateMethods` throws `PagingNotTerminatingError` (Breaking)**: a server that keeps minting fresh cursors past the page ceiling now ends the iteration with the new `PagingNotTerminatingError`, carrying `pageLimit` and named as in the Python SDK, instead of a plain `Error`.
- **Argument refusals throw `RequestArgumentError`**: no run source given to `execute()` or `start()`, run sources or method selectors that exclude each other, the selector rules of `validate()`, an empty `validateFiles()`, a reserved key in `extra` and a base URL that is not host-only threw a bare `PipelineRequestError` with no verdict, and now throw `RequestArgumentError`, still a `PipelineRequestError`; a refusal from the standard's own run-source check keeps the original error as `cause`.
- **`health()` throws the typed errors (Breaking)**: the liveness probe now goes through the client's own transport, so an unreachable origin is an `ApiUnreachableError` instead of the runtime's raw `TypeError`, a non-2xx answer is an `ApiResponseError` naming `/health` instead of a plain `Error`, and the probe gives up after the 30-second management timeout.

### Fixed

- **A failed run's stored report is checked field by field**: the report on `getRunResult`'s failed arm, on `RunFailedError`, on `getRunStatus`, on each row of `listRuns` and `iterateRuns` and on `getRunDetail` was handed back as cast; each named field is now kept only when it has its declared type and reads as absent otherwise, `user_action` only whole, and members the SDK does not name are relayed as sent.
- **A wrapped upload refusal carries its cause's verdict**: an `UploadTransportError` from `uploadFile` takes the verdict of the `ApiResponseError` or `ApiUnreachableError` it wraps, so a `402` plan refusal, whose transport `code` is `unexpected`, reads as `config` and not retryable rather than as a transient fault.
- **Storage's `501`, `408` and `429` from `uploadWithGrant` give the right retry advice**: storage's `501`, its answer to a request it does not implement, threw an `UploadTransportError` with code `server_error` whose message advised retrying with the same grant; the message now says storage stored nothing and a retry meets the same answer, and the error is `runtime` and not retryable, while any other `5xx` stays retryable. A `408` or a `429`, storage timing out or throttling the request, threw a `RejectedAssetError` with code `store_refused` that asked for a new grant or another file; it now throws an `UploadTransportError` with code `unexpected` and storage's status, `runtime` and retryable, whose message says a later attempt can succeed with the same grant.
- **`ApiResponseError`'s nested members are checked**: `providerMetadata`, `migration`, `validationErrors` and each item of `errors` were cast from the problem document once they were an object or an array; each is now checked field by field as a failed run's stored report is, so a misfit field reads as absent and a validation item without a string `category` and `message` is dropped.
- **An unreadable 2xx answer throws an `ApiResponseError`**: a `2xx` whose body is not JSON, on any route and on `health()`, let the runtime's bare `SyntaxError` escape with no verdict; a body that is JSON but not the object the route answers (`null`, a number, an array) let a `TypeError` escape from `getRunResult`, `listMethods`, `getMethod` and the other routes whose answer the SDK reads, and came back as the value of `getRunDetail` and `requestUploadGrant`, an empty body too; a page of `listMethods` or `listRuns` whose `items` is not an array made `iterateMethods` and `iterateRuns` throw a bare `TypeError`, and one with no `next_cursor` made `iterateRuns` loop forever and `iterateMethods` repeat its first page until it gave up; an `upload` answer with no string `uri` became an upload record with no URI, which `prepareInputs` handed back as a file input with no URL; a stored method whose `mthds` field is not a string made `getMethodClosure` throw a bare `TypeError`; and one whose `python` field is not the serialized file list made `getMethod`, `createMethod` and `updateMethod` throw `mthds`'s bare `PipelineRequestError`. Each now throws an `ApiResponseError` carrying the status and the raw text, `runtime` and not retryable, which `uploadFile` wraps as an `UploadTransportError` with code `unexpected`, and `uploadFile` keeps the filename it sent when the answer names none. `prepareInputs` threw a bare `TypeError` on an invalid pipe I/O answer without a `validation_errors` list, and now reports the answer's own `message`, while an answer whose `is_valid` is not a boolean is an `InputPreparationError` that is `runtime` and not retryable.

### Removed

- **`ClientAuthenticationError` (Breaking)**: the class is no longer exported. Nothing in the SDK ever threw it, so delete any `instanceof ClientAuthenticationError` arm.

## [v0.32.0] - 2026-10-07

### Changed

- **The `.mthds` check hook's lint engine moves to `@pipelex/tools-wasm` 0.4.0**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.4.0, whose MTHDS schema accepts binding steps in a `PipeSequence`'s steps, a dotted `batch_over` on a sequence step, and the `PipeDocGen` and `PipeJudge` pipe types, and refuses dotted input names, so the hook no longer blocks those valid forms and blocks a dotted input name with a schema error.

## [v0.30.0] - 2026-10-04

### Changed

- **`models()` reads a deck carrying a `judgment` model (Breaking)**: the re-exported `ModelCategory` and `MODEL_CATEGORIES` carry `judgment`, the category MTHDS Protocol 0.7.0 adds, so `models("judgment")` lists the models a `PipeJudge` names, and `MTHDS_PROTOCOL_VERSION` is `0.7.0`. A deck entry's `ModelInfo.type` is now `ModelCategory | (string & {}) | null`, so an entry whose category this version does not define reaches the caller with its raw value; code that indexes a table by an entry's `type`, or types one as `Record<ModelCategory, …>`, now says what `judgment` and an unknown category do.
- **The `mthds` floor moves from `^0.28.0` to `^0.30.0` (Breaking)**: this package imports only `mthds/protocol`, whose MTHDS Protocol 0.7.0 brings the `judgment` category above. A project that also imports `mthds` itself moves to 0.30 with it, so that one copy is installed and an `instanceof PipelineRequestError` check made with the class from `mthds/protocol` still matches this package's errors. In 0.30, `MthdsApiClient` no longer has `buildInputs`, `buildOutput`, `buildRunner`, `concept`, `pipeSpec` or `uploadFile` and gains `pipeIo`, and a file upload goes through this package's `uploadFile`.

### Removed

- **The `/v1/build/*` wrappers and their types (Breaking)**: `PipelexApiClient` no longer has `buildInputs`, `buildOutput`, `buildRunner`, `concept` or `pipeSpec`, and the package no longer exports `BuildRequestBase`, `BuildInputsRequest`, `BuildOutputRequest`, `BuildRunnerRequest`, `ConceptRequest`, `PipeSpecRequest`, `BuildInputsValidReport`, `BuildOutputValidReport`, `BuildRunnerValidReport`, `BuildInputsResponse`, `BuildOutputResponse`, `BuildRunnerResponse`, `ConceptResponse`, `PipeSpecResponse`, `RunnerStructures` or `ConceptRepresentationFormat`, while `InputsTemplateFormat` now resolves to the `mthds/protocol` type of the same name and values. A caller that wants an inputs template reads the pipe's input-form descriptor with `pipeIo` and renders it client-side with `renderInputsTemplate` (or `projectInputsTemplate` for the object), both from `mthds/protocol` and re-exported by this package. `MthdsFileItem`, `CrateRequestBase`, `CrateInvalidReport` and `GeneratedArtifact` stay, serving `resolve`, `codegen` and `pipeIo`.

## [v0.29.1] - 2026-10-02

### Fixed

- **Published to npm**: `@pipelex/sdk` 0.29.0 was released in `Pipelex/pipelex-sdk` but never reached npm, because the release workflow handed `npm publish` its tarball by a path npm took for a GitHub repository, so 0.29.1, which carries the same code, is the first `@pipelex/sdk` published from that repository. Its Python twin, `pipelex-sdk` 0.29.0, did reach PyPI with that release and is unchanged.

## [v0.29.0] - 2026-10-02

### Changed

- **One version line with `pipelex-sdk` and the templates**: `@pipelex/sdk` is now developed and released from the `js/` directory of `Pipelex/pipelex-sdk`, together with the Python SDK `pipelex-sdk`, the starter templates and `@pipelex/create-method-app`, under one version number; when both SDKs ship in the same release they carry the same number, which says they cover the same API. This minor changes no API.
- **The package's repository, homepage and issue links**: the npm page now sends a reader to the `js/` directory of `Pipelex/pipelex-sdk`, where the SDK's source lives, and to that repository's issues; `package.json`'s `repository` names the new repository with the directory `js`, as npm provenance requires.

## [v0.28.1] - 2026-10-01

### Added

- **The `User-Agent` builder is public**: the package entry now exports `buildUserAgent(appInfo?)`, which returns exactly the value a `PipelexApiClient` constructed with that `appInfo` sends (or `undefined` in a browser), together with `validateAppInfo` and `MAX_USER_AGENT_LENGTH` (512) and the `RuntimeInfo` type. A program that makes some of its API requests with its own `fetch`, such as a web app's hand-rolled routes, now sends the same header and checks an `appInfo` against the grammar and the ceiling without re-implementing the format. Documented on `docs/client-identification.md`.

## [v0.28.0] - 2026-10-01

### Added

- **`getRunResult`'s `artifacts` option, with `RUN_RESULT_ARTIFACTS` and `RunResultArtifact`**: `getRunResult(runId, { artifacts })` reads only the named result artifacts (`graph_spec`, `pipe_io_contracts`, `input_form`, `output_form`, `main_stuff`, `working_memory`, `tokens_usages`, the last bringing `usage_assembly_error`), sent as one comma-separated `?artifacts=` parameter; an unselected artifact is absent from the result and a selected one the run never wrote is `null`. `waitForResult` and `startAndWaitForResult` take the same option in their poll options, `downloadArtifacts` given a `run_id` now asks for its scope's artifact alone, and an empty selection or an unknown name is a `RangeError` before any request. It needs a platform serving `?artifacts=`, and `GetRunResultOptions` is exported.

### Changed

- **`listRuns` and `iterateRuns` return `RunHistoryItem` rows (Breaking)**: a run-history row is now exactly `pipeline_run_id`, `status`, `created_at`, `finished_at`, `pipe_code` and `error`, matching the platform's slimmed `GET /v1/runs`, and `RunPage.items` is `RunHistoryItem[]` instead of `PipelineRun[]`. Code that read `org_id`, `created_by_user_id`, `method_id`, `workflow_id` or `result_url` off a history row now reads them from `getRunDetail(runId)`, which still returns the whole `PipelineRun` record.
- **`RunResults.main_stuff` is optional, and `MissingMainStuffError` fires only when it was asked for (Breaking)**: a results read whose `artifacts` selection leaves `main_stuff` out returns no main stuff and throws nothing, while a read with no selection, or one naming `main_stuff`, still throws `MissingMainStuffError` when the main stuff comes back null.

## [v0.27.0] - 2026-09-30

### Added

- **`pipeIo()` and its types**: `client.pipeIo(request)` calls `POST /v1/pipe-io`, which returns a method's pipe I/O contracts, input form and output form with no dry run, beside the resolved `pipe_ref`, the method's own `default_pipe_ref`, `pending_signatures` and `is_runnable`, and the closure's `.mthds` files when `include_files: true` is passed. It takes the crate routes' `files`, `method_ref` or hosted `method_id` selector with an optional qualified `pipe_ref` and `all_pipes`, and `PipeIORequest`, `PipeIOValidReport` and `PipeIOResponse` are exported, the three artifacts typed from `mthds/protocol`. It needs a server serving `POST /v1/pipe-io`, which `pipelex-api` does from v0.33.1; at this release the hosted dev API serves it and the production API does not yet.

### Changed

- **`prepareInputs` reads `POST /v1/pipe-io`, and the route selects the pipe (Breaking)**: preparation calls `pipeIo` instead of `validate`, so it runs no dry run and needs a server serving `POST /v1/pipe-io` with its selection refusals typed, as `pipelex-api` does from v0.33.1 (at this release the hosted dev API serves it and the production API does not yet); against one that does not serve it, the route's `404` or `403` propagates as an `ApiResponseError`. The route's entry pipe replaces the helper's own default chain and its blueprint and single-pipe fallbacks, so a method whose domains declare several `main_pipe`s now needs `pipe_ref` where the first declaration used to be taken, and a selection the route refuses (a `422` typed `EntryPipeNotFoundError` or `EntryPipeAmbiguousError`) is an `InputPreparationError` carrying the server's detail instead of a list of candidates the client built.

## [v0.26.0] - 2026-09-27

### Added

- **`ApiResponseError` carries every member of the problem document**: `type`, `title`, `instance`, `requestId` (the body's `request_id`, else the `X-Request-ID` header), `errorDomain`, `errorCategory`, `retryable`, `userAction`, `model`, `provider`, `providerMetadata`, `migration`, the platform's field-level `errors[]`, and the decoded document whole as `problemDocument`, beside the fields it kept. A member of the wrong type reads as absent. The members `mthds`'s `ApiResponseError` carries have the same names and types here, and the types `ProblemDetails`, `FieldError`, `UserAction` and `ApiResponseErrorOptions` are exported.
- **`docs/errors.md`**: a reference page for a failed run's report and a refused request's `ApiResponseError`, with the fields to branch on, and for the validation items either can carry.
- **An unknown model's validation item keeps the model and its close matches**: `ValidationErrorItem` declares `model_reference` (the reference as the author wrote it), `model_type` (the kind of model the field takes) and `suggestions` (the close matches), the members `mthds`'s item carries, so a refusal for a model the deck does not know reaches a TypeScript caller with the model it named and what to write instead, beside its `rename-model` suggested fix. `FixValue` is exported as the standard's name for `TomlValue`, and a type-level test pins the item and the fix vocabulary to `mthds`'s declarations.

### Changed

- **A failed run carries its report (Breaking)**: the `failed` arm of `getRunResult` gains `error`, the run's stored report or `null`, and `RunFailedError`, thrown by `waitForResult`, `startAndWaitForResult` and `downloadArtifacts`, gains the same `error`, so the reason, the next step and the retry advice reach the caller. Its `status` is now typed `RunStatus` and is read from the results read's `run_status` member, the `detail` sentence serving only for a platform that does not send it yet. Code that builds a `failed` state by hand now sets `error`.
- **A failed run's stored error report, typed whole (Breaking)**: `RunErrorReport` now declares every field of the runner's report (`error_type`, `message`, `title`, `type_uri`, `error_domain`, `error_category`, `retryable`, `user_action`, `model`, `provider`, `provider_metadata`, `caller_facing_message`, `validation_errors`, `migration`), all optional and each admitting `null`, and `RunRead` declares it as `error`. `message` and `error_type`, typed `string` until now, are `string | null`, so code reading them under `strictNullChecks`, as on `PipelineRun.error` from `listRuns`, `iterateRuns` and `getRunDetail`, now handles `null`. `ProviderErrorMetadata` and `MigrationErrorBlock` are exported with it.
- **Branch on `errorDomain` and `type`**: the README and `docs/architecture.md` now point consumers at `errorDomain` and `type`, the hosted envelope's branch fields, rather than at the platform's native `code`, which stays on the error and is one-to-one with `type`.
- **The `mthds` floor moves from `^0.25.0` to `^0.28.0`**: `mthds` 0.28.0 is the release whose `ApiResponseError` carries the problem members and whose `ValidationErrorItem` carries `model_reference`, `model_type` and `suggestions`, the declarations this SDK's error and validation-item types are pinned to.

## [v0.25.1] - 2026-09-25

### Fixed

- **The README and `docs/architecture.md` no longer list a gateway key**: their account of the Pipelex product routes still named the gateway key surface that v0.25.0 removed, so the package page and the shipped architecture doc now describe the client as it is.

## [v0.25.0] - 2026-09-25

### Fixed

- **The `.mthds` check hook finds the file a Codex shell patch wrote**: for a patch Codex runs through the shell, the hook built by `npm run build:hook` follows the script's `cd`s, branches and scopes before resolving the patch's relative paths, where it used to read them against the session directory. It checks and formats such a file only when it holds the lines the patch added, as the shell passed them, so it no longer rewrites a same-named file the patch never touched, nor a file named by an absolute path in a patch the script only stored or never reached, and it names the files it could not check in a non-blocking note asking for an absolute path or the `apply_patch` tool. Relative paths now resolve against the payload's `cwd` rather than the hook's working directory.

### Removed

- **The Pipelex Gateway key surface (Breaking)**: `createGatewayApiKey`, `getGatewayApiKey` and the `GatewayApiKey` / `GatewayApiKeyStatus` types are gone, along with the `POST` and `GET /v1/gateway-api-key` routes behind them, which the hosted plane no longer serves. A consumer that provisioned an LLM inference key through the SDK now has the user bring their own provider keys, or call the hosted API with a Pipelex API key (`listPipelexApiKeys`, `createPipelexApiKey`, …), which is untouched.

## [v0.24.0] - 2026-09-24

### Added

- **`UploadTransportError.code` and `UploadTransportCode`**: an upload's transport failure now says which it was in a closed vocabulary — `timeout`, `unreachable`, `server_error` and `unexpected` from `uploadFile` and `uploadWithGrant`, and `storage_timeout`, `conflict`, `redirected` and `invalid_grant_url` from `uploadWithGrant` — so a caller tells a timeout from an unreachable host or a `5xx` by a field rather than by the message or the error's `name`. The type is exported from the main entry and from `@pipelex/sdk/upload`.

### Changed

- **`uploadWithGrant` bounds its `PUT` to storage, and takes `timeoutMs` (Breaking)**: a call now fails with an `UploadTransportError` whose `code` is `timeout` once 60 s plus 1 s for every started 128 KiB of the file have passed — 460 s for a 50 MiB file — instead of waiting forever when no signal was passed, so a caller no longer needs a timeout formula of its own. `timeoutMs` replaces the default, for a link slower than about 1 Mbit/s, and a caller's `signal` can still end the upload sooner. Only the first 16 KiB of storage's error body are read, and when the limit runs out while that body is still arriving the call settles as storage's answer, classified from its status.
- **`uploadWithGrant` reports storage's `409 ConditionalRequestConflict` as an `UploadTransportError` (Breaking)**: the conflict S3 answers when two uploads with one grant overlap was a `RejectedAssetError` advising a new grant; it is now an `UploadTransportError` whose `code` is `conflict`, advising a retry with the same grant, which either stores the file or reports the grant as used.

### Fixed

- **`uploadWithGrant`'s messages on an unknown outcome**: an unreachable storage now also gives the same-grant retry advice, since the connection may have failed after the file went out, a `5xx` whose storage message ends with a period no longer prints two, and a successful upload no longer waits on the cancellation of storage's response body, which a `fetch` wrapper keeping a clone of the response could hold open indefinitely.
- **The client's own timeout is `ABORT_TIMEOUT` in a browser too**: when the request timeout ran out while a response body was still arriving, Chrome and Firefox error the body with a generic `AbortError`, so the resulting `ApiUnreachableError` carried no `code`; it now carries `ABORT_TIMEOUT` in every runtime, and `uploadFile` reports it as a `timeout`.
- **A `timeoutMs` no timer can honour is refused instead of failing at once**: a delay above 2147483647 overflowed `setTimeout`, which then fired almost at once as a false timeout. `validate`, `validateFiles` and `buildRunner` now throw a `RangeError` for such a `timeoutMs`, and for `Infinity`, zero, a negative or `NaN`; `fetchArtifact` and `downloadArtifacts` throw an `ArtifactOperationError`; and `waitForResult` refuses a `NaN` `intervalMs` or `timeoutMs` and caps its sleep, so it no longer polls in a tight loop. `startAndWaitForResult` refuses such a poll option before it starts the run.
- **The `.mthds` check hook's lint engine accepts the expanded input-slot form and intent hints**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.3.0, whose MTHDS schema carries `inputs = { x = { concept = "…", hints = { … } } }` and `hints` on concepts and structure fields, so the hook no longer blocks those valid forms with a schema error; malformed hints are still refused. The engine is pinned exactly, so the bundle's provenance line, the manifest and the lockfile name the same version.

## [v0.23.0] - 2026-09-24

### Added

- **`locateArtifacts` and `ArtifactLocation`**: `locateArtifacts(value)` is the artifact walk with its paths — every `pipelex-storage://` reference in a JSON value, deduplicated in discovery order exactly as `collectArtifacts` returns them, each with `found_at`, every `$`-rooted path at which it sits (`$.rooms[3].staged_photo.url`, `$.items[0].url`, `$["a key"].url`).

### Changed

- **`downloadArtifacts` names each file after the field it fills, and `artifactFilename` takes a location (Breaking)**: a saved file is named after the first path at which its reference sits — `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and an output that is one image as `main_stuff.png` — instead of after the last segment of its storage key, which now supplies only the extension. `artifactFilename(location, contentType, scope)` replaces `artifactFilename(uri, contentType, index)` and throws `ArtifactOperationError` for a location whose first path is not in the walk's notation; a field whose name Windows reserves for a device (`aux`, `nul`, `com1` and the like) is saved with a trailing `_` (`aux_.png`); the full rule is on `docs/artifact-download.md`.
- **`DownloadedArtifact` items carry a required `found_at` (Breaking)**: every item of a `downloadArtifacts` verdict carries its reference's `found_at`, on the saved arm and the error arm alike, so a file that was not saved still says which field it would have filled. The field is required, so code that builds `DownloadedArtifact` values — a test fake standing in for `downloadArtifacts` — must now supply it.

### Fixed

- **`downloadArtifacts` refuses an unknown `scope`**: a scope other than `main_stuff` or `working_memory` used to walk the working memory while reporting the unknown name back; it is now an `ArtifactOperationError`, raised before anything is read.

## [v0.22.0] - 2026-09-23

### Added

- **`requestUploadGrant`, and the browser-safe `@pipelex/sdk/upload` entry with `uploadWithGrant`**: `PipelexApiClient.requestUploadGrant({ filename, content_type, size })` calls `POST /v1/upload/grant` and returns an `UploadGrant` — a presigned, create-only `PUT` for one new object, its signed headers, the `pipelex-storage://` URI the object will carry, its expiry and the service's `max_bytes`. The standalone `uploadWithGrant(grant, file)` sends a `Blob` or `File` straight to storage with it and returns `{ uri }`, so a browser page that holds a file but no API key can store it without the bytes crossing a server or the API gateway's size ceiling; storage's refusals map onto `RejectedAssetError` (a used grant's `412`, a signature mismatch's `403`, an expired grant) and `UploadTransportError` (a `5xx`, storage's `400 RequestTimeout`, no response, or a grant `url` that is not an absolute `http(s)` URL free of user info, refused before anything is sent). No error it throws carries the grant's URL, the bearer credential: an unreachable storage is described by its origin and the error names and codes, never by the runtime's message or error, which can name the whole URL. It ships from the new `@pipelex/sdk/upload` subpath, which reaches no Node builtin and bundles for the browser with nothing marked external, as well as from the main entry. Documented on `docs/input-preparation.md`.
- **`RejectedAssetError.code` and `UploadTransportError.status`**: a rejected asset now says why in a closed `RejectedAssetCode` vocabulary — `too_large` for `uploadFile`'s `413`, and `grant_used`, `grant_expired`, `signature_mismatch`, `unsigned_header` or `store_refused` for storage refusing an upload with a grant — so a caller branches on a field rather than on the message. `UploadTransportError` carries the HTTP status when a response produced it. Both are set through the options bag, so existing constructor calls still compile.

### Fixed

- **A caller's abort now reaches it as its own reason in a browser too**: when an abort cut short a response body that was still arriving, the client rethrew the runtime's error, and Chrome and Firefox error that body with a generic `AbortError` rather than the signal's reason — so a caller comparing the rejection to its reason, or using `AbortSignal.timeout()`, saw the wrong error. The client's request pipeline and `fetchArtifact` (whose returned body is read after the call resolves) now throw `signal.reason` whenever the caller's signal has aborted. Node's `fetch` already passed the reason through.

## [v0.21.0] - 2026-09-23

### Added

- **`User-Agent` on every API request, and the `appInfo` option**: `PipelexApiClient` now identifies itself as `pipelex-sdk-js/<version> <runtime>/<version> (<os>; <arch>)` on every request to the API, the `health()` probe included, following the workspace's client-identification convention, and sets no header in a browser; the fetch of a presigned object-store link is unchanged. `PipelexApiClientOptions.appInfo` (the exported `AppInfo`: `name`, optional `version`, `url` and `details`) puts the caller's own product token in front, and an invalid field is refused at construction with a `TypeError`. Documented on `docs/client-identification.md`.
- **The bundled `.mthds` check hook names itself**: the hook's validate calls carry `pipelex-mthds-check/<version>` in front of the SDK's token, so the platform attributes them to the hook.

## [v0.20.1] - 2026-09-22

### Added

- **`resultsFromExecute`, the lift from a blocking result onto `RunResults`, made public**: `resultsFromExecute(result)` turns a `PipelexExecuteResult` into the `RunResults` the durable path hands back, lifting the usage pair, the graph pair, the working memory and the three I/O artifacts off the runner's extension-open `pipe_output` onto their declared fields. It is the same mapping `startAndWaitForResult` has always applied on its bare-runner fallback, which until now was private: a caller driving the blocking `execute()` itself had to re-read `pipe_output`'s extension fields by hand to reach `summarizeUsage`, `collectArtifacts` or any parity field. `execute()` still returns `PipelexExecuteResult`, since that object carries the runner's whole typed envelope. The function is pure — no client, no network — and is documented in `docs/run-results.md` and `docs/run-usage.md`.

## [v0.20.0] - 2026-09-22

### Highlights

**A run now describes its own data.** Beside the graph it already carried, `RunResults` hands back the three I/O artifacts that say what that graph's nodes hold — which is what lets a renderer show a run's actual values instead of the concepts' structure tables.

### Added

- **`RunResults` carries the three I/O artifacts that describe a run's data**: `pipe_io_contracts`, `input_form` and `output_form`, typed as the standard's `PipeIOContracts`, `InputForm` and `OutputForm` imported from `mthds/protocol` rather than restated, built over the library the run executed against and keyed by namespaced `pipe_ref`. They are what makes `@pipelex/mthds-ui`'s `GraphViewer` show a data node's value instead of the concept's structure table, which it does only when it holds `contracts` and `outputForm` together. The blocking path unwraps the runner's `pipe_io_artifacts` envelope onto the three fields so each has one accessor whichever path ran, while on the hosted path they read `undefined` until the platform relays the keys; documented on `docs/run-results.md`.
- **`RunResults.pipe_io_artifacts_error`** — the artifacts' twin of `graph_assembly_error`: non-null when the runner's build of the three failed, which is the only thing that separates a broken build from a run that described no data. Lifted off `pipe_output` on the blocking path; absent on the hosted path until the platform relays it.

## [v0.19.0] - 2026-09-21

### Changed

- **`prepareInputs` stops at a stated `default_pipe_ref: null` (Breaking)**: a report stating the field as `null` is the server saying it determined no entry pipe — no blueprint declares a `main_pipe`, or the package manifest names a pipe the closure does not declare or declares in several domains — and a run naming no pipe is refused in exactly those cases, so preparation now refuses with an `InputPreparationError` naming the candidates instead of falling through to the bundle's `main_pipe` or to the only declared pipe. Pass `pipe_ref`. A stated ref the report's `input_form` does not describe is refused for the same reason, and only an ABSENT field — a runner predating it — still leaves the blueprint and single-pipe fallbacks standing.

### Fixed

- **`PipelexValidationReport.default_pipe_ref` is documented as what it carries**: its TSDoc, and the v0.17.0 entry announcing the field, both said `null` meant the closure declares "none or several" `main_pipe` — the build routes' stricter rule, never the one the API shipped. The field carries the RUN default, so a closure whose domains each declare a `main_pipe` gets the first declaring blueprint's ref — the pipe `execute` would take — and `null` means no entry pipe was determined at all. The three-arm reading a consumer applies (string / stated `null` / absent) is stated there and on `docs/input-preparation.md`.

## [v0.18.2] - 2026-09-21

### Fixed

- **The documentation pages ship with the package**: `files` carried `dist/` alone, so every `docs/*.md` page stayed behind in the repository and the README's links to them resolved to nothing in an installed tree. `docs/` now joins the tarball, a developer who has only installed `@pipelex/sdk` reads the pages under `node_modules/@pipelex/sdk/docs/` at the version they are calling, and the README gained a table naming each page and what it covers.

## [v0.18.1] - 2026-09-20

### Fixed

- **`main_stuff`'s documented shape is the shape it has**: the TSDoc on `RunResults.main_stuff`, which ships in the type declarations and is what an editor shows on hover, and `docs/run-results.md` beside it, both said a list output arrives as a top-level array. It arrives as `{ items: [...] }`, the runtime's `ListContent` serialised, and every content type serialises to an object — natives included — so a guard written for a bare `""` or `0` never fires. The page now says to read `items` off the object and map the generated per-concept parser over its members, and warns that a schema whose fields are all optional swallows the envelope into `{}` rather than rejecting it, since the generated schemas are not strict.

## [v0.18.0] - 2026-09-20

### Added

- **`collectArtifacts` and `resolveArtifacts`**: the reading half of the artifact stack, the download twin of `prepareInputs`. `collectArtifacts(value)` is a pure, exported walk of any JSON value for the strings that are `pipelex-storage://` references, deduplicated and in discovery order, so a consumer can count a run's produced files without touching the network. `client.resolveArtifacts(uris)` mints fresh links for a whole list through the platform's new bulk route (`POST /v1/resolve-storage-url/bulk`, exposed raw as `client.resolveStorageUrls`), chunked at the route's bound of 100 references, answering one `ResolvedArtifact` per reference in request order with a refused reference as a value on its item rather than a thrown error.
- **`fetchArtifact` and `downloadArtifacts`**: `client.fetchArtifact(uri)` returns one reference as a bounded `Response` — resolved fresh, a timeout, redirects refused, the byte cap enforced mid-stream, no credentials forwarded, plain `http:` refused unless `allowHttp`, and the store's headers relayed (less a `Content-Encoding` the fetch already decoded) so a same-origin proxy sets its own. `client.downloadArtifacts({ run_id | results, dir, scope? })` is Node-only and saves a run's produced files under a directory — by run id days after the run, or from a `RunResults` in hand — walking `main_stuff` by default or `working_memory` on request, never using the embedded `public_url`, with a bounded pool of workers that re-resolve a link expired by the time they reach it, filenames derived from the storage key and never overwritten, and partial files unlinked on failure or abort. It returns a produced verdict (`scope`, one `artifacts` entry per reference with `path` or `error`, `saved_paths`, `all_saved`, `aborted?`) and throws only when no verdict exists, through the new `ScopeUnavailableError`, `ArtifactAuthenticationError` (carrying the verdict so far), `ArtifactFetchError` and their base `ArtifactOperationError`, beside the existing run-lifecycle and transport errors. Defaults: `maxBytes` 1 GiB, `timeoutMs` 120 s, `maxTotalBytes` 4 GiB, `concurrency` 4, `allowHttp` false. Both operations need a platform serving the bulk route; `undici` joins the runtime dependencies for the dispatcher timeouts the Node fetch runs under. Documented on `docs/artifact-download.md`.
- **`RunResults.graph_assembly_error`** — the graph's twin of `usage_assembly_error`: non-null when the runner's graph assembly failed, which is the only thing that tells a broken graph apart from a run that produced none. It is lifted off `pipe_output` on the blocking path; the hosted results body relays no such key, so on that path the key is absent and the field reads `undefined` until the platform writes and relays it, and the field is declared ahead of that so consumers have one accessor to write against.
- **`summarizeUsage(results)`**: a pure helper that folds a run's `tokens_usages` / `usage_assembly_error` pair into one `UsageSummary` — a `state` of `records`, `no_inference` or `unavailable`, the total cost with a `cost_partial` flag, the `input` and `output` token totals, the call count, the assembly error, and a `by_pipe` rollup sorted by cost with unattributed calls grouped under a `null` `pipe_code`. Cost stays null-aware (`null` is unrated, `0` is priced at zero), and a run that did no inference totals `0` rather than `null`; `docs/run-usage.md` documents it.
- **`RunResults.working_memory`**: every named stuff of the run as `{ root, aliases }`, typed `DictWorkingMemory`, which reads the same on both paths — the hosted results body relays the `working_memory.json` artifact, and the blocking path lifts it off `pipe_output`. Read it rather than `pipe_output.working_memory`, which exists on the blocking path only; a run from a runtime older than pipelex 0.60.0 still carries each `concept` as an object.
- **`docs/run-results.md`** — "Reading a run's results", a page walking every field of `RunResults`: the run id as the durable handle, `main_stuff` with a worked `getRunResult` example, `working_memory` and how it relates to `main_stuff`, what `graph_spec` is and how to render it with `@pipelex/mthds-ui`'s `GraphViewer` or keep it as JSON, the usage pair, and the produced files whose signed `public_url` is short-lived and must be re-minted with `resolveStorageUrl` rather than stored.

### Changed

- **The blocking path stops dropping the executed graph.** Against a bare runner, `startAndWaitForResult` now lifts `pipe_output.graph_spec` onto `RunResults.graph_spec` instead of writing `null` — the runner has always returned the graph there — so the field carries the same document whichever path ran.

## [v0.17.0] - 2026-09-02

### Added

- **`PipelexValidationReport.output_form`** — the standard's `OutputForm`, imported from `mthds/protocol` rather than restated, exactly as its `input_form` twin and `pipe_io_contracts` already are. The report typed the artifact describing a pipe's INPUTS and had no typed route to the one describing its RESULT, which is the artifact a result renderer actually needs. Optional for the same reason its twin is: presence is a function of the request (`views: ["output_form"]`), so a required field would lie about every verdict that did not ask for it.

  Requires `mthds` 0.25.0, where `OutputForm` exists — and where `json_schema` becomes required on `PipeOutputContract`, a closed shape, so a verdict from a runner predating the output payload schema now fails the parse rather than being read half-way.
- **`prepareInputs` takes the method three ways.** Beside inline `files`, it accepts a `method_ref` address (resolved by the runner) or a stored `method_id` (resolved by the hosted platform) — exactly one per call, all three server-resolved, nothing expanded client-side. `PrepareInputsRequest` is a discriminated union pinning the unused selectors to `never`, so a second one is a compile error; empty is absent (`files: []`, a blank `method_ref` / `method_id`), and an untyped caller giving none or several gets an `InputPreparationError` naming the three forms. `PrepareInputsBase` and `PrepareInputsClosure` are exported from the barrel.
- **`PipelexValidationReport.default_pipe_ref`** — the qualified `pipe_ref` a caller gets by omitting the pipe selector, or `null` when the closure declares none or several. Optional and read leniently: a runner that predates the field sends nothing, and `prepareInputs` falls back to the opaque `bundle_blueprint.main_pipe`.

### Changed

- **Breaking: `prepareInputs` reads its signature from the input-form descriptor, not the inputs template.** It composes one `POST /v1/validate` with `views: ["input_form"]` and `allow_signatures: true`, and walks the standard's `InputForm` artifact — `document` / `image` mark a file position, `object` recurses through `fields`, `list` through `item`, everything else passes through. Source-compatible for every caller passing `files`; the SDK no longer calls `/v1/build/inputs` at runtime.
- **Breaking: a canonical file dict nested inside a `Dynamic` input is no longer uploaded.** Such an input is `kind: "unknown"` in the descriptor — the standard's escape hatch — and the walk does not enter it. Uploading on the strength of a `url` key is the value-shape guess this change removes; a caller with a Dynamic input uploads with `uploadFile` first and passes the storage URI, which `docs/input-preparation.md` has always prescribed.
- **`ValidateMethodSelector` moved to `src/models.ts`**, beside the other wire shapes, and is re-exported from `src/client.ts` — the import path is unchanged for every consumer.
- **The documentation is rewritten around the descriptor.** `docs/input-preparation.md`, `docs/architecture.md` and `docs/build-routes.md` now describe the three call shapes, the signature call, pipe selection and its manifest-only `main_pipe` gap, and `getMethodClosure` reduced to what it is — the explicit expansion utility for the routes that still have no by-id form. They previously generalised the build-route freeze to the address form.

### Security

- **An optional nested file field is now uploaded.** The required-only inputs template never rendered one, so its file position was invisible and the caller's local path travelled to the runner as a literal string. The descriptor states `required: false` and the walk enters it.
- **A text field merely *named* `url` is no longer read from disk.** The template marked a file position by rendering a `url`-bearing dict — a side effect of the field's *name*, not of its concept — so a path-shaped text value was uploaded. `kind: "text"` ends that.

## [v0.16.0] - 2026-08-29

### Added

- **`method_ref` is a typed run source.** `execute`, `start`, and `startAndWaitForResult` take a published method's address — `github.com/<owner>/<repo>[/<selector>][@<tag>]` — through the new `PipelexApiRunExtensions` interface, beside the protocol's inline sources. It is a layer-2 Pipelex-API argument the RUNNER resolves (git fetch at the tag, package located by manifest identity), deliberately separate from the hosted-only `method_id`: an address is meaningful against a bare runner, a catalog id is not. Served by pipelex-api >= 0.21.0; on `api.pipelex.com` availability follows the platform deploy that forwards it. An empty string is treated as absent, `extra: { method_ref }` is rejected (the key joins the reserved set), and the selector survives `startAndWaitForResult`'s blocking fallback.
- **Provenance comes back typed.** A `method_ref` run's start ack is the new `PipelexRunResultStart`, carrying `method_provenance` — the new `MethodProvenance` shape `{address, tag, commit_sha}`, the SHA being what keeps the run explainable when a tag moves — and `PipelexExecuteResult` declares the same field on the blocking path. Both are `null` or absent for inline-source and bundle runs.
- **Client-side exclusivity guards mirroring the server's 422s.** A `method_ref` is a complete run source, so it pairs with nothing: combining it with inline `mthds_contents`, with a method bundle (`files` / `bundle_b64`), or with `method_id` fails fast with a `PipelineRequestError` whose wording mirrors the server's validator — before anything hits the wire. The documented run-route exception is untouched: inline source + `method_id` stays legal (the inline source runs; the id demotes to run-history linkage), and `pipe_code` beside a `method_ref` stays legal (it overrides the manifest's `main_pipe`).
- **`validate` takes method selectors.** Its first argument now accepts, in place of the inline `string[]`, a `ValidateMethodSelector` — `{ method_ref }` (runner-resolved by address, the package's real file names feeding the diagnostics' source labels) or `{ method_id }` (hosted-only, platform-resolved) — under the tooling routes' strict three-way XOR: exactly one selector, no linkage exception, `mthds_sources` legal only beside inline contents. A selector-resolution failure (fetch failure, no package at the address, an unknown id) is a non-2xx `ApiResponseError`, never an `is_valid: false` verdict.
- **Typed `method_id` on `resolve` and `codegen`.** Both crate routes take the hosted catalog id as a third closure form through the new `PipelexHostedToolingExtensions` — a pure server pass-through the platform resolves, meaningless against a bare runner. An unknown or foreign-org id is a `404` (indistinguishable by design); a stored method with no MTHDS source is a `422`. The `method_ref` field on the same envelope is no longer reserved for the address form, which pipelex-api resolves as of 0.21.0; the registry form keeps its `501`.
- **A `method_ref` request gets a fetch-sized budget.** Resolving an address can make the server clone a repository before it answers, and the server-side clone timeout runs well past the client's 30s management budget on a cold cache — an abort there would report a healthy, still-cloning server as unreachable. A `method_ref`-carrying `start` uses the blocking-execute ceiling (like a bundle-carrying one), and a `method_ref`-carrying `resolve`, `codegen`, `buildInputs`, or `buildOutput` uses an internal 3-minute budget (`buildRunner`'s own five-minute default already clears it); both are internal (no new caller-facing parameters) and inert behind the hosted gateway's own cap.

### Changed

- **Breaking: the client-side by-id expansion legs are deleted.** `buildInputs({ method_id })` (the `BuildInputsByMethodId` request form) and `prepareInputs({ method_id })` no longer exist: both routes take `files` only, and `BuildRequestBase` pins `method_id` to `never` — the `/v1/build/*` projections are deliberately excluded from the hosted tooling selector. The rule is now uniform: a `method_id` option is always a server pass-through, and client-side expansion is the caller's own explicit `getMethodClosure` call, which stays public as the local expansion utility. An untyped caller still passing `method_id` to either route gets a teaching error naming the migration (`prepareInputs({ files: await client.getMethodClosure(methodId), … })`).
- **`start` returns `PipelexRunResultStart`.** A widening of the previous `RunResultStart` return type (one typed optional field over the extension index signature) — no caller change needed.
- **`extra` now also rejects `method_ref`**, for the same reason it rejects every named request option: `extra` merges last into the body, so a smuggled copy would overwrite the validated named option and bypass the selector-exclusivity checks.

## [v0.15.0] - 2026-08-28

### Added

- **Compile-time type assertions:** `tests/validate-report-types.test.ts` pins `pipe_io_contracts` and `input_form` to their exact `mthds/protocol` types, so a later edit cannot silently widen either field back to a bare record. The assertions bite in `npm run typecheck:test`, which `make check` runs.
- **Architecture documentation:** `docs/architecture.md` gains a "Standard artifacts on the validate report" section recording which fields are imported from the standard, which stay opaque, and why importing enforces the same boundary the opaque typing was reaching for.

### Changed

- **Breaking: the validate report types its standard artifacts by importing them.** `PipelexValidationReport.pipe_io_contracts` and `PipelexValidationReport.input_form` are now `PipeIOContracts` and `InputForm` from `mthds/protocol`, in place of the `Record<string, unknown>` they were. Reading a slot's presence, a field descriptor's kind, or a contract's JSON Schema no longer needs a cast, and a consumer walking either artifact gets exhaustiveness checking over the discriminated unions. The wire is unchanged, so a consumer that only reads and forwards these payloads needs no edit; one that assigned a hand-rolled shape or indexed them as bare records must update. `bundle_blueprint` and `graph_spec` stay opaque, because the standard declares neither.
- **The `mthds` floor moves from `^0.22.0` to `^0.24.0`.** The floor spans two releases: `0.23.0` first carried `mthds/protocol`'s `input_form` and `pipe_io_contracts` modules, and `0.24.0` then tightened `InputFormTopLevelField` into a discriminated union on `required`, so the standard's pairing rules are enforced by the compiler rather than left as prose. Because the barrel re-exports `mthds/protocol` unchanged, every type the two artifacts are built from is reachable from `@pipelex/sdk` with no second import.
- **Test payloads:** the mocked validation payloads in `tests/client.test.ts` now use realistic, fully typed contract and descriptor pairs instead of placeholder objects, matching the new strict types.
- **Internal tooling:** the `bump-required-versions` Claude skill is renamed `bump-mthds`, with its prompts and the `check-min-versions` documentation updated to match.

### Fixed

- **Dev-scope security refresh:** `package-lock.json` was regenerated to move four transitive lint- and test-toolchain dependencies past their patched versions — `brace-expansion`, `js-yaml`, `nanoid` and `postcss`. None of them reaches the published package.

## [v0.14.0] - 2026-08-25

### Added

- **The validate report's valid arm mirrors the wire field-for-field.** `PipelexValidationReport` gained three fields that had been riding through untyped, so reaching them no longer needs a cast. `warnings` carries the advisory lints on a valid bundle — the same item shape as `validation_errors[]`, so one parser serves both channels, but they never flip `is_valid`. `liftable_pipes` lists the pipes the runtime may skip when an optional slot resolves absent, through the new `LiftablePipeEntry` type. `input_form` is an optional structured view of per-pipe input-form descriptors, derived from authored facts rather than the emitted JSON Schema, so a renderer can build a fill-in form from the verdict alone; its payload stays opaque because `@pipelex/mthds-form` owns that descriptor vocabulary and a second copy here would be free to drift.
- **`views`, the structured-view opt-in, on `validate` and `validateFiles`.** A sibling to `render`: `render` asks for rendered text, `views` asks for a structured view — today only `input_form`. Unlike `render`, which this client always populates, `views` is sent only when a caller names a token, so a response with no tokens stays byte-identical to previous versions. Unknown tokens are lenient-ignored rather than a `422`.
- **Deterministic repair proposals on `ValidationErrorItem`.** The item gained `missing_pipe_code` (symmetrical with the `missing_concept_code` already there) and `suggested_fix`, the server's repair proposal, along with the `SuggestedFix` / `FixOp` / `FixSafety` vocabulary it carries — a discriminated union over the patch kinds, so narrowing on `kind` reaches each op's own members without a cast. These are semantic patches over the `.mthds` document rather than a text diff, which is what lets an applier preserve the author's formatting.
- **`method_id` is a typed run option.** `execute`, `start`, and `startAndWaitForResult` now take the hosted platform's `method_id` as a named option, through the new `PipelexRunOptions` / `PipelexStartOptions` types. It is a pure pass-through — the platform resolves the id against the org's catalog and nothing is expanded client-side. Alone it is a run source; alongside an inline source the inline source is what runs and the id is recorded as run-history linkage. An empty string is treated as absent.
- **`deleteMethod`.** `DELETE /v1/methods/{id}` had always existed on the platform and simply was not exposed. It returns the platform's acceptance as the new `MethodDeletionAccepted` (`method_id`, `deletion_state`, `deletion_job_id`), so the asynchronous erasure is honest in the type: a resolved promise means "accepted", never "gone" — completion is the row disappearing from `listMethods`. A double-clicked delete is a `409 conflict` rather than a second cascade over the same runs.

### Changed

- **Breaking: `validate()` takes `views` as its fifth argument**, moving the trailing options bag to sixth. Callers passing that bag positionally must add an argument; `validateFiles` is unaffected, taking `views` as a named option like `render`.
- **Breaking: every optional member of `ValidationErrorItem` widened from `T` to `T | null`.** The two channels serialize an unset locator differently and one type has to be honest about both: the invalid arm drops the key, while the valid arm — which is what carries `warnings[]` — emits an explicit `null`. A truthiness check reads both and needs no change; an `=== undefined` check was already wrong on one of them and now fails to compile.
- **Breaking: `extra` now rejects `method_id`.** It joins the reserved keys because the client now names it itself, and one argument must not arrive by two paths with different validation. Callers passing `extra: { method_id }` — an undocumented but working path — must pass the named option instead. The guard is deliberately per layer: `method_id` must never become reserved in the protocol clients, which have no business rejecting another vendor's arguments.
- **The client-side run-source precondition counts `method_id`.** A `method_id`-only run is accepted and sent, where previously only an `extra` entry made such a body pass. The error message when nothing at all is supplied now names the hosted selector.

### Fixed

- **Documentation: no more citations a reader cannot open.** This package is public, and several docstrings, comments and doc passages cited internal specs and the conformance suite by bare repo-relative path — paths that resolve to nothing for anyone who clones this repo, so they read as rot rather than as a deliberate boundary. Each site now states the rule it was citing instead: the layered extension policy behind `PipelexHostedRunExtensions` and the reserved-`extra` guard, and the fact that `TokensUsageRecord` is a Pipelex runtime extension rather than an MTHDS Protocol contract. No behaviour changed.
- **Documentation: the crate routes are hosted everywhere now.** `docs/crate-routes.md` and the crate-extensions comment in `src/client.ts` announced a partial hosted exposure — dev yes, prod not yet — which stopped being true when `api.pipelex.com` picked up `POST /v1/resolve` and `POST /v1/codegen`; both were re-measured with a real key on 2026-08-23. `lint` and `format` are still `403` on every hosted origin, and both places now say why that blocks nothing: linting and formatting `.mthds` are toolchain capabilities, run offline by the post-edit hook this repo builds (`npm run build:hook`) through `@pipelex/tools-wasm`, with `client.lint` / `client.format` as the published package's documented fallback.

## [v0.13.0] - 2026-08-20

### Added

- **Offline codegen drift check**: Added `runCodegenCheck`, a pure helper that verifies a committed codegen tree still matches its `codegen.lock` — no filesystem, no network, no API key, and no `PipelexApiClient`. The caller walks its own tree and passes the lock text plus the files; the SDK returns a structured `CodegenCheckReport` (`drifts[]`, `isCurrent`, and the lock header's `crateFingerprint` / `engineVersion`). It is a port of pipelex's `codegen check`, so a verdict computed here equals the one the CLI computes over the same bytes, down to the drift `detail` sentences. This is the CI half of the codegen trust chain: regeneration needs the engine, checking needs only hashes.
- **Codegen check types**: Exported `CodegenCheckInput`, `CodegenCheckReport`, `CodegenDrift`, `CodegenDriftCategory`, `CodegenTreeFile`, and the `CodegenLockError` raised for a no-verdict condition (a malformed lock or an unsafe artifact path). `CodegenTreeFile` is structurally identical to `GeneratedArtifact`, so a `codegen()` response's `artifacts` feed the check with no mapping.
- **Tree-walk filter**: Exported `isStampableArtifactPath` and `STAMPABLE_ARTIFACT_SUFFIXES`, mirrors of pipelex's `STAMPABLE_SUFFIXES`, so a consumer's directory walk picks up exactly the files the check considers. An incomplete walk yields a false `isCurrent`, so filtering identically is part of the contract.
- **`codegen.lock` format version**: `runCodegenCheck` now reads the `lock_version` key pipelex writes at the head of every lock, mirroring the reference's evolution policy. A lock with no key is version 1 by definition, so every lock written before the field existed keeps working untouched; a version this build does not know is refused with a message naming the version found and which side to upgrade. The version is read **before** the key set is validated, so a lock from a newer codegen reports its version rather than an opaque complaint about whichever key it happens to carry — which is the whole reason the field exists, since the reader is otherwise strict enough to turn any added key into a hard no-verdict.
- **Dependency**: Added `smol-toml` (`^1.6.0`) to `dependencies` for parsing `codegen.lock`. It installs no new package — `mthds` already depends on the same range, so the two dedupe to one copy.
- **Tests**: Added `tests/codegen-check.test.ts` with vendored real codegen output under `tests/fixtures/codegen/` (artifacts and lock from an actual `pipelex codegen types` run, committed beside their source bundle), and extended `tests/e2e/crate.e2e.ts` to run the check over artifacts a live server just emitted — verbatim, then mutated once per drift category, for both a TypeScript and a Python target. A `.gitattributes` rule (`tests/fixtures/** -text`) freezes those bytes: the fixtures exist to pin hashes, and a line-ending rewrite on checkout would invalidate every one of them on the platforms most likely to run CI.
- **Documentation**: `docs/crate-routes.md` gains an offline-check section covering the algorithm, the drift taxonomy, the caller's obligations, what the check deliberately does not verify, and the two places it knowingly differs from the CLI. `docs/architecture.md` gains `codegen-check.ts` in the module map, records why the check is a standalone pure helper rather than a client method, and describes the two-layer testing strategy behind it; `README.md` points at it from the overview.

### Changed

- **Packaging**: `package.json` now declares `"sideEffects"`, so bundlers can tree-shake unused modules out of a consumer's client bundle. It is the array form rather than a blanket `false`, naming `./dist/hooks/claude-mthds-check.js` — the Claude Code hook entry self-executes at module scope (`main()` … `process.exit(0)`) and ships in the tarball, so a blanket `false` would be a false claim about the published package. Every module reachable from the `.` export is genuinely side-effect-free.
- **Repository hygiene**: `.gitignore` now ignores `.env` and every `.env.*` variant, keeping `!.env.example` tracked, in place of the lone `.env.local` rule. `make test-e2e` reads `PIPELEX_E2E_BASE_URL` and `PIPELEX_API_KEY` from `.env`, so the very file the E2E loop asks you to create was one `git add -A` away from committing an API key.

### Fixed

- **An uncommented line inside a stamp header is now `hand-edited`**, closing a gap where an injected statement verified as pristine. Every line the emitter writes between the stamp fences carries the comment prefix, so anything else there was injected by hand — and the content hash covers only the body *below* the fence, so such a line changed nothing the check looked at and the file reported current. The parser now rejects a header region containing any unprefixed line, matching the reference. The line-boundary set this gate splits on is load-bearing rather than incidental: U+2028 and U+2029 terminate a `//` comment in ECMAScript, so a narrower split would read an injected statement as one commented line while the JavaScript engine reads two and runs it.
- **Stamp-header parsing now matches Python's text rules**, closing four places where `runCodegenCheck` and `pipelex codegen check` reached different verdicts on the same bytes. The header is split on the boundaries `str.splitlines()` breaks on rather than `\n` alone (a U+2028 inside a field value truncates it upstream, so the SDK used to report a tree current that the CLI reported `hand-edited`, and a header whose lines were joined by one flipped the other way); field values are stripped with Python's `str.isspace()` set rather than JavaScript's `trim()`, which strips U+FEFF where Python does not and skips U+001C-U+001F and U+0085 where Python does not; and a Windows drive prefix is now any single leading character before `:`, as `PureWindowsPath` sees one, so `1:models.py` and `_:models.py` are rejected like the reference rejects them instead of being accepted. Each is pinned by a test that fails without it.

## [v0.12.0] - 2026-08-19

### Added

- **Crate Routes API**: Added `resolve()` and `codegen()` to `PipelexApiClient` for the new `POST /v1/resolve` and `POST /v1/codegen` endpoints. `resolve()` returns the normalized library crate (MTHDS Library Crate Format) with fully qualified refs and materialized natives; `codegen()` projects a crate into stamped typed artifacts and a `codegen.lock` file (supporting the `types` kind and `ts-zod`, `python-pydantic`, or `python-structures` targets).
- **Crate Route Types**: Exported new TypeScript models: `CrateRequestBase`, `ResolveRequest`, `ResolveValidReport`, `ResolveResponse`, `CodegenKind`, `CodegenTarget`, `CodegenRequest`, `CodegenValidReport`, and `CodegenResponse`.
- **Crate Route Tests**: Added unit (`tests/crate-routes.test.ts`) and E2E (`tests/e2e/crate.e2e.ts`) suites validating the new crate routes against live servers.
- **Crate Route Documentation**: Added `docs/crate-routes.md`, covering the shared envelope, the verdict discipline, and the codegen trust chain.

### Changed

- **Unified Request Envelopes**: `BuildRequestBase` now extends the new `CrateRequestBase`, unifying the `files` / `method_ref` closure selector across the build and crate route families to prevent structural drift. `docs/build-routes.md` documents the split.
- **E2E Pipeline**: `make test-e2e` now runs a fast-failing `curl` preflight probe (against `/v1/version`) before handing off to Vitest, exiting immediately with a clear one-line error if the server is unreachable. The Makefile also loads `.env` variables (`PIPELEX_E2E_BASE_URL`, `PIPELEX_API_KEY`) via standard dotenv precedence and strips trailing slashes from `PIPELEX_E2E_BASE_URL` to avoid malformed probe URLs.
- **Documentation**: Updated `README.md` and `docs/architecture.md` for the v0.11.0 pagination API, replacing outdated array-return examples with the `MethodPage`, `iterateMethods`, `RunPage`, and `iterateRuns` patterns.

### Fixed

- **E2E Reachability Probe**: Moved the reachability check from the origin-level `/health` endpoint to `/v1/version`, fixing a false-negative where hosted origins (which do not serve the bare runner `/health` route) were reported as unreachable.

### Removed

- **Lockfile**: Removed `pnpm-lock.yaml` from the repository.

## [v0.11.0] - 2026-08-18

### Changed

- **Breaking: `listMethods` returns one PAGE of summaries, not the whole catalog.** The signature is now `listMethods(query?) -> MethodPage` (`{items, nextCursor}`) instead of `listMethods() -> MethodData[]`, matching the platform's reshaped `GET /v1/methods`.

  This one is a **data-loss fix**, not a scaling improvement. The old endpoint issued a single DynamoDB query with no `LastEvaluatedKey` loop, and every row carried the method's whole `.mthds` bundle plus its generated Python. DynamoDB caps a query page at 1 MB, so the response stopped at roughly 200–300 methods — and stopped *silently*: no error, no truncation flag, just a shorter array than the org actually owned. Methods disappeared from the UI and nothing said so. The endpoint is now served from a narrow index projection, so a page costs the same whether the org has 50 methods or 100,000.

  **Migrating:** code that rendered the returned array directly should read `page.items` (accepting the first 50) or follow `page.nextCursor`. Callers that genuinely want everything can drain the new `iterateMethods`, but it is O(catalog) by construction and should not back a user-facing list.

  `query.q` searches server-side over name + description across the whole catalog — filtering a single page client-side would be searching 50 of 10,000 and calling it a search.

- **Breaking (types): list rows are `MethodSummary`, not `MethodData`.** `mthds`, `python` and `updated_at` are absent, because none of them is in the index projection — and putting `mthds` back is what restored the truncation bug. Use `getMethod(id)` when you need a method's source. `updated_at`'s absence is deliberate too: the catalog is ordered by `created_at` (immutable — over a mutable sort key a cursor duplicates and skips rows), and displaying a timestamp other than the one it sorts by makes "newest first" unreadable.

### Added

- **`iterateMethods(query?)`** — an async iterator that follows the cursor **past empty pages**. A filtered page can legitimately come back empty with a live cursor: the platform applies `q` as a post-read filter over a bounded slice of the index per request, so `{items: [], next_cursor: "…"}` means "nothing matched in the slice I just read, keep going". Stopping there would silently drop every later match. It gives up only when the server stops advancing its cursor — a runaway ceiling on total pages exists but sits far beyond any real catalog, and **throws** rather than returning, because a caller that asked for everything and got a partial answer with no error is the very bug this release removes. (`iterateRuns` may stop on an empty page: its date bounds are index key conditions, so a run page is never empty-with-a-cursor. The difference is the server, not the client.) It is an iterator, for callers that genuinely want the whole catalog: `for await (const m of client.iterateMethods())`. Deliberately **not** a `listAllMethods(): Promise<MethodSummary[]>`, for the same reason `iterateRuns` is an iterator: an all-at-once helper needs a page cap, and a cap means silently returning a truncated list — the exact failure paging exists to remove.
- `MethodSummary`, `MethodPage`, `ListMethodsQuery` and `MethodDeletionState` are exported.
- **`MethodSummary.deletion_state`** is surfaced on list rows. It was already on the wire but missing from the SDK's types, so consumers were relying on structural assignment to reach it. A method mid-erasure stays in the list — so the UI can render it as "Deleting…" — while `getMethod` refuses it with a 409.

## [v0.10.0] - 2026-08-12

### Changed

- **Breaking: `listRuns` returns one PAGE, not the whole history.** The signature is now `listRuns(methodId, query?) -> RunPage` (`{items, nextCursor}`) instead of `listRuns(methodId) -> PipelineRun[]`, matching the platform's reshaped `GET /v1/runs`. The old call read the method's entire run history on every invocation — the API paged a DynamoDB partition to exhaustion and sorted in memory, which cost ~150 sequential round trips at 5,000 runs and would not complete at 100k. The endpoint is now served from a time-ordered index, so a page costs the same whether the method has 50 runs or 100,000.

  **Migrating:** code that rendered the returned array directly should read `page.items` (accepting the first 50) or follow `page.nextCursor`. Callers that genuinely want everything — an export, a report — can drain the new `iterateRuns`, but it is O(history) by construction and should not back a user-facing list.

  `query.createdFrom` / `query.createdTo` filter server-side as index key conditions, so a bounded page genuinely reads less. They are **instants, not days**: ISO-8601 with a UTC offset, and a naive timestamp is a 400. Only the caller knows which timezone's day it means — it is the one rendering the rows — so it converts its own day boundaries rather than having the API guess, which is what made a bare `YYYY-MM-DD` ambiguous.

### Added

- **`iterateRuns(methodId, query?)`** — an async iterator that follows the cursor, for callers that genuinely want the whole history: `for await (const run of client.iterateRuns(id))`. Deliberately **not** a `listAllRuns(): Promise<PipelineRun[]>`. An all-at-once helper needs a page cap so a misbehaving server cannot spin it forever, and a cap means silently returning a truncated list — 6,000 runs quietly yielding 5,000, from a method called "all". That is the same failure paging was introduced to remove. Streaming has no cliff: it yields until the server says there is no more, the caller `break`s whenever it likes (a search that hits on page one never fetches page two), and only one page is ever in memory. `Array.fromAsync` makes materialising the lot an explicit choice.
- **`getRunDetail(runId)` — `GET /v1/runs/{id}`**, the only call that returns `mthds_contents` (what the run actually executed) and `inputs`. It is deliberately not on the status read, which pollers hit every few seconds, nor on the list, where the bundle would be multiplied by the page size. The bundle matters because a run is not reproducible from its `method_id`: a caller may run an editor buffer that was never saved.
- `RunPage`, `RunDetail`, `RunErrorReport` and `ListRunsQuery` are exported.
- **Breaking (types): `PipelineRun.method_id` and `.pipe_code` are now `string | null`.** Both are `str | None` on the API and both really are null in practice — an ad-hoc run (started from an inline bundle) belongs to no stored method, and `pipe_code` is null when the runner resolved the pipe from the bundle's `main_pipe`. The old required types could not represent a real response, so consumers narrow instead of trusting a promise the wire never made.

## [v0.9.0] - 2026-07-24

### Fixed

- **`prepareInputs` now accepts the explicit `{ concept, content }` input envelope, not only compact values.** An agent that fills the explicit template `buildInputs({ explicit: true })` returns — the default template shape the hosted console and MCP hand out — can now hand it straight back to `prepareInputs`. Previously every file-bearing envelope position threw `InputPreparationError: Unsupported value at a file input … got object`, breaking the `buildInputs(explicit) → fill → prepareInputs` round-trip. Per input, the caller may submit either the compact value or the `{ concept, content }` envelope (a plain object whose keys are exactly `concept` + `content`, matching the runtime's `_is_explicit`); the envelope's `content` is interpreted identically and preserved on output, so the concept annotation rides through to the run — the runtime accepts it. Nested / list / structured file positions and mixed compact+envelope inputs are all handled. See [`docs/input-preparation.md`](./docs/input-preparation.md).

## [v0.8.0] - 2026-07-24

### Added

- **`python` on the methods catalog model.** `MethodData` and `MethodWriteInput` gain an optional `python` field — the custom PipeFunc Python that travels with a stored method — typed as `MethodFile[]` (`{ name, content }`), so a `method_id`-run client can round-trip stored Python. On the wire it is the serialized `[{ name, content }]` catalog string; the client (de)serializes it at the boundary via `mthds/protocol`'s canonical `parseMethodFiles`/`serializeMethodFiles` (one owner of the format, no per-consumer parser mirror). Three-way on a `PUT`: **omit** preserves the stored Python (nothing sent), an **empty array** `[]` clears it (serialized to the `""` sentinel), a **non-empty array** replaces it. Raises the `mthds` floor to `^0.22.0` (the release that exports the `MethodFile` serialization).

## [v0.7.0] - 2026-07-24

### Added

- **Method-bundle transport on `execute` / `start`: run a method whose custom PipeFunc Python travels with it.** A run can now carry the whole method — the `.mthds` plus its `funcs/*.py`, `structures/*.py` and an optional `requirements.txt` — instead of only the inline `mthds_contents` text, so a method with custom Python is runnable through this SDK. Two equivalent, mutually exclusive encodings on the run options: `files` (a `{ relativePath: text }` map) and `bundle_b64` (the same bundle as a base64 zip). A bundle is self-contained, so it satisfies the "something to run" precondition on its own — neither `pipe_code` nor `mthds_contents` is required beside it, and a bundle-only call is now accepted rather than rejected as under-specified. The bundle is forwarded on the durable `start` path **and** on the blocking `execute` fallback, so a bare runner reached through `startAndWaitForResult` runs the same method as a hosted one.

  Run-source rules are enforced from the standard rather than restated here: `assertExclusiveRunSources` and `hasBundlePayload` are imported from `mthds/protocol` (new in `mthds` 0.21.0), so this client and the MTHDS runners cannot drift on which combinations they reject. Combining the two encodings, or either encoding with non-empty `mthds_contents`, raises `PipelineRequestError`. Exclusivity keys off **presence** (supplying `files: {}` alongside `bundle_b64` is still two encodings) while the run-source precondition keys off **runnability** (an empty encoding carries no method, so it is neither shipped on the wire nor counted as something to run). `files`, `bundle_b64`, and the client-only `bundleMain` entrypoint hint are all reserved keys on the `extra` passthrough — `extra` merges last into the body, so smuggling one through it would overwrite the validated fields, bypass the exclusivity check, or leak a never-serialized hint onto the wire; `buildExtensions` rejects any of them. `buildExtensions` also strips prototype-pollution keys (`__proto__` / `constructor` / `prototype`) so an `extra` populated from untrusted JSON never carries a pollution gadget on the wire. A bundle-carrying `start` is given the blocking path's upload timeout rather than the short poll timeout, so a large bundle can't time out on the durable path yet succeed on the fallback.

  Because the barrel re-exports `mthds/protocol`, both predicates are also available to consumers directly from `@pipelex/sdk`.

### Changed

- **Raised the `mthds` floor to `^0.21.0`** (was `^0.19.0`), adopting the method-bundle run-source surface and the protocol-level run-source predicates the transport above is built on.

## [v0.6.0] - 2026-07-23

### Added

- **By-id closure resolution: prepare and build inputs from a stored `method_id`.** `prepareInputs` and `buildInputs` now accept the method closure as a stored catalog `method_id` in place of inline `files` — `client.prepareInputs({ method_id, pipe_ref?, inputs })` and `client.buildInputs({ method_id, pipe_ref?, format?, explicit? })`. `method_id` is a client-side convenience, not a wire field: it is resolved to inline `files` via the new `getMethodClosure` before the request reaches the network, so a by-id call produces exactly the same result as the equivalent inline-`files` call and `method_id` never travels on the wire (it is distinct from the reserved `BuildRequestBase.method_ref` registry reference — that one still 501s). Supply `files` or `method_id`, never both — the either/or is a compile-time invariant (`PrepareInputsRequest` and `BuildInputsRequest` both forbid the over-specified `{ files, method_id }`), backed by runtime guards that reject both the degenerate neither-given and the over-specified both-given cases before any closure is resolved (so an untyped caller never silently gets `method_id` preferred over inline `files`). By-id resolution requires an API key (the catalog is org-scoped to the key's org). New exported client param type `BuildInputsByMethodId`. See [`docs/input-preparation.md`](./docs/input-preparation.md).
- **`getMethodClosure(methodId)` on `PipelexApiClient`** — resolve a stored method's id into its runnable, provenance-labelled MTHDS closure (`MthdsFileItem[]`, each file's `source` set to the method id). A client-side semantic layer over `getMethod` (the platform has no route that returns a parsed closure): it fetches the method, parses its polymorphic `mthds` source, and labels each file. An unknown or foreign-org id surfaces as the `getMethod` `404` (`ApiResponseError`, `code: "not_found"`); a real in-org method whose source parses to nothing throws the new `EmptyMethodSourceError`.
- **`methodSourceToContents(mthds)` — exported canonical source parser.** Turns a stored method's polymorphic `mthds` field — raw single-bundle text XOR a JSON `{ name, content }[]` file array — into a flat list of file contents, dropping blank entries. A verbatim port of the platform's `_method_source_to_contents`, so the SDK and the runtime read a stored source identically. Exported from the barrel for consumers that need the parse without the fetch (`getMethodClosure` is the fetch-and-parse convenience over it, and `pipelex-mcp` can retire its own parser mirror once it adopts this).
- **`EmptyMethodSourceError`** (extends `InputPreparationError`, carries `methodId`) — a by-id closure resolution found the stored method but its source parses to no runnable content (the row exists, no runnable source yet). It joins the input-preparation failure family (catch `InputPreparationError` to handle any preparation failure), and is deliberately distinct from the `ApiResponseError` `404` raised for an unknown or foreign-org id.
- **`MethodData` read-model fields: `org_id`, `created_by_user_id`, and a server-derived `description`.** The methods read model now carries the org and creator ids present on every `GET`/list response, plus `description` — parsed read-side by the platform from the bundle's top-level `description` key (present on reads, absent from the write contract, so typed `string | null | undefined`). Additive; the `MethodWriteInput` create/update payload is unchanged.

### Changed

- **Removed `deleteMethod` (breaking).** The client method wrapped `DELETE /v1/methods/{id}`, a route the hosted platform does not have and will not add by design — deletion of a saved method is an explicit product decision, not a default the SDK should imply. Callers relying on it must drop it; there is no replacement route.

## [v0.5.1] - 2026-07-22

### Security

- **Bumped the transitive dev dependency `brace-expansion` to a patched release (CVE-2026-13149 / GHSA-3jxr-9vmj-r5cp).** The vulnerable `5.0.6` copy pulled in via `@typescript-eslint` — exponential-time expansion of consecutive non-expanding `{}` groups, a DoS that can stall the calling thread — is updated to `5.0.7`; the unaffected top-level `1.x` copy moves to its latest patch in the same lockfile update. Lockfile-only change with no effect on the published runtime surface: `brace-expansion` is dev-only and is never shipped in `@pipelex/sdk`.

## [v0.5.0] - 2026-07-22

### Added

- **Input preparation: `uploadFile` and `prepareInputs` (hosted upload capability).** Two higher-level operations over the raw `upload()` wire call. `client.uploadFile(asset, options?)` uploads one local asset — `Blob`/`File`/`ArrayBuffer`/`Uint8Array` in every runtime, a filesystem path string in Node only (it fails instructively elsewhere) — and returns an `UploadRecord` (`uri`, `contentType`, `size`, `filename`) assembled client-side. `client.prepareInputs({ files, pipe_ref?, inputs })` resolves the target pipe's declared signature from the explicit inputs template, interprets the caller's compact `inputs` top-down against it (the file signal is the canonical Image/Document content shape — a `{url:…}` dict — mirroring the runtime's `input_normalizer`), uploads the file-bearing values, and returns `PreparedInputs`: a copy-on-write rewrite of `inputs` with each asset reference replaced by canonical content carrying `pipelex-storage://` in `url`, plus one `UploadRecord` per prepared asset. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through unchanged; data URLs and local/byte sources are uploaded; the same source referenced twice uploads once (dedup by source identity); all failures are raised before any run is created. Failures are typed per category: `InvalidLocalSourceError`, `RejectedAssetError`, `UnsupportedUploadCapabilityError`, `UploadAuthenticationError`, `UploadTransportError` (all extend `InputPreparationError`). `prepareInputs` takes the method closure as inline `files`; catalog `method_id` resolution and opt-in `http(s)` ingest are deferred and additive. See [`docs/input-preparation.md`](./docs/input-preparation.md).
- **Typed run usage: `RunResults.tokens_usages` + `RunResults.usage_assembly_error`.** The per-call usage records a run produces — token counts by category, the server-computed `cost` in USD, model name and id, the pipe that made the call, job-kind fields and timing, for LLM and img-gen/extract/search calls alike — are now first-class typed fields. Records are typed by a new exported `TokensUsageRecord` interface (`src/runs.ts`) mirroring the wire contract specified in the MTHDS protocol spec. Both paths populate the pair: the hosted durable path reads it off `GET /v1/runs/{id}/results` (which unpacks the runner's `tokens_usages.json` artifact), and the blocking fallback lifts the same pair out of the execute response's extension-open `pipe_output` — so `result.tokens_usages` reads the same regardless of which path ran.

  Note that the rate table (`unit_costs`) no longer crosses the wire: a record now carries the computed `cost` for the call instead, which is null when the model has no rate table at all (own-GPU, mock, dry run) and `0` when a rate table priced it at zero. There is no run-level aggregate — sum the records.

  `tokens_usages` is null whenever usage assembly produced no list (it was off, it broke, or the run was delivered before the artifact existed) and `[]` when assembly ran and no inference happened; `usage_assembly_error` is the only field separating a broken assembly from an off one. `TokensUsageRecord` keeps every field optional and carries an index signature, so durable artifacts written before the contract shipped — relayed verbatim, never migrated — still type-check: `cost` and `pipe_code` arrive absent, and the legacy `job_metadata` / `unit_costs` stay reachable. Enum-ish fields (`model_type`, `job_category`, `unit_job_id`) are open sets typed as plain `string`, so runtime enum churn stays non-breaking.

### Changed

- **`RunResults.pipe_output` is now `DictPipeOutput | null`, was `Record<string, unknown> | null` (breaking).** The blocking path already had the concrete shape and widened it away; it now carries the typed value straight through. Read the working memory as properties — `result.pipe_output!.working_memory.root["out"]!.content` — rather than casting. The durable path still leaves it null.
- **`DictPipeOutput` is now extension-open** (gains `[extension: string]: unknown`), matching its Python counterpart `DictPipeOutputAbstract`, which has always been `extra="allow"`. The runner rides Pipelex extension fields on the pipe output — the usage pair is the current example — so a closed type forced every reader to cast the whole value away and left the two SDK mirrors of one wire shape disagreeing on whether it was closed. Widening only; existing reads are unaffected.

## [v0.4.0] - 2026-07-15

### Added

- **Tools routes (`lint` and `format`)**: Added `PipelexApiClient.lint(content, source?)` and `PipelexApiClient.format(content, options?)` for the new `/v1/lint` and `/v1/format` endpoints, providing single-file static diagnostics and canonical formatting without a full bundle load or dry-run. Both follow `validate`'s discipline: malformed content is a produced verdict on a `200` carrying `diagnostics[]` — never a thrown error — while a no-verdict condition (malformed body, malformed formatter `options`, auth, a server fault) is non-2xx and surfaces as the typed `ApiResponseError`. New exported wire types: `Diagnostic`, `DiagnosticKind`, `DiagnosticRange`, `LintResponse`, `FormatResponse`. `lint` is the cheap single-file check and does not replace `validate`, which loads the bundle, resolves across files, and dry-runs the pipes.
- **PostToolUse hook bundle**: Introduced a dependency-free ESM hook bundle (`dist-hooks/check.mjs`, built via `npm run build:hook` from new `src/hooks/` sources) that agent plugins (first consumer: `pipelex-plugins`) vendor as a static hook asset. It runs local lint/format via `@pipelex/tools-wasm` (offline, credential-free, format writes back in place), then fetches the full bundle verdict from `POST /v1/validate` through this SDK, forwarding the server-rendered Markdown as the block reason, subject to the hook's output cap. Bundle files are gathered recursively from parent directories with caps — on overflow the validate stage reads as unavailable rather than risking a false block on an under-supplied bundle. Fail-open posture throughout: a missing `PIPELEX_API_KEY`, network faults, timeouts, or any non-2xx silently skip the validate stage while the local lint/format verdicts still apply. To bundle an unreleased engine build, point `PIPELEX_TOOLS_WASM_PATH` at a `vscode-pipelex/js/tools-wasm` checkout.
- **Live E2E testing pipeline**: Added an E2E test suite (`tests/e2e/*.e2e.ts`, own `vitest.e2e.config.ts`) that runs against a live `pipelex-api` server via `make test-e2e` (or `make te`), excluded from `make test` so CI never needs a server; target a specific instance with `PIPELEX_E2E_BASE_URL` (default `http://localhost:8081`). It verifies the real endpoint contracts the unit mocks cannot: `lint` / `format` / `validate` verdicts on clean and malformed bundles, and the full build-route surface (`tests/e2e/build.e2e.ts`) — selector defaulting and both un-defaultable arms, source-label threading, the `format`→field mapping, the stamped structures projection, the `200` invalid arm, and the `422` / `501` no-verdict arms — reusing the server's own build-route fixtures so both sides test one closure.
- **Documentation**: Added `docs/build-routes.md` detailing the shared envelope, discriminated verdicts, and format-specific payloads of the `/v1/build/*` routes. Updated `docs/architecture.md` to reflect the new testing layers, tools routes, and hook bundle.
- **Cooperative cancellation on the build/tools and validate routes**: `buildRunner` (and the whole extension tier it shares — `lint`, `format`, `buildInputs`, `buildOutput`, `concept`, `pipeSpec`) accepts `signal?: AbortSignal` alongside `timeoutMs`, and `validate` / `validateFiles` gain the same `{ timeoutMs, signal }` options — a caller that abandons a long dry-run sweep or bundle validation cancels the request instead of waiting out the timeout. A caller abort propagates its reason untouched, matching the run-lifecycle routes. The post-edit hook now bounds its validate call through these options, so a timed-out hook actually aborts the in-flight request.

### Changed

- **Raised the `mthds` dependency floor to `^0.19.0` (Breaking)**: That release is where the MTHDS side of the `/v1/build/*` migration landed — the `files[]` envelope, the qualified `pipe_ref`, and the discriminated build verdicts this SDK implements below — so an older `mthds` no longer satisfies the protocol surface the client's route shapes are typed against.
- **Build routes use the `files[]` envelope (Breaking)**: `buildInputs`, `buildOutput`, and `buildRunner` now accept the closure as `files: [{content, source?}]` XOR a reserved `method_ref`, plus an optional qualified `pipe_ref` (`domain.pipe_code`) that defaults to the closure's `main_pipe` — replacing the retired `mthds_contents` and bare `pipe_code`. `allow_signatures` survives only on `buildRunner`, the one build route that still dry-runs the closure. The per-file `source` label rides through to the diagnostics, so an invalid verdict can name the file that caused it when attribution is available. _Migration_: change `{mthds_contents: [src], pipe_code: "echo"}` to `{files: [{content: src}], pipe_ref: "smoke.echo"}` (or drop `pipe_ref` to default to `main_pipe`).
- **Build routes return discriminated 200 verdicts (Breaking)**: Following `validate`'s discipline, an unresolvable closure is the successful product of the call — a `200` with `is_valid: false` and `validation_errors[]` — instead of throwing. Consumers must branch on `is_valid` before reading the payload arm. `BuildRunnerResponse` is now the union `BuildRunnerValidReport | CrateInvalidReport` (its valid arm carries `python_code` plus the stamped `structures` projection, replacing the old flat `{python_code, pipe_code, success, message}`), and `buildInputs` / `buildOutput` — previously typed `Promise<unknown>` — get the same treatment. New exported types: `InputsTemplateFormat`, `MthdsFileItem`, `BuildRequestBase`, `CrateInvalidReport`, `BuildInputsValidReport`, `BuildOutputValidReport`, `BuildRunnerValidReport`, `GeneratedArtifact`, `RunnerStructures`, `BuildInputsResponse`, `BuildOutputResponse`.
- **Build payloads follow the requested `format` (Breaking)**: `buildInputs` populates `inputs` for `format: "json"` (the default) and `inputs_toml` for `format: "toml"`; `buildOutput` populates `output` for `format: "schema"`/`"json"` and `output_python` for `format: "python"`. Unselected format fields are absent from the body rather than `null` — so the valid reports are discriminated unions on `format`, not interfaces with optional fields: narrowing on `format` hands you the selected field as required and makes the other statically unreachable. `buildInputs` also gains an `explicit` request flag that opts into the ceremonial `{concept, content}` envelope per input instead of the default light shape.

### Fixed

- **`buildRunner` timeout**: `buildRunner` no longer inherits the standard 30-second management timeout, which previously caused a false `ApiUnreachableError` for large closures that legitimately exceed 30s during dry-run — blaming the caller's network for a perfectly healthy server. It now has a dedicated 5-minute default, overridable per-call via `buildRunner(request, { timeoutMs })`; `lint`, `format`, `buildInputs`, `buildOutput`, `concept` and `pipeSpec` keep the 30s default, which is right for them.
- **Request timeout now covers the response body read**: the transport previously disarmed its timeout as soon as the response headers arrived, so a server that stalled mid-body could hang a request indefinitely past the advertised ceiling — and a failed body read was silently swallowed into an empty body. The timer and abort signal now stay armed until the body has fully arrived, and an aborted or failed read surfaces as the typed timeout/abort error. Applies to every route.
- **Build route error taxonomy**: Non-2xx responses on build routes (e.g., `422` for an unresolvable pipe selector — an unknown `pipe_ref`, or an omitted one on a closure that declares no `main_pipe`, or several — `501` for the reserved `method_ref`) now throw a typed `ApiResponseError` instead of a bare `Error` string, letting callers branch reliably on `ApiResponseError.status` instead of matching on prose. `concept` and `pipeSpec` ride the same helper and pick this up too.

## [v0.3.1] - 2026-07-10

### Changed

- Bumped the `mthds` dependency floor to `^0.18.0` (was `^0.16.0`), keeping it current with the latest published `mthds`. The intervening `mthds` releases are CLI/tooling changes — `0.17.0` adds the `mthds-agent inputs upload` subcommand and an `MthdsApiClient.uploadFile()` method; `0.18.0` adds Codex version detection and turns hook-disabling config keys into hard errors — none of which touch the `mthds/protocol` wire types `@pipelex/sdk` imports. The SDK's own code is unchanged, so this is a coordination floor; the green `make check` / `make test` run confirms the route shapes still type-check against `mthds@0.18.0`.

## [v0.3.0] - 2026-07-05

### Changed

- **One output accessor across both execution modes: `result.main_stuff` (Breaking).** `RunResults.main_stuff` was optional (`main_stuff?: unknown`) and callers had to fall back to `pipe_output` and shape-guess the main output on the blocking path. Leaning on the pipelex >= 0.37 main-stuff invariant (every completed run delivers a main stuff), the SDK now delivers a resolved, non-null main output on **both** paths under the same accessor. The durable path returns a `RunResults` whose `main_stuff` is the `main_stuff.json` S3 artifact; `execute()` now returns a **`PipelexExecuteResult`** (a `DictRunResultExecute` subtype) whose `.main_stuff` getter resolves the output out of the returned working memory via the response's `main_stuff_name`. Consumers read `result.main_stuff` directly on either path — no `main_stuff ?? pipe_output` fallback, no shape-guessing, no branching on which path ran. The full working memory still rides `pipe_output` (blocking path only) for consumers that want it. _(Migration: read `result.main_stuff` instead of `result.main_stuff ?? result.pipe_output`.)_

### Added

- **`PipelexExecuteResult`.** The blocking `execute()` result type — a `DictRunResultExecute` with a resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a durable `RunResults`. `main_stuff_name` is declared as a typed field on this Pipelex-branded subtype (the neutral `mthds` wire model leaves it in its extension index signature).
- **`MissingMainStuffError`.** A completed run that cannot deliver a main stuff now throws this typed error (extends `PipelineRequestError`, carries `runId`) instead of silently yielding a null output: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking `execute` response named a `main_stuff_name` absent from its working-memory root. A falsy-but-present main stuff (empty array, `0`) is a valid output and does not throw.

## [v0.2.1] - 2026-07-03

### Fixed

- **CJS consumers can now `require("@pipelex/sdk")`.** The package is ESM-only (`"type": "module"`), but its `exports` map only declared `import` and `types` conditions, so `require()` failed with `No "exports" main defined`. Added a `default` condition pointing at the existing ESM build (`dist/index.js`) — Node's `require(ESM)` support (stable since Node 20.19 / 22.12) loads it without a separate CJS build. Also reordered the `exports` conditions so `types` precedes `import`/`default`, matching TypeScript/Node's condition-ordering convention.
- Raised the `engines.node` floor to `>=22.12.0` (was `>=22`) — the earliest Node 22.x release with unflagged `require(ESM)`, which the fix above depends on.

## [v0.2.0] - 2026-07-02

### Changed

- **Breaking — `PipelexApiClient` constructor option renamed `apiToken` → `apiKey`.** Aligns the option name with the `PIPELEX_API_KEY` environment variable it falls back to (matching the same rename in `mthds`'s `MthdsApiClient`). Update `new PipelexApiClient({ apiToken })` call sites to `new PipelexApiClient({ apiKey })`. The wire (the `Authorization: Bearer` header) and the env-var fallback are unchanged.
- **Breaking — API base URL env var renamed `PIPELEX_API_URL` → `PIPELEX_BASE_URL`.** For consistency with the internal `baseUrl` naming and coordinated with the `MTHDS_API_URL` → `MTHDS_BASE_URL` rename in the `mthds` clients. There is no read alias — update any environment or deployment that sets `PIPELEX_API_URL`.
- Bumped the `mthds` dependency floor to `^0.16.0` (was `^0.15.0`), adopting its `MthdsApiClient` `apiToken` → `apiKey` and `MTHDS_API_URL` → `MTHDS_BASE_URL` renames — the source of the two breaking renames above.

## [v0.1.5] - 2026-06-30

### Changed

- Bumped the `mthds` dependency floor to `^0.15.0` (was `^0.14.0`). `mthds@0.15.0` removes the Pipelex-API `/v1/validate` narrowing from its surface (`MthdsApiClient.validate()` now returns the standard's neutral `ValidationResult`), making `@pipelex/sdk` the sole owner of `PipelexValidationResult` and its arms. The SDK's own code is unchanged — it imports only the `mthds/protocol` wire types, which are identical across the bump — so this is a coordination floor that keeps the brand boundary unambiguous (only one package exports the Pipelex narrowing).

## [v0.1.4] - 2026-06-30

### Changed

- Bumped the `mthds` dependency floor to `^0.14.0` (was `^0.13.1`), picking up the latest published MTHDS protocol wire types.

### Added

- `make use-local` / `make use-npm` (shorthands `make ul` / `make un`) to switch the `mthds` dependency between a file link to the sibling `../mthds-js` checkout for live development and the published npm package (latest by default, or a pinned `VERSION=x.y.z`).

## [v0.1.3] - 2026-06-28

### Changed

- Raised the minimum supported Node.js to 22 (`engines.node: ">=22"`). Node 18 (end-of-life April 2025) and Node 20 (end-of-life April 2026) are past maintenance and are no longer supported; the floor now matches the `@types/node` major the SDK is built against. npm only warns on an engine mismatch unless the consumer sets `engine-strict`, so this is a support-policy change rather than a hard install gate.
- Bumped the `mthds` dependency floor to `^0.13.1` (was `^0.13.0`); its `0.13.1` release raises its own Node.js floor to 22 in lockstep with this SDK.
- CI now builds and tests on Node.js 22 (was Node.js 20).
- Migrated the remaining workflow actions off the deprecated Node.js 20 runtime so they run on Node.js 24 natively: `actions/create-github-app-token` (v1 → v3), `actions/upload-artifact` (v4 → v7), and `actions/download-artifact` (v4 → v8). The third-party `contributor-assistant/github-action` still ships a Node.js 20 runtime and will emit the deprecation warning until an upstream release migrates it.

## [v0.1.2] - 2026-06-28

### Changed

- CI: bumped `actions/checkout` and `actions/setup-node` from v4 to v5 across all workflows. The v4 releases bundle the deprecated Node.js 20 runtime (force-run on Node.js 24 with a deprecation warning); v5 targets Node.js 24 natively. The SHA-pinned release checkout now points to the v5.0.1 commit.

### Fixed

- The exported `SDK_VERSION` constant was stale (`0.1.0`) because the release flow never bumped it — consumers reading it for diagnostics or compatibility checks saw a version that disagreed with the published npm version. It is now bumped in lockstep with `package.json` and guarded by a test that asserts the two stay equal.

## [v0.1.1] - 2026-06-28

### Changed

- The `mthds` dependency is now consumed from npm as a published version (`^0.13.0`) instead of a GitHub branch ref. This pins the upstream MTHDS protocol types to a released package rather than a moving branch.

## [v0.1.0] - 2026-06-27

### Added

- Initial release of `@pipelex/sdk` — the TypeScript SDK for the Pipelex hosted API. House-style toolchain mirrored from `mthds-js`: ESM-only `tsc` build (NodeNext, strict), Vitest 4 with v8 coverage, ESLint 9 flat config, Prettier 3, dependency-cruiser boundary enforcement (`@pipelex/sdk → mthds` only via the `mthds/protocol` subpath), and a `Makefile` task surface. CI parity (quality checks, npm OIDC trusted publishing, changelog/version guards).
- `PipelexApiClient` — the Pipelex product client. Owns its own `request()` pipeline (auth, base URL, timeouts/abort, RFC 7807 problem-details parsing) and implements the MTHDS protocol-execution routes using `mthds/protocol` types (`implements MTHDSProtocol<DictPipeOutput>`): `execute`, `start`, `validate` (returns the `PipelexValidationResult` 200-diagnostic union), `validateFiles`, `models`, `version`. Adds the Pipelex build helpers (`/v1/build/*`) and the durable run lifecycle (`getRunStatus` / `getRunResult` / `waitForResult` / `startAndWaitForResult`, with hosted-vs-bare runner self-healing). Env vars `PIPELEX_API_KEY` / `PIPELEX_API_URL`; default base URL `https://api.pipelex.com`.
- Typed errors (`ApiResponseError`, `ApiUnreachableError`, `PipelineExecuteTimeoutError`, run-lifecycle errors), all deriving from the protocol-base `PipelineRequestError` re-exported from `mthds/protocol`. `ApiResponseError` carries the product routes' stable RFC 9457 `code` discriminant.
- Pipelex product routes on `PipelexApiClient` — the hosted management surface (user profile, methods catalog CRUD, organizations, billing, Pipelex API keys, gateway API key, onboarding, storage, runs list/update). All ride the shared `requestProduct<T>` helper (30s management timeout, empty-body tolerant) and the same `{base}/v1/*` + `Authorization: Bearer` + org-from-JWT contract; non-2xx `problem+json` maps to `ApiResponseError` with the structured `code`. Thin snake_case wire models in `product-models.ts`.
