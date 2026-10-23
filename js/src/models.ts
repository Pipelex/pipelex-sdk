/**
 * Pipelex wire models — the concrete JSON shapes `PipelexApiClient` deals in.
 *
 * Holds the Dict-serialized protocol concretes (`DictStuff` / `DictWorkingMemory`
 * / `DictPipeOutput` and the default `RunResultExecute` binding), the Pipelex
 * `/v1/validate` surface (`PipelexValidationResult`, whose faults are the standard's
 * `ProblemItem`s), the
 * request/response models of the tools routes and the crate routes, and the verdict of
 * the model reference check. Built on the protocol wire types imported from the
 * `mthds/protocol` subpath.
 */

import type {
  InputForm,
  MethodFiles,
  ProblemItem,
  MethodTreeSource,
  OutputForm,
  PipeIOContracts,
  RunResultExecute,
  RunResultStart,
} from "mthds/protocol";
import type { MethodTreeForm, NoMethodTree } from "./method-trees.js";

export interface DictStuff {
  concept: string;
  content: unknown;
}

export interface DictWorkingMemory {
  root: Record<string, DictStuff>;
  aliases: Record<string, string>;
}

/**
 * Serialized pipe output — mirror of python's `DictPipeOutputAbstract`
 * (`{working_memory, pipeline_run_id}`). NOTE: the inner `pipeline_run_id` is a
 * runtime-internal field produced by the pipelex runtime inside the
 * `pipe_output` payload — it deliberately keeps its name (runtime internals are
 * out of the wire-rename scope).
 *
 * **Extension-open**, mirroring `DictPipeOutputAbstract`'s `extra="allow"`: the
 * runner rides Pipelex extension fields here beside `working_memory` — the usage
 * pair (`tokens_usages` / `usage_assembly_error`) is the current example. Without
 * the index signature, reading one means casting the whole value away, and the
 * two SDK mirrors of the same wire shape disagree on whether it is closed.
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  pipeline_run_id: string;
  /** Pipelex extension fields the runner rides on the pipe output. */
  [extension: string]: unknown;
}

/**
 * The default `RunResultExecute` binding — the concrete execute result with a
 * Dict-serialized output. Extension fields (e.g. `main_stuff_name`) ride the
 * protocol's extension-open response.
 */
export type DictRunResultExecute = RunResultExecute<DictPipeOutput>;

// ── Method-selector extensions (address form + hosted catalog id) ────────
//
// A method reaches any method-taking route in one of three forms: its tree
// (the protocol's `files` map, which the client builds from a directory, a map
// held in memory or a listed tree — see `MethodTreeForms`), a `method_ref`
// address (`github.com/<owner>/<repo>[/<selector>][@<tag>]` — a Pipelex-API
// extension, resolved by the RUNNER via git fetch at the tag), or a `method_id`
// catalog id (`mt_…` — a hosted-platform extension, resolved against the org's
// catalog; an open-source runner has no catalog and answers a 422 naming the
// key). The two selectors never meet in the runner: the platform resolves
// `method_id` into the stored tree before any runner sees the request.

/**
 * Provenance of a `method_ref` run — the package's resolved full address, the
 * requested tag (`null` for a bare address, which resolves the default branch
 * at HEAD), and the commit SHA that was actually fetched. The SHA is what keeps
 * the run explainable when a tag moves. A Pipelex-API extension; attached to
 * the start ack and the execute response for `method_ref` runs, absent (or
 * `null`) otherwise.
 */
export interface MethodProvenance {
  address: string;
  tag: string | null;
  commit_sha: string;
}

/**
 * The `POST /v1/start` 202 ack as the Pipelex API returns it — the protocol's
 * `RunResultStart` plus the server's `method_provenance` extension, populated
 * for `method_ref` runs and absent or `null` otherwise, and the hosted
 * `method_version`, populated for `method_id` runs.
 */
export interface PipelexRunResultStart extends RunResultStart {
  method_provenance?: MethodProvenance | null;
  /**
   * Which version of the stored method a `method_id` run runs: the latest published version's
   * number for a bare id, the pinned number for `mt_…@<n>`, `"draft"` for `mt_…@draft`. Absent
   * or `null` for any other run, and on a server that does not resolve version selectors.
   */
  method_version?: number | "draft" | null;
}

/**
 * The hosted tooling routes' own selector — the layer-3 extension the platform
 * adds on `POST /v1/validate`, `/v1/resolve`, `/v1/codegen`, and `/v1/pipe-io`: a stored
 * method's catalog id (`mt_…`), optionally naming a version, resolved server-side against
 * the org's catalog, the tree of the version it names injected as the method's `files`
 * before the runner sees the request. A bare `mt_…` names the latest published version,
 * `mt_…@<n>` version `n` and `mt_…@draft` the draft. A **pass-through to the hosted API**:
 * nothing is expanded client-side, and it is meaningless off-platform (a bare runner
 * rejects the request as carrying no source it understands).
 *
 * The tooling routes are stateless, so there is no linkage exception: exactly
 * one of inline source / `method_ref` / `method_id` per request — any second
 * selector is a request-shape `422`. An unknown or foreign-org id is a `404`
 * (indistinguishable by design); a bare id of a method never published is a `409`
 * `pipelex.catalog.not_published`; a version never published is a `404`
 * `pipelex.catalog.not_found`; a malformed suffix, or a stored method with no MTHDS
 * source, is a `422`.
 */
export interface PipelexHostedToolingExtensions {
  /**
   * A stored method's catalog id (`mt_…`, `mt_…@<n>` or `mt_…@draft`) — hosted-only,
   * resolved server-side.
   */
  method_id?: string;
}

// ── Validate surface (Pipelex-API extensions over the protocol) ──────────
//
// `POST /v1/validate` is a diagnostic endpoint: every produced verdict rides a
// 200, discriminated on `is_valid`. The Pipelex API answers both arms in its own
// shape: the VALID arm is the canonical `PipelexValidationReport`; the INVALID arm
// is `PipelexInvalidReport`, listing its faults as the standard's problem items in
// `errors[]`. Non-2xx is reserved for no-verdict conditions (a malformed request, a tree
// the route refuses, auth, a server fault), surfaced as `ApiResponseError`.
//
// Both arms are declared here whole rather than as extensions of the protocol's
// `ValidationReport` and `InvalidValidationReport`: the hosted answer carries members of
// its own beside the protocol's (`bundle_blueprint`, `pipe_io_contracts`, the opt-in views
// and `rendered_markdown`). Their `errors[]` and `warnings[]` are the protocol's items, read
// member by member (`readProblemItems`), so a malformed member is left out of its item
// rather than failing the verdict.

/**
 * The method selector the tooling routes take in place of the method's tree: a
 * `method_ref` address (server-resolved by the runner through the same fetch
 * path as a `method_ref` run) OR a hosted `method_id` (platform-resolved) —
 * never both. The tooling routes are stateless, so the strict XOR applies:
 * exactly one of the tree / `method_ref` / `method_id` per request.
 *
 * Lives here, beside the other wire shapes, rather than on the client: it is
 * the request's shape, and a module that composes a `validate` call of its own
 * can name it without importing the client back (which would close a module
 * cycle).
 */
export type ValidateMethodSelector =
  { method_ref: string; method_id?: never } | { method_id: string; method_ref?: never };

/**
 * What `validate()` judges: the method's tree, in exactly one of the four forms of
 * `MethodTreeForm` (a `directory`, `contents`, a `tree` or the `files` map), or one of the two
 * selectors of `ValidateMethodSelector`. Each arm pins the others to `never`, so naming two is a
 * compile error; an untyped caller naming none, or more than one, is refused with a
 * `RequestArgumentError` before any request, as the route itself would refuse a second selector
 * with a `422`. At run time a `null` member, an empty `directory` and an empty selector string
 * are absent, and a `files` map or `contents` holding no file is refused, as the MTHDS standard
 * refuses a tree holding no file.
 *
 * It widens the protocol's own `ValidateSource` (`{ files }` or `{ tree }`) with the two forms
 * this client lists or encodes itself and the two selectors the Pipelex API resolves.
 */
export type PipelexValidateSource =
  | (MethodTreeForm & { method_ref?: never; method_id?: never })
  | (ValidateMethodSelector & NoMethodTree);

/** Per-pipe dry-run verdict in `validated_pipes[]` — mirror of pipelex's `DryRunStatus`. */
export type DryRunStatus = "SUCCESS" | "FAILURE" | "SKIPPED";

/** One entry of `PipelexValidationReport.validated_pipes` — `{pipe_ref, status}`. */
export interface ValidatedPipeEntry {
  /** Namespaced `pipe_ref` (`domain.code`) — never the bare code. */
  pipe_ref: string;
  status: DryRunStatus;
}

/**
 * One entry of `PipelexValidationReport.liftable_pipes` — mirror of pipelex's
 * `LiftablePipeEntry`. A pipe the runtime may skip (lift) when an optional slot
 * resolves absent: build-time visibility for "this step may not run", derived by
 * the absence-taint pass, not a verdict.
 */
export interface LiftablePipeEntry {
  /** Namespaced ref of the liftable pipe. */
  pipe_ref: string;
  /** Namespaced ref of the controller in whose flow the lift happens. */
  within_pipe_ref: string;
  /** The slot names whose absence lifts the pipe. */
  skipped_when_absent: string[];
  /** Where the possible absence originates (human-readable). */
  absence_source: string;
}

/**
 * What a step reads a file of its method tree as — mirror of pipelex's `TreeFileUse`:
 * `template`, the template a `PipeDocGen` step fills, named by its `template_file`;
 * `template_asset`, an image, a stylesheet or a font that step's HTML template names by a
 * literal relative URL, or that one of its stylesheets names; `python_module`, the module
 * defining the function a `PipeFunc` step calls, named by the import path of its
 * `function_name`.
 *
 * A report reads it open (see {@link TreeFileRead.use}): a runner of a later version may add
 * a use as another kind of step comes to read files of its tree.
 */
export type TreeFileUse = "template" | "template_asset" | "python_module";

/**
 * One file of its method tree a step reads — mirror of pipelex's `TreeFileRead`, an entry of
 * {@link PipelexValidationReport.tree_files_read}.
 */
export interface TreeFileRead {
  /**
   * The file's path from the root of the method's tree, with forward slashes, such as
   * `templates/invoice.html`, never a path on the server.
   */
  tree_path: string;
  /**
   * What the step reads the file as. Read open: `string & {}` keeps the editor's completion
   * on the uses this SDK knows, and a consumer that switches on this field has to say what a
   * use it does not know does.
   */
  use: TreeFileUse | (string & {});
}

/**
 * Pipelex's `POST /v1/validate` 200 body for a VALID bundle — the canonical
 * `PipelexValidationReport`, carrying the `is_valid: true` discriminant of the
 * protocol's union, plus the route's wire-only extras (`message`, the
 * `mthds_contents` echo). Field names follow the MTHDS brand
 * boundary — blueprints/graphs are language artifacts, so no `pipelex_` prefix
 * inside this envelope.
 *
 * This SDK owns none of the artifacts the envelope carries, and it narrows the two the
 * MTHDS standard has declared in the one way that keeps that true: by **importing** the
 * standard's own types. `pipe_io_contracts` and `input_form` are `PipeIOContracts` and
 * `InputForm` from `mthds/protocol`, the recommended extension fields of the protocol's
 * validation report, declared once per language and re-exported unchanged through this
 * package's barrel. Nothing about their shape is restated here, so there is no second
 * source of truth free to drift from the one the server emits — which is precisely what
 * the earlier ruling that kept both opaque was protecting against. Importing serves that
 * concern better than opacity did, and the principle it was defending is unchanged: this
 * envelope is transport, and the shapes it transports belong to the standard.
 *
 * `bundle_blueprint` and `graph_spec` do stay opaque transport (`Record<string, unknown>`
 * / `unknown`): their canonical schemas are owned elsewhere — the runtime's blueprint
 * models, and `@pipelex/mthds-ui`'s `GraphSpec` — and neither has a wire declaration in
 * the standard for this SDK to import. Each narrows on the day one exists.
 * Carries an extension index signature, so any further server field is preserved.
 */
export interface PipelexValidationReport {
  /** Discriminant of the valid arm of the 200 response union. */
  is_valid: true;
  /** The batch's primary blueprint (first declaring `main_pipe`, else first). */
  bundle_blueprint: Record<string, unknown>;
  /**
   * Per-pipe input/output contracts, keyed by namespaced `pipe_ref` (`domain.code`) —
   * the standard's `PipeIOContracts` artifact, imported rather than restated.
   */
  pipe_io_contracts: PipeIOContracts;
  /**
   * Per-pipe input-form descriptors — the standard's `InputForm` artifact, derived from
   * authored facts rather than the emitted JSON Schema, so a renderer can build a
   * fill-in form from the verdict alone. Keyed over the same `pipe_ref` set as
   * `pipe_io_contracts`, an invariant the imported type states for both.
   *
   * OPTIONAL on purpose: this is an opt-in structured view, requested through
   * `views: ["input_form"]` (see `validate`) and absent from any verdict that did not
   * ask for it. `pipelex-api` gates it on that token as of 0.18.0; 0.17.0 emitted it on
   * every valid verdict, the derivation having landed ahead of its carriage gate.
   *
   * Optional rather than narrowed by a `views`-generic overload on `validate`: presence
   * is a function of the request, and tying the type to a runtime array's contents costs
   * every caller a harder signature to read in exchange for one non-null assertion at the
   * single call site that opts in.
   */
  input_form?: InputForm;
  /**
   * Per-pipe OUTPUT-form descriptors — the standard's `OutputForm` artifact, the twin of
   * `input_form` on the other side of the pipe. One `field` rather than a list of them,
   * carrying no `presence` and no `gating`, because a result is not a slot a caller
   * fills. Keyed over the same `pipe_ref` set as `pipe_io_contracts`.
   *
   * Paired with that contract's `output.json_schema` it is everything a renderer needs to
   * lay a run's result out without inspecting the payload — the descriptor says what the
   * result IS, the schema names the property it arrives under. A consumer holding one but
   * not the other is back to inferring the other from the value, which is the guessing
   * these artifacts exist to end.
   *
   * OPTIONAL for the same reason as `input_form`: an opt-in structured view, requested
   * through `views: ["output_form"]` and absent from any verdict that did not ask.
   */
  output_form?: OutputForm;
  /** Pipes the runtime may skip when an optional slot resolves absent. */
  liftable_pipes: LiftablePipeEntry[];
  /**
   * Per step, the files of the method's tree it reads, keyed by namespaced `pipe_ref` over
   * the same set as `pipe_io_contracts`, each file by its tree path with what the step reads
   * it as. A `PipeDocGen` step reads its template and the images, stylesheets and fonts its
   * HTML template names by literal relative URLs; a `PipeFunc` step reads the module of its
   * function when that module is a file of the tree. A step that reads no file of the tree,
   * a controller included, has an empty list. The paths come from what each step already
   * names, so a client can show which step uses a file without parsing the method.
   *
   * OPTIONAL because a runner predating the field sends nothing: an absent field says the
   * server did not report the reads, where an empty list says that step reads no file.
   */
  tree_files_read?: Record<string, TreeFileRead[]>;
  /**
   * The per-file view of `tree_files_read`: each tree path a step reads, in sorted order, to
   * the namespaced refs of the steps that read it, each listed once. A file of the tree with
   * no entry is read by no step: the bundles themselves, a README, a package's `__init__.py`
   * beside its modules. Optional for the same reason as `tree_files_read`, and present
   * whenever it is.
   */
  tree_file_readers?: Record<string, string[]>;
  /**
   * The qualified ref of the pipe a selector-less run of THIS request would execute —
   * the primary blueprint's declared `main_pipe` qualified by its domain and, for a
   * `method_ref` package, the manifest's `main_pipe` qualified against the closure the
   * way the runner's `resolve_requested_pipe` reads it. `null` when the server
   * determined no entry pipe: no blueprint declares a `main_pipe`, or the manifest
   * names a pipe the closure does not declare or declares in several domains. It
   * carries the RUN default, so a closure whose domains each declare a `main_pipe`
   * gets the first declaring blueprint's ref rather than `null` — that is the pipe
   * `execute` would take.
   *
   * Read it on PRESENCE, in three arms: a non-empty string is the default; a stated
   * `null` is the server's verdict that there is none, and a consumer stops there
   * rather than deriving one of its own; an ABSENT field means the server predates
   * the field, and only then does a blueprint-derived default stand. That is the rule
   * `pipelex-mcp` states in its `SPEC.md`. It is NOT `/v1/pipe-io`'s field of the same
   * name ({@link PipeIOValidReport.default_pipe_ref}), which refuses to choose among
   * several declaring domains where this one names the first.
   */
  default_pipe_ref?: string | null;
  /** Best-effort execution graph of the main pipe; `null` with no `main_pipe` or on degrade. */
  graph_spec: unknown;
  /** Per-pipe dry-run sweep outcomes. */
  validated_pipes: ValidatedPipeEntry[];
  /**
   * Advisory findings on a VALID bundle, one problem item each with the code its finding's
   * type names: the same item shape as the invalid arm's `errors[]`, so one reader serves
   * both, but these never flip `is_valid`. Empty when there is nothing to report. The client
   * reads them member by member (`readProblemItems`).
   */
  warnings: ProblemItem[];
  /** Qualified refs of pipes still declared as `PipeSignature`. */
  pending_signatures: string[];
  /** `not pending_signatures` — whether the validated library is complete enough to run. */
  is_runnable: boolean;
  /** Route extra: status message. */
  message: string;
  /** Route extra: echo of the submitted `mthds_contents`. */
  mthds_contents?: string[];
  /**
   * Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the
   * verdict, present only when the request asked for it (`render: ["markdown"]`).
   * Absent by default. Rendered once server-side by pipelex's shared renderer, so it
   * matches the local CLI's `--format markdown` output in format/structure.
   */
  rendered_markdown?: string;
  /** Further implementation extension fields, preserved as the server sent them. */
  [extension: string]: unknown;
}

/**
 * Pipelex's `POST /v1/validate` 200 body for an INVALID bundle — the `is_valid: false`
 * arm of the response union, listing its faults as problem items. The structural
 * artifacts of the valid arm are absent (they don't exist when load/parse/wiring failed);
 * `errors[]` is non-empty on every invalid verdict the server sends, and the client reads
 * it member by member (`readProblemItems`), so an item whose `code` or `detail` is not a
 * string is skipped and a malformed member is left out of its item.
 */
export interface PipelexInvalidReport {
  /** Discriminant of the invalid arm. */
  is_valid: false;
  /**
   * One problem item per fault, each with its own `code`, `detail`, `params`, `location`
   * and, when the server has one, its `suggested_fix`.
   */
  errors: ProblemItem[];
  /** Outstanding signatures (best-effort; empty when no library could be assembled). */
  pending_signatures: string[];
  /** An invalid bundle is never runnable. */
  is_runnable: false;
  /** Human-readable summary of the verdict. */
  message: string;
  /**
   * Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the
   * invalid verdict's errors, present only when the request asked for it
   * (`render: ["markdown"]`). Absent by default.
   */
  rendered_markdown?: string;
}

/**
 * The Pipelex `POST /v1/validate` 200 response — the discriminated union the
 * `PipelexApiClient.validate` returns, keyed on `is_valid`, as the protocol's
 * `ValidationResult` is. Its arms are Pipelex's own, the verdict the hosted plane
 * answers, not narrowings of the protocol's (see the section's heading above).
 */
export type PipelexValidationResult = PipelexValidationReport | PipelexInvalidReport;

// ── Tools routes (Pipelex API — `/v1/lint`, `/v1/format`) ───────────────
//
// Both are diagnostic endpoints over a SINGLE `.mthds` file: malformed content is
// a produced verdict on a **200** (`diagnostics[]`), never a thrown error. Non-2xx
// is reserved for no-verdict conditions (a malformed body, bad formatter options,
// auth, a server fault), surfaced as `ApiResponseError`.

/** Which analysis produced a `Diagnostic` — mirror of `pipelex-tools`' closed kind set. */
export type DiagnosticKind = "syntax" | "semantic" | "schema";

/** Source span of a `Diagnostic` — byte offsets plus 1-based line/column coordinates. */
export interface DiagnosticRange {
  start_offset: number;
  end_offset: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

/**
 * One structured lint/format diagnostic — mirror of pipelex's `Diagnostic`.
 * `severity` stays an open string (the server does not close the vocabulary);
 * `location` and `range` are `null` when the analysis cannot attribute a span.
 */
export interface Diagnostic {
  kind: DiagnosticKind;
  severity: string;
  message: string;
  location: string | null;
  range: DiagnosticRange | null;
}

/** `POST /v1/lint` 200 body — the diagnostics of one linted `.mthds` file. */
export interface LintResponse {
  diagnostics: Diagnostic[];
}

/**
 * `POST /v1/format` 200 body — the canonically formatted content, whether it
 * differs from the submitted one, and any diagnostics found on the way. A syntax
 * error yields `changed: false` with the content echoed back unchanged.
 */
export interface FormatResponse {
  formatted: string;
  changed: boolean;
  diagnostics: Diagnostic[];
}

// ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`) ──
//
// `/v1/resolve` emits the normalized library crate, `/v1/codegen` projects that crate
// into stamped typed artifacts plus their lock, and `/v1/pipe-io` derives a method's
// three I/O artifacts with no dry run. All three are Pipelex API extensions (NOT
// `x-mthds-protocol`) over standard-owned artifacts, so their wire fields stay
// brand-neutral. They share one closure envelope (`CrateRequestBase`) and one verdict
// discipline: a produced verdict is a 200 discriminated on `is_valid`, with
// `CrateInvalidReport` as the shared invalid arm.

/**
 * The method every crate route takes — `/v1/resolve`, `/v1/codegen` and `/v1/pipe-io`
 * (mirror of the runner's `MethodTreeRequest`).
 *
 * Supply the method EITHER as its tree OR as a `method_ref` — never both, and never neither
 * (both arms are a request-shape `422`); the hosted `method_id` joins them as a third form on
 * each route's own request (see {@link PipelexHostedToolingExtensions}). The tree is the MTHDS
 * protocol's map of file entries, keyed by tree path, given in exactly one of the four forms
 * every route takes (`MethodTreeForms`):
 *
 * - `directory`, the method's directory on disk, listed by the `mthds` package's lister under
 *   the standard's membership rule and the deployment's limits (Node only);
 * - `contents`, each file's bytes or text by tree path;
 * - `tree`, a `MethodTreeSource`, such as the `MethodTree` the `mthds` package's
 *   `listMethodTree` returns;
 * - `files`, the map itself, each value the file's text, `{ base64 }` or `{ sha256, size }` for
 *   bytes the runner already holds, sent as given.
 *
 * The client sends a `directory`, `contents` or `tree` inline when its inline map weighs 256 KiB
 * or less and no more than the inline limit the API announces, or whatever its weight when the
 * API keeps no blob store, and otherwise every file by hash, after uploading the files the API
 * lacks, exactly as `createMethod` sends one (see `docs/method-trees.md`). Every `.mthds` file of
 * the tree is one of the method's bundles, named by its tree path in diagnostics and in the
 * crate's `source_map`, and every other file is one a step may read, such as a `PipeDocGen`
 * template.
 *
 * An **address-form** `method_ref` (`github.com/<owner>/<repo>[/<selector>][@<tag>]`) is
 * resolved by the server (pipelex-api >= 0.21.0): the package's whole tree is fetched at the tag
 * and read as a tree sent in `files` is. The **registry form** (any non-address reference) stays
 * reserved and answers `501` until a method registry exists.
 *
 * The XOR is a server-side invariant, not a type-level one: expressing it as a union here would
 * make the common `{ files }` call site pick a branch for no gain, and the server rejects the
 * illegal shapes with a typed `ApiResponseError` either way. Two forms of the tree at once are
 * the one shape the client refuses itself, with a `RequestArgumentError`, since it prepares the
 * tree before posting. An empty map or string is absent, as in the Python SDK: `files: {}`,
 * `files: null`, `contents: {}`, `directory: ""` and `dependencies: {}` select and send nothing,
 * so an empty one beside another selector never reaches the wire as a second selector.
 *
 * `dependencies` accompanies the tree: the method packages it calls by address that the runner
 * cannot fetch, each a map of file entries keyed by its address, sent as given. These routes load
 * a package the method calls only from what was shipped with it, so a call into one nothing
 * shipped is the invalid verdict.
 *
 * The files the closure's steps read, such as a `PipeDocGen` step's `template_file`, are files of
 * the tree like any other, so a directory sends them with its bundles.
 *
 * `read_scope` is the Pipelex API's scope the request reads the method under: a hash entry of
 * `files` resolves in that scope's blob store, else in the caller's own. A tree sent by hash asks
 * `POST /v1/blobs/missing` under the same scope, so its blobs are uploaded into the store the
 * request reads. **The hosted platform ignores it**: it stamps the caller's organization as the
 * read scope of every crate request and drops the one the caller sent, so it only reaches a
 * runner called directly.
 */
export interface CrateRequestBase {
  /** The method's directory, listed by the standard's lister and sent as `tree` is. Node only. */
  directory?: string | null;
  /** The method's files, each one's bytes or text by tree path, sent as `tree` is. */
  contents?: Readonly<Record<string, Uint8Array | string>> | null;
  /** The method's tree as a listed source, sent inline when small and by hash otherwise. */
  tree?: MethodTreeSource | null;
  /** The method's tree as the protocol's map of file entries, sent as given. */
  files?: MethodFiles | null;
  /** The method packages the tree calls by address, each a map of file entries keyed by its address. */
  dependencies?: Record<string, MethodFiles>;
  method_ref?: string;
  /** The scope the runner reads the tree under; the hosted platform replaces it with the caller's organization. */
  read_scope?: string;
}

/**
 * What a crate route call — `resolve`, `codegen`, `pipeIo` — takes beside its request.
 *
 * `signal` is read between the steps a `tree` or `contents` costs before the request, and before
 * the request itself: once it has aborted, no further file of the tree is read, neither the blob
 * route nor an upload starts, and the route is not asked, and the call throws the abort. A request
 * already sent runs to its end, as in `prepareInputs`, which passes its own `signal` here.
 */
export interface CrateRouteOptions {
  signal?: AbortSignal;
}

/**
 * The `is_valid: false` arm shared by every crate route — `/v1/resolve`,
 * `/v1/codegen` and `/v1/pipe-io` (mirror of the server's one `CrateInvalidReport`).
 *
 * They all follow `/validate`'s discipline: an unresolvable closure is the
 * *successful product* of the call (the request was well-formed, the library was
 * not), so it rides a **200** discriminated on `is_valid` — never a 4xx. Only a
 * no-verdict condition throws `ApiResponseError`: a request the route cannot act on
 * (a pipe selection `pipe-io` refuses, an unknown `kind`/`target` on codegen), the
 * reserved `method_ref`, auth, a server fault. Branch on `is_valid`, never on the
 * transport.
 */
export interface CrateInvalidReport {
  is_valid: false;
  /**
   * One problem item per fault, the same items `/v1/validate` lists for the identical
   * failure, read member by member (`readProblemItems`).
   */
  errors: ProblemItem[];
  message: string;
}

/**
 * `POST /v1/resolve` request — the crate envelope (no projection axes) plus the
 * hosted `method_id` selector. Exactly one of the tree / `method_ref` /
 * `method_id` — the strict tooling XOR; see {@link PipelexHostedToolingExtensions}.
 */
export type ResolveRequest = CrateRequestBase & PipelexHostedToolingExtensions;

/**
 * The `/v1/resolve` valid arm — the normalized library crate.
 *
 * `crate` is the MTHDS **Library Crate Format**: fully qualified refs, refinement
 * flattened, natives materialized, top-level maps key-sorted, non-semantic provenance
 * dropped. Its `fingerprint` and `mthds_version` ride INSIDE the payload, not beside it.
 *
 * **Do not recompute the fingerprint by hashing this object.** It is a property of the
 * logical crate, not of any particular encoding: the server hashes `{concepts, pipes,
 * domains}` with each object's provenance `source` stripped, excluding `source_map`,
 * `mthds_version`, and `fingerprint` itself. Nor are these the same *bytes* the CLI
 * prints — `pipelex resolve --format json` pretty-prints, while this rides a compact
 * JSON response. Same logical crate, different serialization; compare `fingerprint`
 * values, never serialized bytes.
 *
 * Typed as opaque transport (`Record<string, unknown>`): the crate schema is owned by the
 * MTHDS standard, not by this SDK, and restating it here would be a second source of truth
 * free to drift from the one the server emits.
 */
export interface ResolveValidReport {
  is_valid: true;
  crate: Record<string, unknown>;
  message: string;
}

/** The `POST /v1/resolve` 200 response — pattern-match `is_valid` before reading the arm. */
export type ResolveResponse = ResolveValidReport | CrateInvalidReport;

/**
 * What `/v1/codegen` projects — the `kind` axis. `types` (the crate's whole concept set
 * projected into typed models) is the only kind served today; the future per-pipe kinds
 * (`docs`, `tools`, `tests`) join it and select their pipe via `pipe_ref`. Input templates
 * are deliberately NOT a kind here — they are user-editable scaffolds, never stamped or
 * locked, and a client projects one from the input-form descriptor `/v1/pipe-io` returns
 * (`renderInputsTemplate`, from `mthds/protocol`).
 */
export type CodegenKind = "types";

/**
 * For whom `/v1/codegen` projects — the `target` axis, mirroring pipelex's `CodegenTarget`.
 * `ts-zod` (zod schemas + inferred types) is the natural target for TypeScript consumers;
 * `python-pydantic` emits self-contained BaseModels; `python-structures` emits runtime
 * StructuredContent classes for a Pipelex host.
 */
export type CodegenTarget = "ts-zod" | "python-pydantic" | "python-structures";

/**
 * `POST /v1/codegen` request — the crate envelope plus the two explicit projection
 * axes and the hosted `method_id` selector (exactly one of the tree / `method_ref` /
 * `method_id`; see {@link PipelexHostedToolingExtensions}).
 */
export interface CodegenRequest extends CrateRequestBase, PipelexHostedToolingExtensions {
  kind: CodegenKind;
  target: CodegenTarget;
  /**
   * Pipe selector for per-pipe projection kinds. `kind: "types"` is concept-set-wide and
   * REJECTS it with a request-shape `422` rather than silently ignoring it — the field
   * exists for the future per-pipe kinds.
   */
  pipe_ref?: string;
}

/**
 * One stamped generated file of `/v1/codegen`'s artifact set. `path` is relative to the
 * output root the client chooses; `content` is complete, stamp header included, and is
 * written verbatim.
 */
export interface GeneratedArtifact {
  path: string;
  content: string;
}

/**
 * The `/v1/codegen` valid arm — the stamped artifact set plus its lock.
 *
 * The trust chain: write every `artifacts[]` entry at its `path` and the `lock` content as
 * `lock_filename`, both verbatim, and the tree is byte-identical to what a local `pipelex
 * codegen types` run produces — same stamps, same lock — so the offline `pipelex codegen
 * check` passes on it. Editing an artifact (or re-serializing the lock) breaks that chain;
 * there is deliberately no server-side check route, because the check is offline by design.
 */
export interface CodegenValidReport {
  is_valid: true;
  /** Echo of the request's projection axes. */
  kind: CodegenKind;
  target: CodegenTarget;
  /** Fingerprint of the normalized crate the artifacts were generated from. */
  crate_fingerprint: string;
  /** The pipelex engine version that generated them. */
  engine_version: string;
  artifacts: GeneratedArtifact[];
  /** The lock file's TOML content — write verbatim beside the artifacts. */
  lock: string;
  /** The filename `lock` must be written as (`codegen.lock`). */
  lock_filename: string;
  message: string;
}

/** The `POST /v1/codegen` 200 response — pattern-match `is_valid` before reading the arm. */
export type CodegenResponse = CodegenValidReport | CrateInvalidReport;

/**
 * `POST /v1/pipe-io` request — the crate envelope plus the hosted `method_id` selector
 * (exactly one of the tree / `method_ref` / `method_id`; see
 * {@link PipelexHostedToolingExtensions}), a pipe selector, and two opt-ins.
 *
 * There is no `views` field: the valid arm always carries all three artifacts.
 */
export interface PipeIORequest extends CrateRequestBase, PipelexHostedToolingExtensions {
  /**
   * The pipe to describe, as a QUALIFIED `domain.pipe_code` ref. Omit it and the
   * server's selection chain decides: the `main_pipe` of the `METHODS.toml` at the tree's
   * root, whether the tree was sent or fetched, else the closure's single `main_pipe`
   * declaration. A selection the server refuses is a problem coded by what went wrong, of
   * the domain `input`, the candidates in its parameters where there are some:
   * `request.pipe_not_found` for a ref that names no pipe, `request.pipe_unspecified` for
   * (without `all_pipes`) a method with no entry pipe, `request.pipe_ambiguous` for a code that
   * matches pipes in several domains or (without `all_pipes`) several `main_pipe` declarations.
   * A malformed request is `request.malformed`.
   *
   * The server does not refuse a bare code yet: a bare ref that matches one pipe is
   * resolved across domains, and the valid arm reports the qualified ref.
   */
  pipe_ref?: string;
  /**
   * Describe every pipe the closure loads instead of the selected one. The artifact maps
   * are then keyed by every pipe, and the route never refuses for want of an entry pipe:
   * the valid arm's `pipe_ref` is the requested ref, else the method's own entry pipe,
   * else `null`. Defaults to `false` server-side.
   */
  all_pipes?: boolean;
  /**
   * Echo the text of the method's own `.mthds` bundles on the valid arm as `files`, keyed
   * by tree path. Defaults to `false` server-side, and the field is then absent from the
   * answer.
   */
  include_files?: boolean;
}

/**
 * The `/v1/pipe-io` valid arm — a method's three I/O artifacts, with the selection and
 * the runnability facts beside them.
 *
 * The three artifacts are the MTHDS standard's own types, imported from `mthds/protocol`
 * and never restated here. The maps share one key set: the resolved `pipe_ref` alone by
 * default, every pipe the closure loads under `all_pipes`. For a closure `/v1/validate`
 * also accepts, each map equals validate's same-named field restricted to the same keys.
 *
 * `is_valid: true` means what it means on `/v1/resolve`: the closure parsed, loaded and
 * passed static validation. No dry run ran; that verdict stays `validate`'s.
 */
export interface PipeIOValidReport {
  is_valid: true;
  /**
   * The qualified ref the selection resolved, read off the resolved pipe and never echoed
   * from the request. `null` only under `all_pipes` when no pipe was requested and the
   * method declares no single entry pipe.
   */
  pipe_ref: string | null;
  /** The standard's pipe I/O contracts, keyed by qualified `pipe_ref`. */
  pipe_io_contracts: PipeIOContracts;
  /** The standard's input-form descriptors, keyed by qualified `pipe_ref`. */
  input_form: InputForm;
  /** The standard's output-form descriptors, keyed by qualified `pipe_ref`. */
  output_form: OutputForm;
  /**
   * The method's own entry pipe: the selection chain without the request's `pipe_ref` —
   * the `main_pipe` of the `METHODS.toml` at the tree's root, sent or fetched, else the
   * closure's single declaration. A request
   * that omits `pipe_ref` always answers `pipe_ref === default_pipe_ref`. A stated `null`
   * when the chain finds none or several.
   *
   * NOT `PipelexValidationReport.default_pipe_ref`, which is the run default and names
   * the first of several declaring domains where this chain refuses to choose.
   */
  default_pipe_ref: string | null;
  /** Qualified refs of every pipe of the closure still declared as a signature, as on `validate`. */
  pending_signatures: string[];
  /** `pending_signatures` is empty, as on `validate`. No dry run backs it. */
  is_runnable: boolean;
  /**
   * The text of each `.mthds` bundle of the method's own tree, keyed by its tree path.
   * Present only when the request passed `include_files: true`: for a tree the request
   * sent, its bundles, whatever entry form carried them; for a `method_ref`, the fetched
   * package's, keyed by their path from the package root; for a hosted `method_id`, the
   * stored tree's. The tree's other files and its dependencies' bundles are never included.
   */
  files?: Record<string, string>;
}

/** The `POST /v1/pipe-io` 200 response — pattern-match `is_valid` before reading the arm. */
export type PipeIOResponse = PipeIOValidReport | CrateInvalidReport;

// ── Model reference check (Pipelex API — `GET /v1/models/check`) ────────
//
// Whether one model reference resolves on the runner, as what kind of reference and to
// which model. A Pipelex API extension (NOT `x-mthds-protocol`), served by any
// `pipelex-api` runner from pipelex 0.78.0 and relayed byte-identically by the hosted
// platform. It answers from pipelex's own reference parser and deck lookups, the ones a
// validation runs, so a reference found `resolved` in a category is one a pipe of that
// category may name, and one found `not_found` is one a validation refuses.
//
// A verdict is a 200 whatever the resolution. Only a request that cannot produce one is
// a 422 problem, surfaced as `ApiResponseError`: `InvalidModelReference` for a reference
// that is blank, a sigil or a namespace alone, or too long; `InvalidModelCategory` for an
// unknown `type`; `ValidationError` for a missing or repeated parameter. The SDK checks
// none of this itself, so the runner's rule is the only one.

/**
 * The categories the check covers, in the order every list it returns follows: the MTHDS
 * Protocol's model categories, in the protocol's order, then `doc_gen`, the family of
 * `PipeDocGen`. The protocol defines no category for `doc_gen`, so `GET /v1/models` leaves
 * it out, but a method names a `doc_gen` model in its `model` field like any other, so the
 * check covers it.
 *
 * A request names one of these. A verdict reads them open, as `mthds` reads `ModelInfo.type`: a
 * runner of a later version may add a category, so a consumer that switches on one has to
 * say what an unknown value does.
 */
export type ModelCheckCategory = "llm" | "extract" | "img_gen" | "search" | "judgment" | "doc_gen";

/**
 * What a reference names, from its parsing: a sigil (`$` preset, `@` alias, `~` waterfall),
 * else a spelled-out namespace (`preset:`, `alias:`, `waterfall:`, `handle:`), else a bare
 * model handle.
 */
export type ModelReferenceKind = "preset" | "alias" | "waterfall" | "handle";

/** Whether a reference resolves in a category in scope. Both values are definitive. */
export type ModelReferenceResolution = "resolved" | "not_found";

/** The fields every `matches` entry carries, whatever the reference's kind. */
export interface ModelReferenceMatchBase {
  /** The category this entry is about; read open (see {@link ModelCheckCategory}). */
  category: ModelCheckCategory | (string & {});
  /**
   * The model handle a run through the reference would call now in this category, or
   * `null` when it would find none: a target on a backend the runner has not enabled, a
   * waterfall none of whose usable steps the runner serves, an alias cycle. The reference
   * still resolves, as a validation accepts it, but a run through it fails, so show it as a
   * warning rather than as an unknown name.
   */
  resolves_to: string | null;
}

/** What a preset reference is in one category. */
export interface PresetMatch extends ModelReferenceMatchBase {
  /** The model the deck binds the preset to, as the deck writes it, which may itself be a reference (`@default-premium`). */
  target: string;
  /** The preset's description, or `null` when the deck gives it none. */
  description: string | null;
}

/** What an alias reference is in one category. */
export interface AliasMatch extends ModelReferenceMatchBase {
  /** The model the deck binds the alias to, as the deck writes it, which may itself be a reference. */
  target: string;
}

/** What a waterfall reference is in one category. */
export interface WaterfallMatch extends ModelReferenceMatchBase {
  /** The waterfall's steps, in order. */
  fallbacks: string[];
}

/** What a bare handle reference is in one category. */
export interface HandleMatch extends ModelReferenceMatchBase {
  /** The presets, aliases and waterfalls of this category whose binding names the handle directly, each written as a reference. */
  via: string[];
}

/**
 * One `matches` entry. An entry carries no `kind` of its own: the verdict's `kind` says
 * which shape every entry of that verdict has, so narrow the verdict (see
 * {@link ModelReferenceVerdict}) rather than the entry.
 */
export type ModelReferenceMatch = PresetMatch | AliasMatch | WaterfallMatch | HandleMatch;

/** The fields every verdict carries, whatever the reference's kind. */
export interface ModelReferenceVerdictBase {
  /** The caller's reference, trimmed. */
  reference: string;
  /** The reference without its sigil or namespace. */
  name: string;
  /** The `type` asked, or `null` when none was; read open (see {@link ModelCheckCategory}). */
  category: ModelCheckCategory | (string & {}) | null;
  /**
   * Whether the reference resolves in a category in scope. Open on purpose, under the
   * spec's reader rule: "a client that reads a value it does not know treats the reference
   * as unresolved". `string & {}` keeps the editor's completion on the two known values,
   * and a consumer that switches on this field has to say what an unknown value does.
   */
  resolution: ModelReferenceResolution | (string & {});
  /** On `not_found`, the nearest names the caller may have meant, written as a method writes them; empty when it is `resolved`. */
  suggestions: string[];
  /** On `not_found`, the same name under another kind, in the categories in scope (`@best-claude` for `$best-claude`); empty when it is `resolved`. Show it first: it is the likeliest fault. */
  other_kinds: string[];
  /** On `not_found` with a `type`, the categories outside it where the same reference resolves; empty otherwise. Read open (see {@link ModelCheckCategory}). */
  other_categories: (ModelCheckCategory | (string & {}))[];
}

/** A verdict on a preset reference (`$name` or `preset:name`). */
export interface PresetReferenceVerdict extends ModelReferenceVerdictBase {
  kind: "preset";
  /** One entry per category in scope where the reference resolves, in the order of the categories the check covers; empty on `not_found`. */
  matches: PresetMatch[];
}

/** A verdict on an alias reference (`@name` or `alias:name`). */
export interface AliasReferenceVerdict extends ModelReferenceVerdictBase {
  kind: "alias";
  /** One entry per category in scope where the reference resolves, in the order of the categories the check covers; empty on `not_found`. */
  matches: AliasMatch[];
}

/** A verdict on a waterfall reference (`~name` or `waterfall:name`). */
export interface WaterfallReferenceVerdict extends ModelReferenceVerdictBase {
  kind: "waterfall";
  /** One entry per category in scope where the reference resolves, in the order of the categories the check covers; empty on `not_found`. */
  matches: WaterfallMatch[];
}

/** A verdict on a bare model handle (`name` or `handle:name`). */
export interface HandleReferenceVerdict extends ModelReferenceVerdictBase {
  kind: "handle";
  /** One entry per category in scope where the reference resolves, in the order of the categories the check covers; empty on `not_found`. */
  matches: HandleMatch[];
}

/**
 * The `GET /v1/models/check` 200 response — one arm per reference kind, discriminated on
 * the wire's own `kind`. Narrowing on `kind` narrows `matches` with it
 * (`verdict.kind === "preset"` makes every entry a {@link PresetMatch}), since all the
 * matches of one verdict share its kind; no field is added to the wire to make it so.
 */
export type ModelReferenceVerdict =
  | PresetReferenceVerdict
  | AliasReferenceVerdict
  | WaterfallReferenceVerdict
  | HandleReferenceVerdict;
