/**
 * Pipelex-product wire models — the snake_case JSON shapes the hosted-product
 * routes (`/v1/me`, `/v1/methods`, `/v1/organizations`, `/v1/billing/*`,
 * `/v1/pipelex-api-keys`, `/v1/onboarding/submit`,
 * `/v1/resolve-storage-url`, `/v1/upload`, `/v1/upload/grant`, `/v1/runs`) speak.
 *
 * These are the management surface a consumer (today `pipelex-app`) hand-rolls.
 * The wire is snake_case; any camelCase remap is a consumer's UI concern and
 * stays in the consumer. Each model holds only the fields the product actually
 * consumes — not a speculative mirror of every server field.
 */

import type { MethodFile } from "mthds/protocol";

import type { RunErrorReport } from "./error-models.js";
import type { PipelexValidationResult } from "./models.js";
import type { RunStatus } from "./runs.js";

// ── User profile (`/v1/me`) ─────────────────────────────────────────────

export interface UserProfile {
  email: string;
  user_id: string;
  full_name: string;
  /** ISO timestamp the user completed onboarding; absent/null until they do. */
  onboarding_completed_at?: string | null;
}

// ── Methods catalog (`/v1/methods`) ──────────────────────────────────────
//
// A saved method has a draft and published versions. The method's content fields
// (`mthds`, `python`, `input_data`) are its DRAFT: written freely by `writeDraft`, never
// validated on write. A VERSION is an immutable copy of the draft, numbered from 1 and
// never reused, written only by `publishMethod` and only when the draft validates and
// runs. A bare `method_id` runs the latest published version, `mt_…@<n>` a fixed
// version and `mt_…@draft` the draft; the method routes themselves take a bare id
// (`parseMethodSelector` strips a suffix).

/**
 * One published version without its sources — what `listMethodVersions` lists, what a
 * method read carries as `latest_published`, and what a publish answers as `version`.
 */
export interface MethodVersionSummary {
  /** The version number, from 1, never reused and never renumbered. */
  version: number;
  /**
   * SHA-256 of the canonical form of the version's two file sets (`.mthds` and Python), as 64
   * lowercase hex characters — the same function as the method's `draft_digest`, so equal
   * digests mean the same sources would run.
   */
  source_digest: string;
  /**
   * The runner's `crate.fingerprint` for the bundle (`POST /v1/resolve`), which covers its
   * meaning rather than its bytes and is what generated client code is checked against.
   * `null` when the runner validated the bundle but could not resolve it in memory, as for a
   * bundle that depends on another method by address.
   */
  crate_fingerprint: string | null;
  /** The version of the runner that validated the bundle and computed the fingerprint. */
  runner_version: string | null;
  /** The bundle's top-level `description` at publish time. */
  description: string | null;
  /** ISO-8601 UTC instant of the publish. */
  published_at: string;
  /**
   * The publisher's canonical user id, or `system:publish-initial` for a version the one-time
   * migration wrote for a method saved before versions existed.
   */
  published_by: string;
}

/**
 * One published version with its sources — `getMethodVersion`. It carries no `name`, which
 * belongs to the method and changes without a publish, and no `input_data`, which is the
 * editor's form state and not part of what a caller runs.
 */
export interface MethodVersion extends MethodVersionSummary {
  method_id: string;
  /** The version's `.mthds` source, in the same stored form as `MethodData.mthds`. */
  mthds: string;
  /**
   * The version's custom-PipeFunc Python, as `MethodFile[]`, parsed from the wire string
   * exactly as `MethodData.python` is. Empty array when the version has no custom Python.
   */
  python?: MethodFile[];
}

/**
 * A saved method — `getMethod`, `createMethod`, `writeDraft`, `renameMethod`, and the
 * `method` of every publish outcome. Its content fields ARE the draft; the latest
 * published version is summarized in `latest_published`.
 *
 * The publish state a client shows is derived, never stored: never published
 * (`latest_version` is `null`), published with the draft unchanged (`draft_digest ===
 * latest_published.source_digest`), or published with the draft ahead (they differ).
 */
export interface MethodData {
  method_id: string;
  org_id: string;
  created_by_user_id: string;
  name: string;
  /** The draft's `.mthds` bundle source. */
  mthds: string;
  /**
   * The draft's custom-PipeFunc Python sources, as `MethodFile[]` (`{ name, content }`). On
   * the wire this is the serialized `[{ name, content }]` catalog string (empty
   * `""` when the method has no custom Python); the client (de)serializes it via
   * `mthds/protocol`'s `parseMethodFiles`/`serializeMethodFiles`, so callers work
   * with the typed array. Empty array when the method has no custom Python.
   */
  python?: MethodFile[];
  /** The editor's form inputs, saved with the draft and outside both digests. */
  input_data?: Record<string, unknown> | null;
  /** Legacy persisted output spec; optional. */
  pipe_output?: Record<string, unknown> | null;
  /**
   * Derived from the draft's top-level `description`. Read-side only: the
   * server recomputes it from the draft on every draft write, so it never appears on
   * the write contract.
   */
  description?: string | null;
  created_at: string;
  /**
   * **The draft's token.** It moves on every draft write and on nothing else: creation sets
   * it, and neither a rename nor a publish moves it. Echo it verbatim — the platform compares
   * the strings — as `expected_updated_at` on the next `writeDraft`, or as
   * `expected_draft_updated_at` on `publishMethod`, so neither ever overwrites or publishes a
   * draft the caller has not seen.
   */
  updated_at: string;
  /**
   * The draft's digest: SHA-256 of the canonical form of its two file sets, 64 lowercase hex
   * characters. `input_data` is outside it, so saving only the form inputs moves the token and
   * leaves the digest as it was.
   */
  draft_digest: string;
  /** The number of the latest published version; `null` when the method was never published. */
  latest_version: number | null;
  /** The latest published version's summary; `null` when the method was never published. */
  latest_published: MethodVersionSummary | null;
}

/** Where a method is in the erasure cascade; absent on a normal method. */
export type MethodDeletionState = "pending" | "in_progress" | "failed";

/**
 * The `202` acceptance of `DELETE /v1/methods/{id}` — returned the moment the
 * erasure is CLAIMED and handed off, not when it completes.
 *
 * Nothing in this body means "done": completion is the method's row
 * disappearing from `listMethods`. What the body buys you is a claim you can
 * log and correlate (`deletion_job_id`) and the state the cascade started in.
 */
export interface MethodDeletionAccepted {
  method_id: string;
  deletion_state: MethodDeletionState;
  deletion_job_id: string;
}

/**
 * One row of the method LIST — deliberately much smaller than `MethodData`.
 *
 * The list is served from a narrow DynamoDB index projection, so `mthds` and
 * `python` are **not here and never will be**. That is the whole point: the
 * previous list returned every method's full bundle, hit DynamoDB's 1 MB page
 * cap at a couple hundred methods and silently returned a SHORT ARRAY —
 * methods vanished from the UI with no error at all. Use `getMethod(id)` when
 * you need the bundle.
 *
 * `updated_at` is absent by design too. The catalog is ordered by `created_at`
 * (immutable — over a mutable sort key a cursor duplicates and skips rows), and
 * displaying a different timestamp from the one it sorts by makes "newest
 * first" unreadable.
 */
export interface MethodSummary {
  method_id: string;
  name: string;
  description?: string | null;
  created_at: string;
  /**
   * Set while an erasure cascade is running. A method mid-deletion stays IN the
   * list — so the UI can render it as "Deleting…" — while `getMethod` refuses
   * it with a 409.
   */
  deletion_state?: MethodDeletionState | null;
}

export interface ListMethodsQuery {
  /**
   * Case-insensitive substring match over a method's name and description,
   * applied SERVER-side across the whole catalog. Filtering one page
   * client-side would be searching 50 of 10,000 and calling it a search.
   */
  q?: string;
  /** Page size. The API defaults to 50 and caps at 200. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of the method catalog, newest first.
 *
 * `nextCursor` is opaque — pass it straight back to `listMethods` to continue;
 * `null` means this was the last page. There is deliberately no total:
 * counting would mean reading the whole catalog, which is the cost paging
 * exists to avoid.
 */
export interface MethodPage {
  items: MethodSummary[];
  nextCursor: string | null;
}

/**
 * The create payload — `createMethod`. A new method holds this as its draft and has no
 * version yet. Its draft is then written with `writeDraft` and its name changed with
 * `renameMethod`.
 */
export interface MethodWriteInput {
  name: string;
  mthds: string;
  /**
   * Custom-PipeFunc Python as `MethodFile[]`, serialized to the catalog string on the wire;
   * omitted or an empty array, the method has none.
   */
  python?: MethodFile[];
  input_data?: Record<string, unknown> | null;
}

/**
 * The draft write — `writeDraft`, `PUT /v1/methods/{id}/draft`. It never validates: a draft
 * may be invalid, and an autosave of work in progress often is.
 */
export interface MethodDraftInput {
  /** The draft's `.mthds` files, in the stored serialized form. Required. */
  mthds: string;
  /**
   * Custom-PipeFunc Python as `MethodFile[]`. Three-way: **omit** (`undefined`) keeps the
   * stored Python (the client sends nothing); an **empty array** `[]` clears it (the client
   * serializes it to `""`); a **non-empty array** replaces it. It is a replace, not a merge —
   * send the full set on a write that intends to change it.
   */
  python?: MethodFile[];
  /**
   * The editor's form inputs. Three-way too: **omit** keeps the stored inputs, an explicit
   * `null` clears them, and any other value replaces them.
   */
  input_data?: Record<string, unknown> | null;
  /**
   * The draft token the caller last saw — the `updated_at` of the method it last read or
   * wrote, echoed verbatim. With it the write is a compare-and-swap: a draft that moved since
   * is refused with a `409` whose `code` is `method_update_conflict`, and nothing is written.
   * Omitted, the write is last-writer-wins.
   */
  expected_updated_at?: string;
}

/** The rename — `renameMethod`, `PATCH /v1/methods/{id}`. It moves no token. */
export interface MethodRenameInput {
  /** The method's new name, non-empty. */
  name: string;
}

/** The publish — `publishMethod`, `POST /v1/methods/{id}/publish`. */
export interface MethodPublishInput {
  /**
   * The draft token the caller last saw (`MethodData.updated_at`), echoed verbatim. Required: a
   * publish never takes a draft its caller has not seen, so a draft that moved since is
   * refused with a `409` whose `code` is `method_update_conflict`, and nothing is published.
   */
  expected_draft_updated_at: string;
}

/** What a publish did with the draft — the discriminant of `MethodPublishResult`. */
export type MethodPublishOutcome = "published" | "unchanged" | "refused";

/**
 * Why a draft was not published: `invalid`, it does not validate; `not_runnable`, it validates
 * with pending signatures, so it is valid but does not run yet.
 */
export type MethodPublishRefusalReason = "invalid" | "not_runnable";

/** A publish that wrote a new version. */
export interface MethodPublished {
  outcome: "published";
  /** The new version's summary. */
  version: MethodVersionSummary;
  method: MethodData;
}

/**
 * A publish with nothing to publish: the draft's digest equals the latest version's, so no
 * runner was asked. Also the answer to the loser of two concurrent publishes of the same draft.
 */
export interface MethodPublishUnchanged {
  outcome: "unchanged";
  /** The existing latest version's summary. */
  version: MethodVersionSummary;
  method: MethodData;
}

/** A publish the draft's content refused: nothing was published. */
export interface MethodPublishRefused {
  outcome: "refused";
  reason: MethodPublishRefusalReason;
  /** Says why; for `not_runnable`, that the draft "is valid but does not run yet". */
  message: string;
  /**
   * The runner's `POST /v1/validate` answer for the draft, verbatim: an invalid arm whose
   * `validation_errors` say what to fix, or, for `not_runnable`, the valid arm.
   */
  validation: PipelexValidationResult;
  method: MethodData;
}

/**
 * The answer of `publishMethod`, a `200` discriminated on `outcome` because each arm is a
 * verdict about the draft's content. Branch on `outcome`, never on the status: a stale token,
 * a method being deleted, a draft with no `.mthds` file or an unreachable runner are thrown as
 * `ApiResponseError` instead, since they produce no verdict about the content.
 */
export type MethodPublishResult = MethodPublished | MethodPublishUnchanged | MethodPublishRefused;

/** Query for one page of a method's versions. */
export interface ListMethodVersionsQuery {
  /** Page size. The API defaults to 20 and caps at 100. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of a method's published versions, newest first, without their sources.
 *
 * `nextCursor` is opaque — pass it straight back to `listMethodVersions` to continue; `null`
 * means this was the last page. Versions are read whole on the server, so a page may be short
 * while `nextCursor` is set. A method never published answers an empty page.
 */
export interface MethodVersionPage {
  items: MethodVersionSummary[];
  nextCursor: string | null;
}

// ── Organizations (`/v1/organizations`) ──────────────────────────────────

export interface Membership {
  org_id: string;
  /** Null for the implicit personal org (no backing WorkOS organization). */
  workos_organization_id: string | null;
  name: string;
  is_personal: boolean;
  role_in_org: "admin" | "member";
}

export interface MembershipsResponse {
  memberships: Membership[];
  active_org_feature_flags: string[];
}

// ── Billing (`/v1/billing/*`) ────────────────────────────────────────────

export interface SubscriptionResponse {
  plan: string | null;
  status: string | null;
  can_use_service: boolean;
  renews_at?: string | null;
  ends_at?: string | null;
}

export interface PlanView {
  slug: string;
  name: string;
  price_display: string;
  monthly_price_cents: number;
  period: string;
  features: string[];
  highlight: boolean;
  is_current: boolean;
}

export interface InvoiceView {
  id: string;
  created_at: string;
  status: string;
  amount_cents: number;
  currency: string;
  card_brand: string | null;
  card_last_four: string | null;
  refunded: boolean;
  download_url: string | null;
}

export interface CheckoutResponse {
  checkout_url?: string;
}

export interface ChangePlanResponse {
  plan?: string;
  status?: string;
  charged_immediately?: boolean;
  resumed?: boolean;
}

export interface BillingPortalResponse {
  portal_url?: string;
}

// ── Pipelex API keys (`/v1/pipelex-api-keys`, `plx_sk_…`) ────────────────

export interface PipelexApiKey {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

/** The create/rotate response — the plaintext `api_key` is returned ONCE. */
export interface PipelexApiKeyCreated {
  api_key: string;
  id: string;
  label: string;
  prefix: string;
  created_at: string;
}

export interface PipelexApiKeyList {
  keys: PipelexApiKey[];
}

// ── Onboarding (`/v1/onboarding/submit`) ─────────────────────────────────

export type OnboardingRole = "developer" | "founder" | "data_scientist" | "researcher" | "other";
export type OnboardingCurrentTool =
  "langchain" | "crewai" | "llamaindex" | "custom" | "none" | "other";
export type OnboardingInputType =
  "documents" | "images" | "videos" | "audio" | "structured_data" | "text";
export type OnboardingHeardFrom =
  "twitter" | "youtube" | "hackernews" | "discord" | "friend" | "google" | "conference" | "other";

export interface OnboardingSubmission {
  role: OnboardingRole;
  company?: string;
  use_case: string;
  process_to_transform: string;
  input_types: OnboardingInputType[];
  material_domain: string;
  current_tool: OnboardingCurrentTool;
  current_tool_other?: string;
  heard_from: OnboardingHeardFrom;
}

// ── Storage (`/v1/resolve-storage-url`, `/v1/upload`, `/v1/upload/grant`) ──

export interface ResolvedStorageUrl {
  url: string;
  expires_at: string;
  content_type: string | null;
}

/** Upload payload — base64 `data` (the multipart hop is browser→BFF only). */
export interface UploadInput {
  filename: string;
  data: string;
  content_type: string;
}

export interface UploadedFile {
  uri: string;
  filename: string;
}

/**
 * What an upload grant is requested for — `POST /v1/upload/grant`. The file is
 * described, never sent: its bytes go to storage with the grant, from wherever
 * they are held.
 */
export interface UploadGrantInput {
  /** The original filename with its extension; the stored object keeps the extension. */
  filename: string;
  /**
   * MIME type, signed into the grant so the upload must carry it. Omitted, `null`
   * or empty, none is signed — a browser's `File.type` is empty for a type it
   * does not know, and means the same.
   */
  content_type?: string | null;
  /** The file's exact size in bytes. The grant accepts a body of this size and no other. */
  size: number;
}

/**
 * A presigned, create-only `PUT` for one new object in the caller's organization,
 * and the `pipelex-storage://` URI that object will carry. A bearer capability
 * until `expires_at`: whoever holds it can write that one object, once, so it is
 * never logged. `uploadWithGrant` (also on the browser-safe `@pipelex/sdk/upload`
 * entry) is the sender.
 */
export interface UploadGrant {
  /** The reference the object carries — it names nothing until the `PUT` has succeeded. */
  uri: string;
  /** Where to `PUT` the file, as the raw request body. */
  url: string;
  /**
   * The signed headers to send unchanged: `If-None-Match: *`, the `Content-Type`
   * when one was declared, and the provenance `x-amz-meta-*` values. `Content-Length`
   * is signed too but is not listed — the body sets it, so the body must be
   * exactly the declared size.
   */
  headers: Record<string, string>;
  /** ISO-8601 UTC instant after which storage refuses the `PUT`. */
  expires_at: string;
  /** The largest file any grant allows, in bytes (the service's upload cap). */
  max_bytes: number;
}

// ── Runs list / update (`/v1/runs`) ──────────────────────────────────────
//
// The run-lifecycle status/results/start routes already live on the client
// (`runs.ts`); these are the remaining catalog-style list + admin-update routes.

/** Per-pipe progress marker surfaced in a run's `pipe_statuses` map. */
export type PipeStatus = "scheduled" | "running" | "succeeded" | "failed" | "skipped";

/**
 * A run's record — the base of `RunDetail`, which `getRunDetail` returns. The run-history list
 * does not return it: its rows are the slimmer `RunHistoryItem`.
 */
export interface PipelineRun {
  pipeline_run_id: string;
  /** `null` on an ad-hoc run — one started from an inline bundle belongs to no
   *  stored method, and is reachable only by id. The API models this as
   *  `str | None`, so narrow it before using it as a key. */
  method_id: string | null;
  /** `null` when the runner resolved the pipe from the bundle's `main_pipe`
   *  rather than being told which one to run. */
  pipe_code: string | null;
  org_id?: string;
  /** Who started it — denormalised so attribution needs no extra lookup. */
  created_by_user_id?: string;
  workflow_id?: string | null;
  status: RunStatus;
  result_url?: string | null;
  pipe_statuses?: Record<string, PipeStatus> | null;
  created_at: string;
  finished_at?: string | null;
  /** The runner's stored error report, typed whole — present only on a failed run
   *  whose completion callback carried one. This is how a consumer tells the user
   *  WHY a run failed rather than showing a generic message. */
  error?: RunErrorReport | null;
  /**
   * Which version of its method the run ran: the version number for a run addressed by a
   * bare id (the latest published version) or by `mt_…@<n>`, `"draft"` for one addressed by
   * `mt_…@draft`, and `null` for a run of an inline source. Absent on a run recorded by a
   * platform that did not record it yet.
   */
  method_version?: number | "draft" | null;
  /**
   * The digest of the files the run ran, in the canonical form of `MethodData.draft_digest`, so
   * an inline run identical to a version records that version's `source_digest`. `null` when
   * the platform never held the files, as on a `method_ref` run; absent on a run recorded by a
   * platform that did not record it yet.
   */
  source_digest?: string | null;
}

/**
 * One row of a method's run history — an item of `listRuns`' page and of `iterateRuns`.
 *
 * Exactly what a history row shows, and nothing more: the run's id, when it started and
 * finished, whether it succeeded, which pipe it ran and, for a failed run, why. The rest of the
 * run's record — its organization, its creator, its method (the caller just named it), its
 * workflow id — is not sent on the list; read it with `getRunDetail` (or `getRunStatus`) once a
 * run is opened.
 */
export interface RunHistoryItem {
  pipeline_run_id: string;
  status: RunStatus;
  /** ISO-8601 instant the run was created. */
  created_at: string;
  /** ISO-8601 instant the run reached a terminal status; `null` or absent while it runs. */
  finished_at?: string | null;
  /** `null` when the runner resolved the pipe from the bundle's `main_pipe`. */
  pipe_code?: string | null;
  /** The runner's stored error report — present only on a failed run that recorded one,
   *  so opening it from history shows why without another read. */
  error?: RunErrorReport | null;
  /**
   * Which version of the method the run ran — a number, `"draft"`, or `null` for an inline
   * source (see `PipelineRun.method_version`). The history lists the runs of every version
   * and of the draft together, so this is how a row says which one it was.
   */
  method_version?: number | "draft" | null;
  /** The digest of the files the run ran (see `PipelineRun.source_digest`). */
  source_digest?: string | null;
}

/**
 * A single run, whole — `GET /v1/runs/{id}`.
 *
 * `mthds_contents` is what the run ACTUALLY executed, and it is the only record
 * of that: a caller may run an editor buffer that was never saved, so the stored
 * method can have moved on since — or never existed, for an ad-hoc run.
 *
 * Both fields are deliberately absent from the list and from the polled status
 * read: together they are the run's whole source, tens of KB, which would be
 * multiplied by the page size on one and by the poll rate on the other.
 */
export interface RunDetail extends PipelineRun {
  /** One entry PER `.mthds` FILE, not one bundle string — the same array shape
   *  the protocol's validate call takes and echoes back. A single-file method
   *  is an array of one. */
  mthds_contents?: string[] | null;
  /** The inputs the run was started with, as sent. */
  inputs?: Record<string, unknown> | null;
}

/** Query for one page of run history. */
export interface ListRunsQuery {
  /**
   * Only runs created at or after this INSTANT — ISO-8601 with a UTC offset
   * (`2026-06-02T00:00:00+09:00`). Inclusive. A bare `YYYY-MM-DD` or a naive
   * timestamp is rejected by the API: only the caller knows which timezone's
   * day it means, so convert your own day boundaries to instants.
   */
  createdFrom?: string;
  /** Only runs created at or before this instant. Same rules as `createdFrom`. */
  createdTo?: string;
  /** Page size. The API defaults to 50 and caps at 200. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of run history, newest first.
 *
 * `nextCursor` is opaque — pass it straight back to `listRuns` to continue;
 * `null` means this was the last page. There is deliberately no total: counting
 * would mean reading the whole history, which is the cost paging exists to
 * avoid.
 */
export interface RunPage {
  items: RunHistoryItem[];
  nextCursor: string | null;
}

/** The admin/manual run-status patch — `status` is a free string here. */
export interface UpdateRunInput {
  status: string;
  result_url?: string;
  finished_at?: string;
}
