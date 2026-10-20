# The files a bundle's steps read (`resources`)

A bundle sent to the API as content has no directory, so a file one of its steps reads from beside the bundle has to travel with it. Today that is a `PipeDocGen` step's `template_file`: the Word, Excel or PowerPoint template it fills, or the HTML template it prints as a PDF. The runner takes such files as the request's `resources`, a JSON object mapping each file's path, exactly as the step names it, to the file's bytes in standard padded base64. This SDK takes the bytes from you, keyed by that path, and encodes them.

```ts
import { readFile } from "node:fs/promises";

const mthds = await readFile("invoicing/bundle.mthds", "utf8");
const resources = {
  "templates/invoice.docx": await readFile("invoicing/templates/invoice.docx"),
};

const verdict = await client.validate([mthds], false, ["bundle.mthds"], undefined, undefined, {
  resources,
});
const result = await client.startAndWaitForResult({ mthds_contents: [mthds], resources, inputs });
```

## Where they go

| Call | Where `resources` goes |
| --- | --- |
| `validate(contents, …, options)` | `options.resources`, beside inline contents or a hosted `{ method_id }` |
| `validateFiles(files, options)` | `options.resources` |
| `execute(options)`, `start(options)`, `startAndWaitForResult(options)` | `options.resources`, beside `mthds_contents`, a method bundle (`files` or `bundle_b64`) or a hosted `method_id`; the blocking fallback a bare runner takes sends them too |
| `pipeIo(request)`, `resolve(request)`, `codegen(request)` | `request.resources`, beside inline `files` |
| `prepareInputs(request)` | `request.resources`, beside inline `files`, sent with the one pipe I/O request that reads the signature |

An absent, `null` or empty map is not sent.

A request carrying `resources` can be large, so every route gives it the client's request ceiling (`requestTimeoutMs`, twenty minutes by default, the execute ceiling): `validate` and `validateFiles` have it by default (a caller's `timeoutMs` still overrides it), and `start` and the crate routes raise their shorter default to it for a request that carries a file. On the hosted API the gateway caps a request at about 30 seconds whatever the client allows.

## The key is the path the step names

Each key is the file's path relative to the bundle, written with forward slashes, exactly as the step's `template_file` writes it: `templates/invoice.docx`. The runner collapses `.` segments and repeated slashes, so `./templates/invoice.docx` names the same file, and the SDK sends the key as you gave it. Every bundle of a request is read as sitting in one directory, so a step in `steps/print.mthds` that names `templates/invoice.docx` reads the file sent under `templates/invoice.docx`, wherever it sat on your disk.

## The value is the file's bytes

A value is a `Uint8Array` (a Node `Buffer` is one), an `ArrayBuffer` or a `Blob`, the byte forms `uploadFile` takes. The SDK sends each in standard base64 with padding. A string is refused: it would have to be a path the SDK reads or base64 it decodes, and it is neither. The SDK reads no file because a request named it, which keeps a server that sends a request on a caller's behalf from reading its own files; read the file yourself and pass its bytes.

## What the SDK refuses before any request

Each of these is a `RequestArgumentError`, `input` and not retryable, thrown before anything is encoded or sent:

- **A key that cannot name a file inside the bundle**: an empty path or one of nothing but whitespace, as Python counts it, a backslash, a colon, a NUL character, an absolute path, a `..` segment, or a path that names no file (`./`). It is the runner's own rule, which it answers with a `422` `InvalidResourcePath`.
- **Two keys that name one file** once `.` segments and repeated slashes collapse, such as `a.docx` and `./a.docx`.
- **A value that is not bytes**, and a `resources` that is not a plain object mapping paths to bytes: a `Map`, an array or a class instance is refused rather than read as carrying no file (pass `Object.fromEntries(map)`).
- **`resources` in `extra`**: it is a named option, so the passthrough cannot carry it past these checks.
- **A pairing the runner refuses**, on the routes where the SDK already mirrors the runner's pairings. On `execute` and `start`, `resources` beside a `method_ref`, whose files are its package's own, or with no source at all for them to accompany. On `validate`, `resources` beside a `{ method_ref }`. A hosted `method_id` without inline source is left to the server, since the platform resolves it into the bundle the runner reads the files with. `prepareInputs` takes `resources` beside inline `files` only, and refuses them beside a `method_ref` or a `method_id` with an `InputPreparationError`.

The crate routes post their request as given, apart from encoding `resources`, and leave their pairings to the server, which answers `resources` beside a `method_ref` with a `422` `ValidationError`.

The sizes are left to the server, since a deployment configures them.

## What the server refuses

Every refusal is an `ApiResponseError`, `input` and not retryable; branch on its `errorType`:

| Status | `errorType` | When |
| --- | --- | --- |
| `422` | `InvalidResourcePath` | A key that cannot name a file inside the bundle, two keys for one file, or, on a run route, two different files under one path, one sent in `resources` and one shipped in a method bundle. |
| `422` | `BundleResourceNotNamedError` | A file no step of the bundle names, on every route, the diagnostic ones included; its detail lists the unnamed paths. A misspelled key fails here rather than leaving its step without its file. |
| `422` | `ValidationError` | `resources` beside a `method_ref`, or on a run route with no bundle. |
| `422` | `MethodTreeTooLarge` | The files sent in `resources`, joined to the method tree they accompany, take it past one of the runner's tree limits. An `.html` template file is counted like any other file, with no limit of its own. |
| `413` | `PayloadTooLarge` | More files than the deployment allows (32 by default), a file over its per-file limit (5 MiB by default), or more bytes in all than its total (10 MiB by default), counting the files a method bundle ships for its steps. |
| `400` | `InvalidBase64` | A value that is not base64, which a request this SDK encoded never carries. |

## A step whose file was not sent

A step that names a template file the request did not send cannot load. On `validate`, `pipeIo`, `resolve` and `codegen` that is an `is_valid: false` verdict whose validation error says the file was not supplied with its bundle and names the key it is expected under; `prepareInputs` throws it as a `MethodLoadError`. On `execute` and `start` it is a `422` `ValidateBundleError`, whose `validationErrors` say the same.

## The template check's warnings

A dry run hands an office template file it was sent to the document engine's template check. An error finding fails the step's dry run, and so the verdict, as a `dry_run` validation error on the step. A warning finding, such as a field of the template that matches no input, rides the valid verdict's `warnings` as a `template_check_warning` item:

| Member | Value |
| --- | --- |
| `category` | `dry_run` |
| `error_type` | `template_check_warning` |
| `pipe_code`, `domain_code` | The `PipeDocGen` step |
| `template_file` | The template file as the step names it; `null` for a step of the server's own library, whose path is never shown |
| `template_location` | The place in the file the finding names, in the engine's words (a defined name, a table, a cell, a shape, a tag); `null` when it names none |
| `message` | The finding in words |

The warnings come in families, always in this order: `optional_force_redundant`, `input_presence_vacuous`, the `hint_*` lints, then `template_check_warning`. None of them flips `is_valid`.

```ts
if (verdict.is_valid) {
  for (const warning of verdict.warnings) {
    if (warning.error_type === "template_check_warning") {
      console.warn(`${warning.template_file ?? "?"} ${warning.template_location ?? ""}: ${warning.message}`);
    }
  }
}
```

## Method bundles

On `execute` and `start`, a method bundle sent as a zip (`bundle_b64`) may ship a template file beside the `.mthds` file whose step names it, as it sits on disk, and the runner reads it as if it had come in `resources`, under the same limits. A file both shipped and sent must hold the same bytes. The `files` map of a method bundle carries text, so it can ship an `.html` template but not an office one, which goes in `bundle_b64` or in `resources`.

## The `.mthds` check hook

The post-edit hook this package builds sends the template files of the bundle it validates: see [`hook-bundle.md`](./hook-bundle.md#what-the-hook-does-with-a-file).

## Which servers read them

A `pipelex-api` runner reads `resources` from the first pipelex release after 0.84.0. The hosted API reads them once its platform forwards them to a runner on such a release. A runner that predates the field ignores it, so a step that names a template file fails to load there, the verdict saying the file was not supplied.
