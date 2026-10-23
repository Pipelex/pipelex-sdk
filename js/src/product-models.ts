/**
 * Pipelex-product wire models — the snake_case JSON shapes the hosted-product
 * routes (`/v1/me`, `/v1/methods` and its examples, `/v1/organizations`, `/v1/branding`, `/v1/billing/*`,
 * `/v1/pipelex-api-keys`, `/v1/onboarding/submit`,
 * `/v1/resolve-storage-url`, `/v1/upload`, `/v1/upload/grant`, `/v1/files`, `/v1/runs`) speak.
 *
 * These are the management surface a consumer (today `pipelex-app`) hand-rolls.
 * The wire is snake_case; any camelCase remap is a consumer's UI concern and
 * stays in the consumer. Each model holds only the fields the product actually
 * consumes — not a speculative mirror of every server field.
 */

import type { RunErrorReport } from "./error-models.js";
import type { MethodTreeForms } from "./method-trees.js";
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
// A saved method has a draft and published versions. Its DRAFT is a method tree, the same
// files a run takes, with the editor's `input_data`: written freely by `writeDraft`, never
// validated on write. A VERSION is an immutable copy of the draft's tree, numbered from 1
// and never reused, written only by `publishMethod` and only when the draft validates and
// runs. Each names its tree by its digest, and a read lists the tree's files with a link to
// each one's bytes (see `docs/method-trees.md`). A bare `method_id` runs the latest
// published version, `mt_…@<n>` a fixed version and `mt_…@draft` the draft; the method
// routes themselves take a bare id (`parseMethodSelector` strips a suffix).

/**
 * One file of a saved method's tree, as `getMethod` and `getMethodVersion` list it, in tree path
 * order. `writeMethodTree` downloads and writes a listing.
 */
export interface SavedMethodFile {
  /** Its tree path. */
  path: string;
  /** The SHA-256 of its bytes, 64 lowercase hex characters. */
  sha256: string;
  /** Its size in bytes. */
  size: number;
  /**
   * A link to its bytes, signed by storage, which any HTTP client reads with no credential. It is
   * a bearer credential until it expires: keep it out of logs, messages and stored records.
   */
  url: string;
  /** ISO-8601 UTC instant the link stops working, about fifteen minutes after the read. */
  expires_at: string;
}

/**
 * One published version without its files — what `listMethodVersions` lists, what a
 * method read carries as `latest_published`, and what a publish answers as `version`.
 */
export interface MethodVersionSummary {
  /** The version number, from 1, never reused and never renumbered. */
  version: number;
  /**
   * The digest of the version's tree, `sha256:` and 64 lowercase hex characters — the same
   * function as the method's `draft_digest`, so equal digests mean the same files would run.
   * `null` for a version stored before methods were trees and never rewritten as one.
   */
  tree_digest: string | null;
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
 * One published version with its files — `getMethodVersion`. It carries no `name`, which
 * belongs to the method and changes without a publish, and no `input_data`, which is the
 * editor's form state and not part of what a caller runs.
 */
export interface MethodVersion extends MethodVersionSummary {
  method_id: string;
  /** The version's tree, one entry per file in tree path order, each with a link to its bytes. */
  files: SavedMethodFile[];
}

/**
 * A saved method — `createMethod`, `writeDraft`, `renameMethod`, and the `method` of every
 * publish outcome; `getMethod` answers it with the draft's files (`MethodDetail`). Its draft is
 * named by `draft_digest`; the latest published version is summarized in `latest_published`.
 *
 * The publish state a client shows is derived, never stored: never published
 * (`latest_version` is `null`), published with the draft unchanged (`draft_digest` is not
 * `null` and equals `latest_published.tree_digest`), or published with the draft ahead (they
 * differ).
 */
export interface MethodData {
  method_id: string;
  org_id: string;
  created_by_user_id: string;
  name: string;
  /** The editor's form inputs, saved with the draft and outside its digest. */
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
   * The draft's tree digest, `sha256:` and 64 lowercase hex characters; `null` for an empty
   * draft. `input_data` is outside it, so saving only the form inputs moves the token and leaves
   * the digest as it was.
   */
  draft_digest: string | null;
  /** The number of the latest published version; `null` when the method was never published. */
  latest_version: number | null;
  /** The latest published version's summary; `null` when the method was never published. */
  latest_published: MethodVersionSummary | null;
  /**
   * Where the method is in the erasure cascade; absent or `null` on a normal method. Every
   * method route refuses a method whose erasure has started with a `409`
   * `method_being_deleted`, so a method read seldom carries it; `MethodSummary` carries the
   * same field on the list, where a method mid-erasure stays listed.
   */
  deletion_state?: MethodDeletionState | null;
}

/**
 * A saved method with its draft's files — what `getMethod` answers. `files` lists the draft's
 * tree in tree path order, each file with its SHA-256, its size and a link to its bytes valid for
 * about fifteen minutes, and is empty for an empty draft; `writeMethodTree` brings it to disk.
 */
export interface MethodDetail extends MethodData {
  files: SavedMethodFile[];
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
 * The list is served from a narrow DynamoDB index projection, so a method's files
 * are **not here and never will be**. That is the whole point: a list that returned
 * every method's full bundle hit DynamoDB's 1 MB page cap at a couple hundred methods
 * and silently returned a SHORT ARRAY — methods vanished from the UI with no error at
 * all. Use `getMethod(id)` when you need the files.
 *
 * `updated_at` is absent by design too. The catalog is ordered by `created_at`
 * (immutable — over a mutable sort key a cursor duplicates and skips rows), and
 * displaying a different timestamp from the one it sorts by makes "newest
 * first" unreadable.
 *
 * The row carries the method's publish state, so a list tells its methods apart without
 * reading each one: never published (`latest_version` is `null`), published with the draft
 * unchanged (`draft_digest` is not `null` and equals `latest_published.tree_digest`), or
 * published with the draft ahead (they differ). The three fields are absent from a platform that
 * does not serve them.
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
  /** The number of the latest published version; `null` when the method was never published. */
  latest_version?: number | null;
  /** The latest published version's summary; `null` when the method was never published. */
  latest_published?: MethodVersionSummary | null;
  /** The draft's tree digest, as `MethodData.draft_digest`; `null` for an empty draft. */
  draft_digest?: string | null;
}

export interface ListMethodsQuery {
  /**
   * Case-insensitive substring match over a method's name and description,
   * applied SERVER-side across the whole catalog. Filtering one page
   * client-side would be searching 50 of 10,000 and calling it a search.
   */
  q?: string;
  /**
   * `true` lists only the methods with a published version, `false` only those never
   * published; omitted, both. It combines with `q`, and like `q` it filters after the index
   * read, so a page can come back empty and still carry a `nextCursor`.
   */
  published?: boolean;
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
 *
 * Under `q` or `published` a page can hold fewer rows than `limit`, or none, and still carry
 * a `nextCursor`: the filters run after the index read, so an empty page is not the end of
 * the list, and only a `null` cursor is. `iterateMethods` keeps following the cursor through
 * such a page.
 */
export interface MethodPage {
  items: MethodSummary[];
  nextCursor: string | null;
}

/**
 * A method's tree in the four forms a save takes, of which a save gives at most one (see
 * `MethodTreeForms`):
 *
 * - `directory`, a method directory on disk, listed by the `mthds` package's lister under the
 *   standard's membership rule and the deployment's limits (Node only);
 * - `contents`, each file's bytes or text by tree path;
 * - `tree`, a tree whose files the client reads, such as the `MethodTree` the `mthds` package's
 *   `listMethodTree` lists from a directory;
 * - `files`, the MTHDS standard's map of file entries, the same `files` a run takes, sent as
 *   given: a file's text, `{ base64 }`, or `{ sha256, size }` for bytes the organization holds.
 *
 * A `directory`, `contents` or `tree` travels inline when its inline map weighs 256 KiB or less
 * and no more than the inline limit the platform announces, or when the platform keeps no blob
 * store, and otherwise by hash, after the client uploads the files the organization lacks (see
 * `docs/method-trees.md`). On a save, `files: null` empties the draft.
 */
export type MethodTreeInput = MethodTreeForms;

/**
 * The create payload — `createMethod`. A new method holds its tree as its draft and has no
 * version yet; with no tree, the draft is empty. Its draft is then written with `writeDraft`
 * and its name changed with `renameMethod`.
 */
export interface MethodWriteInput extends MethodTreeInput {
  name: string;
  input_data?: Record<string, unknown> | null;
}

/**
 * The draft write — `writeDraft`, `PUT /v1/methods/{id}/draft`. It never validates: a draft
 * may be invalid, and an autosave of work in progress often is.
 *
 * The write replaces the draft's whole tree, given in exactly one form (see `MethodTreeInput`):
 * `files: null` empties the draft, and a draft giving no tree is refused, so keeping the stored
 * files means sending them again.
 */
export interface MethodDraftInput extends MethodTreeInput {
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
  /**
   * Page size, from 1 to 100; the API defaults to 20 and refuses a `limit` outside that range
   * with a `422`.
   */
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

// ── Method examples (`/v1/methods/{id}/examples`) ────────────────────────
//
// An example is a named set of inputs saved on a method, so the method can be run on them
// again in one gesture, with the latest run of exactly those inputs. Like the method, it is
// shared across the organization: any member reads, edits, runs and deletes any example.
// `input_revision` starts at 1 and rises each time the inputs change, which clears
// `latest_run_id`; a run is recorded as the latest only against the revision whose inputs it
// used (`recordMethodExampleLatestRun`).

/**
 * One saved example of a method — what `createMethodExample`, `getMethodExample`,
 * `updateMethodExample` and both arms of `recordMethodExampleLatestRun` and
 * `saveAssistantMethodExample` answer, and a row of `listMethodExamples`.
 */
export interface MethodExample {
  /** The example's id, `ex_…`, minted by the platform. */
  example_id: string;
  /** The bare id of the method the example belongs to. */
  method_id: string;
  /** The example's name, 1 to 200 characters and not blank. */
  name: string;
  /**
   * The inputs a run of the example sends, a JSON object, which the platform stores and answers
   * exactly as they were saved. **An integer past `Number.MAX_SAFE_INTEGER`, in either
   * direction and at any depth, reads as a `bigint`** holding its exact digits, since a double
   * would round it; the client sends a `bigint` back as those digits, to `updateMethodExample` or
   * as a run's inputs, so such inputs go back unchanged. `JSON.stringify` throws on a `bigint`:
   * show the inputs as JSON text with `stringifyExactJson`, and read edited text back with
   * `parseExactJson`. Every other number reads as a double, so a float with no fractional part,
   * `3.0`, reads as `3` and goes back as `3`; the platform compares inputs as canonical JSON, so
   * inputs holding one, sent back unchanged to `updateMethodExample`, raise `input_revision` and
   * clear `latest_run_id`. Inputs saved from JavaScript never hold one, since JavaScript cannot
   * write it; inputs another client saved can.
   */
  inputs: Record<string, unknown>;
  /**
   * Starts at 1 and rises by one each time the inputs change. Send it, as read when the run
   * was started, to `recordMethodExampleLatestRun`.
   */
  input_revision: number;
  /**
   * The latest run of the current inputs, `null` when none was recorded since they last
   * changed. It may name a run deleted since, which then reads as not found.
   */
  latest_run_id: string | null;
  /** The canonical id of the member who saved the example; it confers nothing. */
  created_by_user_id: string;
  /** ISO-8601 UTC instant of the example's creation. */
  created_at: string;
  /** ISO-8601 UTC instant of its last change: its name, its inputs or its latest run. */
  updated_at: string;
  /**
   * Whether the build assistant keeps this example's inputs current with its test inputs: `true`
   * on an example the assistant's save created (`saveAssistantMethodExample`), `false` on every
   * other, and `false` from the first inputs change that is not the assistant's own. A rename
   * leaves it as it is.
   */
  kept_by_assistant: boolean;
}

/** The create — `createMethodExample`, `POST /v1/methods/{id}/examples`. */
export interface MethodExampleCreateInput {
  /** The example's name, 1 to 200 characters and not blank. */
  name: string;
  /**
   * The inputs a run of the example sends, a JSON object; a `bigint` in them is sent as its
   * exact digits.
   */
  inputs: Record<string, unknown>;
  /**
   * A run of this method that used exactly these inputs, recorded as the example's latest run
   * at revision 1 — the run a person saves as an example. Omitted, or `null`, the example has no
   * latest run; an empty string is refused before anything is sent.
   */
  run_id?: string | null;
}

/**
 * The edit — `updateMethodExample`, `PATCH /v1/methods/{id}/examples/{example_id}`: a new name,
 * new inputs, or both, and at least one of them. An omitted field keeps the stored value.
 */
export interface MethodExampleUpdateInput {
  /** The example's new name, 1 to 200 characters and not blank. */
  name?: string;
  /**
   * The example's new inputs. Inputs that differ from the stored ones raise `input_revision`
   * by one and clear `latest_run_id`; the same inputs, their keys in another order included,
   * change nothing. A `bigint` in them is sent as its exact digits. Send them only when they
   * changed: inputs read back that held `3.0` differ once JavaScript has read them, as `3` (see
   * `MethodExample.inputs`).
   */
  inputs?: Record<string, unknown>;
}

/** The latest-run write — `recordMethodExampleLatestRun`. */
export interface MethodExampleLatestRunInput {
  /** A run of this method that used the example's inputs. */
  run_id: string;
  /**
   * The example's `input_revision` whose inputs the run used, as the caller read it when it
   * started the run. The run is recorded only while the example still holds that revision.
   */
  input_revision: number;
}

/** What a latest-run write did — the discriminant of `MethodExampleLatestRunResult`. */
export type MethodExampleLatestRunOutcome = "recorded" | "stale";

/** The run is now the example's latest; `example` is the example as it now stands. */
export interface MethodExampleLatestRunRecorded {
  outcome: "recorded";
  example: MethodExample;
}

/**
 * The run used inputs the example no longer holds, and nothing was written; `example` is the
 * example as it stands, with its current revision and latest run.
 */
export interface MethodExampleLatestRunStale {
  outcome: "stale";
  example: MethodExample;
}

/**
 * The answer of `recordMethodExampleLatestRun`, a `200` discriminated on `outcome`. A stale run
 * is the expected end of a run that outlasted an edit of the example's inputs, a verdict about
 * the run rather than a failed request, so it is answered rather than thrown. Branch on
 * `outcome`, never on the status: an unknown example, a run that is not the method's or a
 * method being deleted are thrown as `ApiResponseError` instead.
 */
export type MethodExampleLatestRunResult =
  MethodExampleLatestRunRecorded | MethodExampleLatestRunStale;

/**
 * The build assistant's save — `saveAssistantMethodExample`,
 * `POST /v1/methods/{id}/examples/assistant-save`: its new test inputs, and the example it read as
 * its own with the revision it read it at, both or neither.
 */
export interface MethodExampleAssistantSaveInput {
  /** The name a new example takes, 1 to 200 characters and not blank; an example kept current keeps its own. */
  name: string;
  /** The assistant's test inputs, a JSON object; a `bigint` in them is sent as its exact digits. */
  inputs: Record<string, unknown>;
  /**
   * The assistant's example the caller read, the method's newest with `kept_by_assistant` true,
   * to keep current. Omitted, or `null`, the save creates a new example.
   */
  example_id?: string | null;
  /** The `input_revision` the caller read that example at; given with `example_id` and only with it. */
  input_revision?: number | null;
}

/** What an assistant save did — the discriminant of `MethodExampleAssistantSaveResult`. */
export type MethodExampleAssistantSaveOutcome = "kept" | "created";

/**
 * The named example was still the assistant's at the revision read, and now holds the inputs;
 * `example` is it as it now stands, its name untouched.
 */
export interface MethodExampleAssistantKept {
  outcome: "kept";
  example: MethodExample;
}

/**
 * A new example, flagged as the assistant's, holds the inputs under the save's `name`: none was
 * named, or a person's edit, another save or a deletion took the named one first.
 */
export interface MethodExampleAssistantCreated {
  outcome: "created";
  example: MethodExample;
}

/**
 * The answer of `saveAssistantMethodExample`, a `200` discriminated on `outcome`. Finding that a
 * person has taken the example is the expected course of events whenever a person edits the
 * assistant's inputs while it works, so it is answered rather than thrown: remember the answer's
 * `example` as the assistant's from then on.
 */
export type MethodExampleAssistantSaveResult =
  MethodExampleAssistantKept | MethodExampleAssistantCreated;

/** Query for one page of a method's examples. */
export interface ListMethodExamplesQuery {
  /**
   * Page size, from 1 to 100; the API defaults to 50 and refuses a `limit` outside that range
   * with a `422`.
   */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of a method's examples, oldest first, inputs included.
 *
 * `nextCursor` is opaque — pass it straight back to `listMethodExamples` to continue; `null`
 * means this was the last page. Examples are read whole on the server, and a read stops at
 * 1 MB, so a page may be short while `nextCursor` is set; `iterateMethodExamples` follows it.
 */
export interface MethodExamplePage {
  items: MethodExample[];
  nextCursor: string | null;
}

// ── Organizations (`/v1/organizations`) ──────────────────────────────────

/**
 * A member's role within an organization — `Membership.role_in_org`.
 *
 * - `admin` does what a member does, and manages the organization's members, their roles and
 *   its invitations.
 * - `member` builds, publishes and runs the organization's methods.
 * - `runner` runs the versions the organization published, and changes no method.
 *
 * Read open, as `Membership.role_in_org` types it: a role a later platform adds arrives as its
 * raw string, so a `switch` over a membership's role has to say what an unknown one does. What
 * a role may do is the platform's to decide: a call it refuses to the caller's role throws
 * `ApiResponseError`, whatever this type says.
 */
export type OrgRole = "admin" | "member" | "runner";

export interface Membership {
  org_id: string;
  /** Null for the implicit personal org (no backing WorkOS organization). */
  workos_organization_id: string | null;
  name: string;
  is_personal: boolean;
  /** The caller's role in the organization: an `OrgRole`, or the raw string of one this SDK does not know. */
  role_in_org: OrgRole | (string & {});
}

export interface MembershipsResponse {
  memberships: Membership[];
  active_org_feature_flags: string[];
}

// ── Organization branding (`/v1/branding`, `/v1/organizations/{id}/branding`) ──
//
// An organization may set up to two logos and two colour sets of three colours, which its shared
// method apps and the apps scaffolded from the method-app template wear. Every member and every
// API key reads it with `getBranding`; an admin writes it with `updateOrganizationBranding`. Both
// answer the same `OrganizationBranding`. See `docs/organization-branding.md`.

/**
 * One colour set: the button, accent and header colours, each `#rrggbb` in lower case, or `null`
 * when not set. The platform always sends all three keys.
 */
export interface BrandingColors {
  /** The button colour. */
  action: string | null;
  /** The accent colour: links, the active tab, the brand ink. */
  accent: string | null;
  /** The header band's colour. */
  header: string | null;
}

/**
 * What the platform recorded about a logo when it accepted it.
 *
 * `content_type` is the type the platform read from the file's own bytes, never the type the
 * upload declared: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. `width` and
 * `height` are the image's size in pixels for a raster, oriented as a browser draws it, and for an
 * SVG its `width` and `height` in pixels when both are in absolute units, which is the size a
 * browser draws it at, else the width and height of its `viewBox`; an SVG's may be fractional.
 * Their ratio is the logo's shape, which sizes its box before the image loads.
 */
export interface LogoDescriptor {
  /**
   * The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never
   * the upload URI the write sent: the platform copies a logo it accepts, under a fresh uuid each
   * time, so the same bytes attached again get a new URI. Sending it back unchanged in its slot
   * keeps the logo. `resolveStorageUrl` turns it into a short-lived link to its bytes.
   */
  uri: string;
  /** The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits: a cache key for them. */
  sha256: string;
  content_type: string;
  width: number;
  height: number;
}

/**
 * An organization's branding — what `getBranding` and `updateOrganizationBranding` answer.
 *
 * `colors` is the light set and `dark_colors` the dark one, used in dark mode only: a dark colour
 * that is `null` falls back to the light colour of the same role, and a light one that is `null`
 * to Pipelex's own palette. A logo is `null` when its slot is empty. A personal workspace, or a
 * team that set nothing, answers every colour and logo `null`.
 */
export interface OrganizationBranding {
  org_id: string;
  /** The organization's display name, the wordmark a client shows when it has no logo. */
  org_name: string;
  colors: BrandingColors;
  dark_colors: BrandingColors;
  /** The square logo, for the organization menu and small headers. */
  square_logo: LogoDescriptor | null;
  /** The wide logo, at least one and a half times as wide as it is tall, for an app's header. */
  wide_logo: LogoDescriptor | null;
}

/**
 * Changes to one colour set. A key set to a colour sets it, a key set to `null` clears it, and a
 * key left out keeps its value. A colour is `#rrggbb` in either case, stored in lower case; the
 * platform refuses anything else with a `422` `validation_failed` whose `errors[]` entry names the
 * key, such as `colors.action`.
 */
export interface BrandingColorsUpdate {
  action?: string | null;
  accent?: string | null;
  header?: string | null;
}

/**
 * The body of `updateOrganizationBranding`: every key optional, a value sets it, `null` clears it,
 * and a key left out keeps its value, so `{}` writes nothing and answers the branding as it
 * stands.
 *
 * - `colors` and `dark_colors` take a `BrandingColorsUpdate`, or `null` to clear all three
 *   colours of that set.
 * - `square_logo` and `wide_logo` take the `pipelex-storage://` URI of a file the organization
 *   uploaded on its own (`requestUploadGrant` or `upload`) to set a new logo, the `uri` the
 *   branding answers for that slot to keep it, or `null` to remove it. Any other URI, a run's or
 *   a method's file, a stale `branding/` copy or the other slot's logo, is refused as
 *   `logo_not_an_upload`, so a logo cannot move between slots by its URI. The platform reads and
 *   measures an upload before it accepts it, keeps its own copy under `branding/`, whose URI it
 *   answers, and erases the copy a write replaces or clears; the upload is left as it is.
 */
export interface OrganizationBrandingUpdate {
  colors?: BrandingColorsUpdate | null;
  dark_colors?: BrandingColorsUpdate | null;
  square_logo?: string | null;
  wide_logo?: string | null;
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
  /** What the upload is recorded as; `uploaded` when omitted. */
  kind?: UploadKind;
  /**
   * The bare catalog id of the method a `test` file is for, required with `kind: "test"`
   * and refused without it.
   */
  method_id?: string;
}

export interface UploadedFile {
  uri: string;
  filename: string;
}

/**
 * What an upload is recorded as: `uploaded`, a person's file, or `test`, a test input
 * made for one method, which names that method in `method_id`.
 */
export type UploadKind = "uploaded" | "test";

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

// ── An organization's files (`/v1/files`) ────────────────────────────────
//
// A file is the record the platform keeps of a stored object: a member's upload, a test file
// made for a method, or a file a run made that reached its result, each with the name a person
// sees, its type, its size and where it came from. A run, a form or an example still points at
// the bytes by their `pipelex-storage://` address, the record's `uri`, which a run's inputs take
// as they take any address (see `docs/files.md`).

/**
 * What made a file: `uploaded`, a person's upload or a run's inline input; `generated`, a file a
 * run made whose result reaches it; `test`, a test input made for one method, which its
 * `origin.method_id` names.
 */
export type FileKind = "uploaded" | "generated" | "test";

/**
 * Who or what made a file, as far as the platform knows it. Each kind fills a different part, and
 * the rest is `null`: an upload names the surface it came through; a generated file or a run's
 * inline input names the run, its method and the version or draft that ran; a test file names the
 * surface it came through and the method it was made for. The member a file is attributed to is
 * the record's `created_by`, never repeated here.
 */
export interface FileOrigin {
  /**
   * The surface an upload came through, as its request's `User-Agent` declared it (`app`, `mcp`,
   * `cli`, `n8n`, `hook`, `sdk`, `raw_http`, and more as surfaces are added); `null` for a run's
   * files. Self-declared, so it is provenance to show, never authority.
   */
  surface: string | null;
  /** The run that made the file; `null` for an upload. */
  run_id: string | null;
  /** The method whose run made the file, or the method a test file was made for; `null` otherwise. */
  method_id: string | null;
  /**
   * The published version number or `"draft"` that ran, for a file made by a saved method's run;
   * `null` otherwise.
   */
  method_version: number | "draft" | null;
}

/**
 * One row of a file list, what a list or a picker shows. A list never holds a file a run made
 * along the way, nor an upload whose bytes have not been seen stored.
 */
export interface FileSummary {
  /** The record's id, `fl_…`. */
  file_id: string;
  /** The `pipelex-storage://` address of the bytes, which a run's inputs take as they take any address. */
  uri: string;
  /** The name shown and used for downloads; it starts as the name the file arrived with and changes with a rename. */
  name: string;
  /** The MIME type the object is stored under. */
  media_type: string;
  /** The format key the list's `format` filter matches: `pdf`, `docx`, `image`, `html` and the rest of the runtime's table. */
  format: string;
  /** The byte size. */
  size: number;
  kind: FileKind;
  origin: FileOrigin;
  /** ISO-8601 instant the record was made. */
  created_at: string;
  /** The member the file is attributed to: the uploader, or the member who started the run that made it. */
  created_by: string;
}

/**
 * Query for one page of an organization's files — `GET /v1/files`. Every member is optional, and
 * each is sent only when given, so an empty string is sent and refused by the API rather than
 * dropped into an unfiltered list.
 *
 * `methodId`, `runId` and `createdBy` choose which list serves the page: a method's list, a
 * run's own list, one member's, or, with none of them, the organization's. The other members
 * filter whichever list serves it, after the index read, so a filtered page can hold fewer rows
 * than `limit`, or none, and still carry a `nextCursor`.
 */
export interface ListFilesQuery {
  /** A case-insensitive search in a file's name and the name it arrived with, applied server-side; at most 200 characters. */
  q?: string;
  /** Only the files of this kind. */
  kind?: FileKind;
  /**
   * Only the files of one of these format keys (`pdf`, `image`, …), sent as one repeated
   * `format=` parameter per value; at most 100. An empty list names no format and is a
   * `RequestArgumentError` before any request, since sent as no parameter it would list every
   * format.
   */
  format?: readonly string[];
  /**
   * Only the files of one of these MIME types (`image/png`, …), sent as one repeated
   * `media_type=` parameter per value; at most 100. An empty list is refused as `format`'s is.
   */
  mediaType?: readonly string[];
  /** The method's list, by its bare catalog id: the files its runs and examples took or made. Sent as `method_id`. */
  methodId?: string;
  /**
   * The run's own list: its final outputs and its inline inputs, in the order of their addresses
   * rather than newest first. Beside `methodId`, the run's list when the method is the run's own,
   * and an empty page otherwise. The files a run took from the organization as inputs are not in
   * it. Sent as `run_id`.
   */
  runId?: string;
  /** One member's files by user id, or `"me"` for the caller's own: their uploads and their runs' outputs. Sent as `created_by`. */
  createdBy?: string;
  /**
   * Only the files created at or after this INSTANT, ISO-8601 with a UTC offset
   * (`2026-10-01T00:00:00Z`), inclusive. A bare date or a naive timestamp is refused by the API
   * with a `400`. Sent as `created_from`.
   */
  createdFrom?: string;
  /** Only the files created at or before this instant. Same rules as `createdFrom`. Sent as `created_to`. */
  createdTo?: string;
  /** Page size, from 1 to 200; the API defaults to 50 and refuses one outside that range with a `422`. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page, bound to the list and the filters that issued it. */
  cursor?: string;
}

/**
 * One page of an organization's files, newest first (in the order of their addresses under
 * `runId`).
 *
 * `nextCursor` is opaque — pass it straight back to `listFiles` with the same filters to
 * continue; `null` means this was the last page. A filtered page can hold fewer rows than
 * `limit`, or none, and still carry a `nextCursor`: only a `null` cursor ends the list, and
 * `iterateFiles` keeps following the cursor through such a page. There is deliberately no total.
 */
export interface FilePage {
  items: FileSummary[];
  nextCursor: string | null;
}

/**
 * For a file a run made, whether the run's result reaches it: `final`, an output of the run, or
 * `intermediate`, a file made along the way, which no list holds.
 */
export type FileRole = "final" | "intermediate";

/** Whether a file's bytes are stored: `stored`, or `pending` while an upload's bytes have not been seen. */
export type FileState = "stored" | "pending";

/**
 * One file's whole record — what `renameFile` answers, each record `getFilesByUri` lists, and the
 * `file` of a run's file entry; `getFile` answers it with its methods and uses (`FileDetail`). It
 * is a `FileSummary` with the members a list leaves out.
 */
export interface FileRecord extends FileSummary {
  /**
   * The address the record was written under, once another run or an example took the file and
   * the platform copied it into the organization's `assets/`; `uri` is then the copy's. `null`
   * until then.
   */
  source_uri: string | null;
  /** The name the file arrived with, never changed: a rename changes `name` alone. */
  original_name: string;
  /**
   * The SHA-256 of the bytes in lowercase hexadecimal, or `null` for a file stored before every
   * writer sent one.
   */
  sha256: string | null;
  /** For a file a run made, `final` or `intermediate`; `null` for the other kinds. */
  role: FileRole | null;
  /** `stored`, or `pending` while an upload's bytes have not been seen. */
  state: FileState;
}

/** What holds an address a use links: a run that took it as an input, or an example that holds it. */
export type FileUseHolderType = "run" | "example";

/**
 * An address taken as an input by a run, or held by an example. A use names an address, not a
 * record, so every record holding the address shows the same uses; a file a run made names that
 * run in its `origin`, never as a use.
 */
export interface FileUse {
  /** The `pipelex-storage://` address used. */
  uri: string;
  holder_type: FileUseHolderType;
  /** The run's id or the example's id. */
  holder_id: string;
  /** The method of the run or of the example; `null` for a run of no saved method. */
  method_id: string | null;
  /** ISO-8601 instant the use was recorded. */
  created_at: string;
}

/**
 * One page of a file's uses, the examples that hold its address first, then the runs that took
 * it. It is a member of `FileDetail`, as the platform serializes it: pass `next_cursor` back to
 * `getFile` as `usesCursor` for the next page; `null` means there is none.
 */
export interface FileUsePage {
  items: FileUse[];
  next_cursor: string | null;
}

/** One file with what links it to the organization's methods, runs and examples — `getFile`. */
export interface FileDetail extends FileRecord {
  /** The methods whose list of files holds this one, because one of their runs or examples took or made it. */
  method_ids: string[];
  /** One page of the file's uses. */
  uses: FileUsePage;
}

/** Query of `getFile`, for the page of the file's uses it answers. */
export interface GetFileQuery {
  /** How many uses the page holds, from 1 to 200; the API defaults to 50. Sent as `uses_limit`. */
  usesLimit?: number;
  /** The previous answer's `uses.next_cursor`. Sent as `uses_cursor`. */
  usesCursor?: string;
}

/** Options of `getFilesByUri`. */
export interface GetFilesByUriOptions {
  /**
   * The run whose input the address is: the records of the member who started it come first, so
   * a run's inputs show the name its starter gave the file. Sent as `run_id`.
   */
  runId?: string;
}

/**
 * The records holding one address — `getFilesByUri` — in the order a surface picks the one to
 * show, the first being it. Empty for an address no record holds, such as a file stored before
 * the platform kept records.
 */
export interface FileRecordList {
  items: FileRecord[];
}

/** The rename — `renameFile`, `PATCH /v1/files/{file_id}`. */
export interface FileRenameInput {
  /**
   * The new name, at most 512 characters. The platform removes the characters no list or header
   * can show, trims the ends, refuses a name with nothing left, and adds the file's own extension,
   * the one its `original_name` ends with, when the name does not end with it, case aside.
   */
  name: string;
}

/** One file to link — `linkFiles` — named by exactly one of its record's id and its address. */
export type FileLinkTarget = { file_id: string; uri?: never } | { uri: string; file_id?: never };

/**
 * Why one file got no link — a value, never a thrown error. `code` is `not_found` (an unknown file,
 * or one deleted meanwhile), `conflict` (a file whose upload has not finished), `invalid_storage_uri`
 * (a malformed address) or `forbidden` (another organization's address); `detail` is the sentence
 * a person reads.
 */
export interface FileLinkError {
  code: string;
  detail: string;
}

/**
 * One requested file's link, or why it has none. Either the link members are set and `error` is
 * `null`, or `error` is set and they are `null`. Branch on `error`, never on the HTTP status: the
 * request is a `200` whenever every file got a verdict.
 */
export type FileLink =
  | {
      /**
       * The record linked: the one asked for, or for an address, the record whose name the link
       * carries; `null` for an address no record holds, a file stored before records existed.
       */
      file_id: string | null;
      /** The address the link reads. */
      uri: string;
      /** The name the download saves under, which the link's `Content-Disposition` carries. */
      name: string;
      /** The file's type, which decides whether a browser shows it in place or downloads it. */
      media_type: string;
      /** A presigned `GET` of the file, valid for fifteen minutes; a bearer capability, so keep it out of logs. */
      url: string;
      /** ISO-8601 UTC instant the link stops working. */
      expires_at: string;
      error: null;
    }
  | {
      /** The file id as requested, or `null` when the file was named by its address. */
      file_id: string | null;
      /** The address as requested, or `null` when the file was named by its id. */
      uri: string | null;
      name: null;
      media_type: null;
      url: null;
      expires_at: null;
      error: FileLinkError;
    };

/** The answer of `linkFiles`: exactly one `FileLink` per requested file, in the request's order. */
export interface FileLinksResult {
  items: FileLink[];
}

/**
 * Where an archive stands: `queued` and `building`, read it again shortly; `ready`, its `url`
 * downloads the zip; `failed`, its `failure` says why, and a new request is the remedy.
 */
export type FileArchiveState = "queued" | "building" | "ready" | "failed";

/** How an archive's files were chosen: `files`, by their ids, or `run`, as one run's files. */
export type FileArchiveSource = "files" | "run";

/**
 * Why an archive failed: `file_gone`, a selected file was deleted before the zip was ready;
 * `build_failed`, the build failed or did not finish within the hour. Asking again is the remedy
 * for both.
 */
export type FileArchiveFailureCode = "file_gone" | "build_failed";

/** What a failed archive says about its failure. */
export interface FileArchiveFailure {
  code: FileArchiveFailureCode;
  /** A sentence for a person, naming the file when one was gone. */
  detail: string;
}

/**
 * One zip of an organization's files — what `requestFileArchive` (`queued`) and `getFileArchive`
 * answer. An archive is never a file: no list shows it, and it is gone a day after it was asked
 * for, past `expires_at`, when reading it answers `404`.
 */
export interface FileArchive {
  /** The archive's id, `arc_…`. */
  archive_id: string;
  /** The name the zip downloads under, ending in `.zip`. */
  name: string;
  state: FileArchiveState;
  source: FileArchiveSource;
  /** The run whose files the archive holds, for a `run` archive; `null` otherwise. */
  run_id: string | null;
  /** How many files the zip holds. */
  file_count: number;
  /** The files' total size in bytes, before compression. */
  total_bytes: number;
  /** ISO-8601 instant the archive was asked for. */
  created_at: string;
  /** ISO-8601 instant after which the archive is gone and reads as unknown, a day after `created_at`. */
  expires_at: string;
  /** The zip's own size in bytes, once it is ready; `null` until then. */
  archive_bytes: number | null;
  /** ISO-8601 instant the zip was complete; `null` until then. */
  ready_at: string | null;
  /** Why the archive failed; `null` unless `state` is `failed`. */
  failure: FileArchiveFailure | null;
  /**
   * A presigned `GET` of the zip, valid for fifteen minutes and signed with a `Content-Disposition`
   * naming `name`, set only on a read of a `ready` archive; each read signs a fresh one. A bearer
   * capability, so keep it out of logs.
   */
  url: string | null;
  /** ISO-8601 instant `url` stops working; `null` without a link. */
  url_expires_at: string | null;
}

/**
 * The request — `requestFileArchive`, `POST /v1/files/archives` — naming the files by exactly one
 * of `file_ids` and `run_id`.
 *
 * - `file_ids`: any of the organization's files, in the order the zip holds them, at least one; an
 *   id given twice is zipped once. At most 500 files once duplicates are removed and 1,000 ids
 *   listed.
 * - `run_id`: a run of the organization, whose zip holds what went in and what came out, never a
 *   file it made along the way nor an input given as a web link.
 *
 * `name` is the name the zip downloads under, `.zip` added when it does not end with it; omitted,
 * or with nothing usable left once the platform cleans it, the platform names it
 * `files-<run_id>.zip` or `files-<YYYYMMDD-HHMMSS>.zip`.
 */
export type FileArchiveRequest =
  | { file_ids: readonly string[]; run_id?: never; name?: string }
  | { run_id: string; file_ids?: never; name?: string };

/**
 * The cap a `422` `file_archive_too_large` names, read from the refusal's
 * `ApiResponseError.problemDocument.limit`: `max_files` (500) or `max_total_bytes`
 * (2,000,000,000), its `value`, and what the selection `reached`. For a run, the count stops as
 * soon as it passes the cap, so `reached` is one more than `max_files` and means "at least".
 */
export interface FileArchiveLimit {
  name: "max_files" | "max_total_bytes";
  value: number;
  reached: number;
}

/**
 * The copy of a file into a method's draft — `copyFileIntoDraft`,
 * `POST /v1/methods/{id}/draft/files/from-file`, "Add to method files".
 */
export interface DraftFileFromFileInput {
  /** The file to copy, one of the organization's, `fl_…`. */
  file_id: string;
  /** The tree path the file takes in the draft, such as `assets/logo.png`; a file already there is replaced. */
  path: string;
  /**
   * The draft token (`MethodData.updated_at`) the caller last read, echoed verbatim: a draft that
   * moved since is refused with a `409` `method_update_conflict`. Omitted, the file is added to the
   * draft as it stands when the request is served, never erasing another save.
   */
  expected_updated_at?: string;
}

/**
 * What the copy did in the organization's blob store, the field the answer is discriminated on:
 * `copied`, the bytes were copied under their SHA-256, or `already_held`, the store held them and
 * nothing was copied.
 */
export type DraftFileBlob = "copied" | "already_held";

/** The copied file as the draft's tree now names it. */
export interface DraftFileAdded {
  /** Its tree path. */
  path: string;
  /** The SHA-256 of its bytes, in lowercase hexadecimal. */
  sha256: string;
  /** Its size in bytes. */
  size: number;
}

/**
 * The answer of `copyFileIntoDraft`, a `200` discriminated on `blob`; both arms carry the file as
 * the draft names it and the method as the draft write stored it, with its new draft token.
 */
export interface DraftFileFromFileResult {
  blob: DraftFileBlob;
  file: DraftFileAdded;
  method: MethodData;
}

/** Whether a run's records are all written: `listed`, or `listing` while the platform is still recording them. */
export type RunFilesState = "listing" | "listed";

/** Where a file sits in its run: what went in, what came out, or what was made along the way. */
export type RunFileMark = "input" | "final" | "intermediate";

/** One file of a run, with its mark and the record a surface shows for it. */
export interface RunFileEntry {
  mark: RunFileMark;
  /**
   * For an input given by its address, the run's input that held it; `null` for an inline input
   * and for the files the run made.
   */
  input_name: string | null;
  /**
   * The address the run took or wrote; a record a take moved to a copy says where it lives now in
   * its own `uri`.
   */
  uri: string;
  /**
   * The record a surface shows for the file: for an input, the one of the member who started the
   * run first, then the caller's, then the oldest. `null` for an input address no record holds,
   * such as a file stored before records existed.
   */
  file: FileRecord | null;
}

/** A web link the run's inputs held, which gets no record: the platform neither fetched nor kept what it served. */
export interface RunInputLink {
  /** The run's input that held the link. */
  input_name: string;
  /** The link, as the run was given it. */
  url: string;
  /** Why the link matters to a replay of the run: it must still serve the same file. */
  warning: string;
}

/** Query of `listRunFiles`, paging the run's own records. */
export interface ListRunFilesQuery {
  /** How many of the run's own records the page holds at most, from 1 to 200; the API defaults to 50. */
  limit?: number;
  /** Opaque `nextCursor` from the previous page. */
  cursor?: string;
}

/**
 * One page of a run's files, sorted by where they sit in the run — `listRunFiles`.
 *
 * The inputs given by their address and the web links come on the first page only; the run's own
 * records, its inline inputs, its final outputs and the files it made along the way, are paged by
 * address. `nextCursor` is opaque — pass it straight back to `listRunFiles`; `null` is the last
 * page. `state` is `listing` until the platform has recorded every file of the run, a few seconds
 * after it ends, so a client showing a run that just ended reads it again until it is `listed`.
 */
export interface RunFilesPage {
  pipeline_run_id: string;
  state: RunFilesState;
  /** What went in: the inputs by address (first page only), then the inline inputs. */
  inputs: RunFileEntry[];
  /** What came out: the run's final outputs. */
  outputs: RunFileEntry[];
  /** What was made along the way. */
  intermediates: RunFileEntry[];
  /** The web links the inputs held (first page only). */
  links: RunInputLink[];
  nextCursor: string | null;
}

// ── Runs list / update (`/v1/runs`) ──────────────────────────────────────
//
// The run-lifecycle status/results/start routes already live on the client
// (`runs.ts`); these are the remaining catalog-style list + admin-update routes.

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
  created_at: string;
  finished_at?: string | null;
  /** The run's stored error report as the platform serves it, the runner's STRICT
   *  projection, typed whole (see `RunErrorReport` for which runs hold one). This is how a
   *  consumer tells the user WHY a run failed rather than showing a generic message. */
  error?: RunErrorReport | null;
  /**
   * Which version of its method the run ran: the version number for a run addressed by a
   * bare id (the latest published version) or by `mt_…@<n>`, `"draft"` for one addressed by
   * `mt_…@draft`, and `null` for a run of an inline source. Absent on a run recorded by a
   * platform that did not record it yet.
   */
  method_version?: number | "draft" | null;
  /**
   * The SHA-256 of the sources the run sent as text, 64 lowercase hex characters with no prefix —
   * not a tree digest. `null` for a run whose method was a tree holding a Base64 or a hash entry,
   * a stored method's included, which `RunDetail.tree_digest` names instead, and when the platform
   * never held the files, as on a `method_ref` run; absent on a run recorded by a platform that
   * did not record it yet.
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
  /** The run's stored error report, served as on the run detail — present only on a run
   *  that ended without completing and holds one, so opening it from history shows why
   *  without another read. */
  error?: RunErrorReport | null;
  /**
   * Which version of the method the run ran — a number, `"draft"`, or `null` for an inline
   * source (see `PipelineRun.method_version`). The history lists the runs of every version
   * and of the draft together, so this is how a row says which one it was.
   */
  method_version?: number | "draft" | null;
  /** The SHA-256 of the sources the run sent as text (see `PipelineRun.source_digest`). */
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
  /** One entry PER `.mthds` FILE, not one bundle string. A single-file method
   *  is an array of one. */
  mthds_contents?: string[] | null;
  /**
   * The inputs the run was started with, as sent, an integer past `Number.MAX_SAFE_INTEGER` read
   * as a `bigint` holding its exact digits, so the inputs passed back to `start` run what the run
   * ran. Show them as JSON text with `stringifyExactJson`, since `JSON.stringify` throws on a
   * `bigint`.
   */
  inputs?: Record<string, unknown> | null;
  /**
   * The id of the request that started the run — the one to quote to support, and the one the
   * platform and the runner logged it under. `null` for a run saved before the platform recorded
   * it; absent on a server that does not serve it. The run history does not carry it; the status
   * read does, as `RunRead.request_id`.
   */
  request_id?: string | null;
  /**
   * The digest of the method tree the run sent as `files`, `sha256:` and 64 lowercase hex
   * characters, a stored method's run included; `null` for a run that recorded none.
   */
  tree_digest?: string | null;
  /** The runner's fingerprint of the crate it loaded the tree into; `null` when it reported none. */
  crate_fingerprint?: string | null;
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
  /**
   * `"me"` lists only the runs the caller started, resolved by the platform from the
   * authenticated identity; omitted, every member's runs. It takes no other value: the list
   * never narrows to another member. Sent as `created_by=me`.
   */
  createdBy?: "me";
  /**
   * Only runs in one of these statuses, sent as one repeated `status=` parameter per status;
   * omitted, every status. The caller's own latest unfinished run is
   * `{ createdBy: "me", status: ["PENDING", "STARTED", "RUNNING"], limit: 1 }`. An empty list
   * names no status and is a `RequestArgumentError` before any request, as is a name that is no
   * `RunStatus`.
   */
  status?: readonly RunStatus[];
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
 *
 * Under `createdBy` or `status` a page can hold fewer rows than `limit`, or none, and still
 * carry a `nextCursor`: the platform applies them after the index read, so an empty page is
 * not the end of the history, and only a `null` cursor is. `iterateRuns` keeps following the
 * cursor through such a page.
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
