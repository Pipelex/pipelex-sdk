"""Test data constants for the unit suite, grouped by what they stand for."""

from typing import Any, ClassVar

from mthds.method_tree.file_entry import FileEntry

from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict


class RefusedRunBodies:
    """Problem documents the dev plane answered when it refused to run a method, as they came off the wire.

    Copied byte for byte from `mthds-python`'s `tests/unit/test_data.py` (`RefusedRunBodies`), where
    they were captured on 2026-09-27 through `MthdsAPIClient` against `https://api-dev.pipelex.com`
    (pipelex-api v0.29.0 on pipelex 0.67.0): a bundle the runner refused at load with an itemized
    diagnostic, a run that failed at a pipe's combine step, and a run that failed on a model the deck
    does not serve. Keeping the same bytes in both clients' suites is what shows the two read a refusal
    alike.
    """

    UNKNOWN_MODEL_AT_LOAD: ClassVar[str] = (
        '{"type":"https://docs.pipelex.com/latest/errors/validate-bundle-error/","title":"Validate bundle","status":422,'
        "\"detail\":\"Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck\\n\\n"
        'Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna","instance":"/v1/execute",'
        '"request_id":"req_a3dd6900-7909-48d3-b551-0140e73ac7fc","error_category":"configuration","error_domain":"input",'
        '"retryable":false,"error_type":"ValidateBundleError","validation_errors":[{"category":"pipe_validation",'
        "\"message\":\"Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck\\n\\n"
        'Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna","error_type":"unknown_model",'
        '"pipe_code":"draft_pitch","domain_code":"sales_copy","field_path":"pipe.draft_pitch.model","field_name":"model",'
        '"model_reference":"gpt-5.1","model_type":"llm","suggestions":["gpt-5.5","gpt-5.4","gpt-5.6-sol","gpt-5.4-pro","gpt-5.6-luna"]}],'
        '"user_action":{"kind":"change_input","detail":"Edit the bundle as each validation error says: apply its suggested fix '
        'where it has one, after confirming an unsafe one"}}'
    )
    UNKNOWN_MODEL_DETAIL: ClassVar[str] = (
        "Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck\n\n"
        "Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna"
    )
    UNKNOWN_MODEL_NEXT_STEP: ClassVar[str] = (
        "Edit the bundle as each validation error says: apply its suggested fix where it has one, after confirming an unsafe one"
    )

    COMBINE_FAILURE_AT_RUN: ClassVar[str] = (
        '{"type":"https://docs.pipelex.com/latest/errors/stuff-factory-error/","title":"Stuff factory","status":422,'
        "\"detail\":\"Pipe 'analyze_topics' failed (review_topics → analyze_topics): PipeParallel 'analyze_topics' cannot "
        "combine its branch results into its output 'TopicReview'. Branch 'draft_ideas' gives result 'ideas' as a list, "
        "'Idea[]', but field 'ideas' of 'TopicReview' holds a single item. Declare the field as a list in the structure of "
        "'TopicReview', with type 'list', item_type 'concept' and item_concept_ref 'Idea', or make branch 'draft_ideas' output "
        'a single \'Idea\'.","instance":"/v1/execute","request_id":"req_d4212542-63a6-4ddb-87c9-4b968785c8c5",'
        '"error_domain":"input","error_type":"StuffFactoryError","user_action":{"kind":"change_input","detail":"Branch '
        "'draft_ideas' gives result 'ideas' as a list, 'Idea[]', but field 'ideas' of 'TopicReview' holds a single item. "
        "Declare the field as a list in the structure of 'TopicReview', with type 'list', item_type 'concept' and "
        "item_concept_ref 'Idea', or make branch 'draft_ideas' output a single 'Idea'.\"}}"
    )
    COMBINE_FAILURE_NEXT_STEP: ClassVar[str] = (
        "Branch 'draft_ideas' gives result 'ideas' as a list, 'Idea[]', but field 'ideas' of 'TopicReview' holds a single item. "
        "Declare the field as a list in the structure of 'TopicReview', with type 'list', item_type 'concept' and "
        "item_concept_ref 'Idea', or make branch 'draft_ideas' output a single 'Idea'."
    )

    UNSERVED_MODEL_AT_RUN: ClassVar[str] = (
        '{"type":"https://docs.pipelex.com/latest/errors/model-not-found-error/","title":"Model not found","status":422,'
        "\"detail\":\"Pipe 'condense_article' failed (digest_article → condense_article): Model handle 'gpt-5.1' was not "
        'found in the model deck.","instance":"/v1/execute","request_id":"req_b7d2c66f-b2d5-4dc7-bd4f-6cf98abfbdc0",'
        '"error_category":"configuration","error_domain":"input","retryable":false,"error_type":"ModelNotFoundError",'
        '"user_action":{"kind":"change_model","detail":"Change the model \'gpt-5.1\' to an LLM the model deck serves."}}'
    )
    UNSERVED_MODEL_DETAIL: ClassVar[str] = (
        "Pipe 'condense_article' failed (digest_article → condense_article): Model handle 'gpt-5.1' was not found in the model deck."
    )
    UNSERVED_MODEL_NEXT_STEP: ClassVar[str] = "Change the model 'gpt-5.1' to an LLM the model deck serves."


class PipeIOBodies:
    """`POST /v1/pipe-io` bodies, trimmed from what a local `pipelex-api` at `b4bafb8` (pipelex 0.70.0)
    answered on 2026-09-30 for a one-pipe bundle: a Document, a Text, and a structured `Dossier` whose
    optional `cover` is an Image. Only the JSON Schemas were shortened; every artifact member the
    standard declares is kept, so the bodies parse under the closed `mthds.protocol` models.
    """

    PIPE_REF: ClassVar[str] = "smoke.echo"
    TEXT_SCHEMA: ClassVar[dict[str, Any]] = {
        "properties": {"text": {"title": "Text", "type": "string"}},
        "required": ["text"],
        "title": "native.Text",
        "type": "object",
    }
    VALID: ClassVar[dict[str, Any]] = {
        "is_valid": True,
        "pipe_ref": "smoke.echo",
        "pipe_io_contracts": {
            "smoke.echo": {
                "inputs": {
                    "doc": {
                        "concept_ref": "native.Document",
                        "presence": "plain",
                        "multiplicity": "single",
                        "item_count": None,
                        "json_schema": {"properties": {"url": {"type": "string"}}, "required": ["url"], "title": "native.Document", "type": "object"},
                    },
                    "note": {
                        "concept_ref": "native.Text",
                        "presence": "plain",
                        "multiplicity": "single",
                        "item_count": None,
                        "json_schema": TEXT_SCHEMA,
                    },
                },
                "output": {"concept_ref": "native.Text", "multiplicity": "single", "item_count": None, "optional": False, "json_schema": TEXT_SCHEMA},
            }
        },
        "input_form": {
            "smoke.echo": {
                "fields": [
                    {"kind": "document", "name": "doc", "concept_ref": "native.Document", "required": True, "presence": "plain", "gating": True},
                    {"kind": "prose", "name": "note", "concept_ref": "native.Text", "required": True, "presence": "plain", "gating": True},
                    {
                        "kind": "object",
                        "name": "dossier",
                        "concept_ref": "smoke.Dossier",
                        "required": True,
                        "presence": "plain",
                        "gating": True,
                        "fields": [
                            {"kind": "text", "name": "title", "required": True},
                            {"kind": "image", "name": "cover", "concept_ref": "native.Image", "required": False},
                        ],
                    },
                ]
            }
        },
        "output_form": {"smoke.echo": {"field": {"kind": "prose", "name": "output", "concept_ref": "native.Text", "required": True}}},
        "default_pipe_ref": "smoke.echo",
        "pending_signatures": [],
        "is_runnable": True,
    }
    INVALID: ClassVar[dict[str, Any]] = {
        "is_valid": False,
        "validation_errors": [
            {
                "category": "blueprint_validation",
                "message": "Input 'doc' is declared but never read by the template.",
                "error_type": "extraneous_input_variable",
                "pipe_code": "echo",
                "domain_code": "smoke",
                "source": "smoke.mthds",
            }
        ],
        "message": "1 validation error",
    }
    #: The selection refusals, as a local `pipelex-api` at `db9daa4` (the v0.33.1 fix) answered them on
    #: 2026-09-30, less the per-request `request_id` and with the not-found `detail` shortened: the
    #: runner's entry-lookup error class is the `error_type`, and the candidates, where there are any,
    #: are named in `detail` alone.
    UNKNOWN_PIPE_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/entry-pipe-not-found-error/",
        "title": "Entry pipe not found",
        "status": 422,
        "detail": "Pipe 'smoke.absent' not found in the submitted closure.",
        "instance": "/v1/pipe-io",
        "error_type": "EntryPipeNotFoundError",
        "error_domain": "input",
        "user_action": {
            "kind": "change_input",
            "detail": "Check the pipe code for typos and make sure the bundle in scope for this operation declares it.",
        },
    }
    AMBIGUOUS_PIPE_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/entry-pipe-ambiguous-error/",
        "title": "Entry pipe ambiguous",
        "status": 422,
        "detail": "No `pipe_ref` was given and the closure declares several `main_pipe`s (alpha.run, beta.run) — name the pipe explicitly.",
        "instance": "/v1/pipe-io",
        "error_type": "EntryPipeAmbiguousError",
        "error_domain": "input",
        "user_action": {"kind": "change_input", "detail": "Send a `pipe_ref` naming one of the declared `main_pipe`s."},
    }
    #: A `422` that is not a selection: the request-shape refusal the runner renders for a malformed body.
    REQUEST_SHAPE_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/validation-error/",
        "title": "Validation error",
        "status": 422,
        "detail": "body: Value error, provide exactly one of `files` or `method_ref`",
        "error_type": "ValidationError",
        "error_domain": "input",
        "retryable": False,
        "instance": "/v1/pipe-io",
    }


class MethodVersionBodies:
    """A saved method and its published versions, as the platform serializes them (`MethodPublic`, `MethodDetail`,
    `MethodVersionSummary`, `MethodVersionDetail`).

    The draft and each version name a method tree by its digest, and a read lists the tree's files, each
    with a short-lived link to its bytes. The draft's token (`updated_at`) carries microseconds, which a
    client echoes verbatim.
    """

    DIGEST: ClassVar[str] = "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47"
    OTHER_DIGEST: ClassVar[str] = "sha256:0d1c2b3a49586776a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e"
    TOKEN: ClassVar[str] = "2026-10-08T09:00:00.123456+00:00"
    #: A run's `source_digest`, the SHA-256 of the sources it sent as text: 64 hex digits, no `sha256:` prefix.
    SOURCE_DIGEST: ClassVar[str] = "5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47"

    SUMMARY: ClassVar[dict[str, Any]] = {
        "version": 3,
        "tree_digest": DIGEST,
        "crate_fingerprint": "a1b2c3",
        "runner_version": "0.80.0",
        "description": "Review a receipt",
        "published_at": "2026-10-08T09:00:00+00:00",
        "published_by": "user_1",
    }

    #: The tree's files in tree path order, each with a presigned link to its bytes.
    FILES: ClassVar[list[dict[str, Any]]] = [
        {
            "path": "helper.py",
            "sha256": "8ff436def1451285599a1b1ad70800493b8dcafde2912e1a38345633054e4c26",
            "size": 5,
            "url": "https://app-bucket.s3.amazonaws.com/org_1/blobs/8ff436def1451285599a1b1ad70800493b8dcafde2912e1a38345633054e4c26?X-Amz-Signature=abc",
            "expires_at": "2026-10-08T09:15:00+00:00",
        },
        {
            "path": "main.mthds",
            "sha256": "16c322ec9ceeb29cf54ef4553f087cba1683c3f20f3bf334e49ccc2ad0ecba3e",
            "size": 19,
            "url": "https://app-bucket.s3.amazonaws.com/org_1/blobs/16c322ec9ceeb29cf54ef4553f087cba1683c3f20f3bf334e49ccc2ad0ecba3e?X-Amz-Signature=def",
            "expires_at": "2026-10-08T09:15:00+00:00",
        },
    ]

    METHOD: ClassVar[dict[str, Any]] = {
        "method_id": "mt_receipts01",
        "org_id": "org_1",
        "created_by_user_id": "user_1",
        "name": "Receipt review",
        "input_data": {"total": 1},
        "pipe_output": None,
        "description": "Review a receipt",
        "created_at": "2026-10-01T09:00:00+00:00",
        "updated_at": TOKEN,
        "deletion_state": None,
        "draft_digest": DIGEST,
        "latest_version": 3,
        "latest_published": SUMMARY,
    }

    METHOD_DETAIL: ClassVar[dict[str, Any]] = {**METHOD, "files": FILES}

    NEVER_PUBLISHED: ClassVar[dict[str, Any]] = {**METHOD, "latest_version": None, "latest_published": None}

    VERSION: ClassVar[dict[str, Any]] = {**SUMMARY, "method_id": "mt_receipts01", "files": FILES}

    INVALID_VERDICT: ClassVar[dict[str, Any]] = {
        "is_valid": False,
        "message": "The bundle does not validate.",
        "validation_errors": [{"category": "pipe_validation", "message": "Pipe 'review' has no output."}],
    }


class MethodExampleBodies:
    """A method's saved examples, as the platform serializes them (`MethodExample`, `MethodExamplePage`).

    The inputs hold an integer and a float, which an example returns exactly as they were saved.
    """

    METHOD_ID: ClassVar[str] = "mt_receipts01"
    EXAMPLE_ID: ClassVar[str] = "ex_0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6a7b"

    INPUTS: ClassVar[dict[str, Any]] = {"receipt": {"url": "pipelex-storage://org_1/receipt.pdf"}, "total": 3, "rate": 3.5}

    EXAMPLE: ClassVar[dict[str, Any]] = {
        "example_id": EXAMPLE_ID,
        "method_id": METHOD_ID,
        "name": "March receipt",
        "inputs": INPUTS,
        "input_revision": 2,
        "latest_run_id": "run_1",
        "created_by_user_id": "user_1",
        "created_at": "2026-10-12T09:00:00+00:00",
        "updated_at": "2026-10-12T10:00:00+00:00",
    }

    #: The same example after an edit of its inputs: the next revision, with no latest run.
    REVISED: ClassVar[dict[str, Any]] = {**EXAMPLE, "inputs": {"total": 4}, "input_revision": 3, "latest_run_id": None}


class ModelCheckBodies:
    """Bodies of `GET /v1/models/check`, shaped as pipelex 0.78.0's own `ModelReferenceVerdict` writes them.

    Every verdict field is present, and a match carries exactly the fields of the verdict's kind; each
    verdict validates against the runner's closed models. The refusals are what `pipelex-api` 0.78.0's
    problem builder renders for the check, with the `detail` of the reference refusal shortened.
    """

    RESOLVED_PRESET: ClassVar[dict[str, Any]] = {
        "reference": "$writing-factual",
        "kind": "preset",
        "name": "writing-factual",
        "category": "llm",
        "resolution": "resolved",
        "matches": [
            {
                "category": "llm",
                "resolves_to": "claude-4.8-opus",
                "target": "@default-premium",
                "description": "Factual writing with high accuracy",
            }
        ],
        "suggestions": [],
        "other_kinds": [],
        "other_categories": [],
    }
    RESOLVED_ALIAS: ClassVar[dict[str, Any]] = {
        "reference": "@best-claude",
        "kind": "alias",
        "name": "best-claude",
        "category": None,
        "resolution": "resolved",
        "matches": [{"category": "llm", "resolves_to": "claude-4.8-opus", "target": "claude-4.8-opus"}],
        "suggestions": [],
        "other_kinds": [],
        "other_categories": [],
    }
    RESOLVED_WATERFALL: ClassVar[dict[str, Any]] = {
        "reference": "~robust-llm",
        "kind": "waterfall",
        "name": "robust-llm",
        "category": "llm",
        "resolution": "resolved",
        "matches": [{"category": "llm", "resolves_to": "claude-4.8-opus", "fallbacks": ["claude-4.8-opus", "gpt-5.5"]}],
        "suggestions": [],
        "other_kinds": [],
        "other_categories": [],
    }
    RESOLVED_HANDLE: ClassVar[dict[str, Any]] = {
        "reference": "claude-4.8-opus",
        "kind": "handle",
        "name": "claude-4.8-opus",
        "category": None,
        "resolution": "resolved",
        "matches": [{"category": "llm", "resolves_to": "claude-4.8-opus", "via": ["@best-claude", "~robust-llm"]}],
        "suggestions": [],
        "other_kinds": [],
        "other_categories": [],
    }
    #: A preset of the deck asked in a category it is not defined in.
    NOT_FOUND_IN_CATEGORY: ClassVar[dict[str, Any]] = {
        "reference": "$writing-factual",
        "kind": "preset",
        "name": "writing-factual",
        "category": "img_gen",
        "resolution": "not_found",
        "matches": [],
        "suggestions": [],
        "other_kinds": [],
        "other_categories": ["llm"],
    }
    #: A misspelt alias, asked in every category.
    NOT_FOUND_MISSPELT: ClassVar[dict[str, Any]] = {
        "reference": "@best-cluade",
        "kind": "alias",
        "name": "best-cluade",
        "category": None,
        "resolution": "not_found",
        "matches": [],
        "suggestions": ["@best-claude"],
        "other_kinds": [],
        "other_categories": [],
    }
    INVALID_REFERENCE_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/invalid-model-reference/",
        "title": "Invalid model reference",
        "status": 422,
        "detail": "Waterfall reference '~' has no name after '~' prefix",
        "instance": "/v1/models/check",
        "error_type": "InvalidModelReference",
        "error_domain": "input",
        "retryable": False,
    }
    INVALID_CATEGORY_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/invalid-model-category/",
        "title": "Invalid model category",
        "status": 422,
        "detail": "Invalid model category. Valid values: doc_gen, extract, img_gen, judgment, llm, search",
        "instance": "/v1/models/check",
        "error_type": "InvalidModelCategory",
        "error_domain": "input",
        "retryable": False,
    }
    REPEATED_PARAMETER_REFUSAL: ClassVar[dict[str, Any]] = {
        "type": "https://docs.pipelex.com/latest/errors/validation-error/",
        "title": "Validation error",
        "status": 422,
        "detail": "The `reference` query parameter accepts a single value",
        "instance": "/v1/models/check",
        "error_type": "ValidationError",
        "error_domain": "input",
        "retryable": False,
    }


class MalformedInputFormData:
    """What the malformed input-form cases send beside the shared case file's answer."""

    FILES: ClassVar[dict[str, FileEntry]] = {"smoke.mthds": 'domain = "smoke"'}
    # The verdict the client gives a 2xx it cannot read, and `@pipelex/sdk` its `InputPreparationError`.
    UNREADABLE_VERDICT: ClassVar[ErrorVerdict] = ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)


class IdempotencyKeyData:
    """A run start's idempotency key, and what the hosted API answers about one.

    The two refusals are the platform's problem documents for a key: one an earlier start under the same
    key and body still holds (`idempotency_key_in_use`, sent with `Retry-After`), and one used before with
    another body (the generic `conflict`). `@pipelex/sdk`'s `tests/start-idempotency-key.test.ts` answers
    its client with the same documents.
    """

    KEY: ClassVar[str] = "5f0c6a52-2d3e-4c8b-9a51-7e1f0b6c2d44"
    ACK: ClassVar[dict[str, Any]] = {"pipeline_run_id": "run-1", "state": "STARTED", "created_at": "t0"}
    KEY_IN_USE: ClassVar[dict[str, Any]] = {
        "type": "https://pipelex.com/errors/idempotency_key_in_use",
        "title": "Idempotency key in use",
        "status": 409,
        "code": "idempotency_key_in_use",
        "detail": "An earlier request with idempotency key 'k' and the same body is still being processed.",
        "error_domain": "runtime",
        "retryable": True,
    }
    KEY_USED_WITH_ANOTHER_BODY: ClassVar[dict[str, Any]] = {
        "type": "https://pipelex.com/errors/conflict",
        "title": "Conflict",
        "status": 409,
        "code": "conflict",
        "detail": "The idempotency key 'k' was already used with a different request body.",
        "error_domain": "input",
        "retryable": False,
    }
    # Keys a start refuses before sending anything, each with the words that say what is wrong with it.
    MALFORMED_KEYS: ClassVar[list[tuple[str, object, str]]] = [
        ("empty", "", "this one is empty"),
        ("a space", "run 42", "this one holds a character outside visible ASCII"),
        ("a line break", "k\r\nX-Injected: 1", "this one holds a character outside visible ASCII"),
        ("a character outside ASCII", "clé-42", "this one holds a character outside visible ASCII"),
        ("too long", "k" * 256, "this one is 256 characters long"),
        ("not a string", 42, "this one is not a string"),
    ]
    # Keys a start sends as they are: the longest, every visible ASCII character, and the shortest.
    VALID_KEYS: ClassVar[list[str]] = ["k" * 255, "!\"#$%&'()*+,-./0123456789:;<=>?@AZ[\\]^_`az{|}~", "k"]


class RunProgressBodies:
    """Progress snapshots as the hosted API's `GET /v1/runs/{id}/progress` answers them.

    `WORKED_EXAMPLE` is the contract's own worked example, copied member for member from the section
    "Run progress" of the platform API spec (`conformance/specs/pipelex-platform-api.md`): a run of
    `filings.review_filings` over three filings, taken mid-run, with item 2's second step retried and item 3
    stuck. `@pipelex/sdk`'s `tests/run-progress.test.ts` reads part of the same example.
    """

    STUCK_MESSAGE: ClassVar[str] = "One of this run's batch branches, …, has failed 4 times in a row, so the run is not making progress. …"
    STUCK: ClassVar[dict[str, Any]] = {
        "reason": "workflow_task_failing",
        "message": STUCK_MESSAGE,
        "failed_attempts": 4,
        "failing_since": "2026-10-12T09:30:33.480Z",
        "ends_at": "2026-10-12T09:45:33.480Z",
    }
    WORKED_EXAMPLE: ClassVar[dict[str, Any]] = {
        "pipeline_run_id": "run_7Qd2kV",
        "mode": "live",
        "status": "running",
        "version": 26,
        "assembled_at": "2026-10-12T09:31:20.512Z",
        "summary": (
            "Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running; "
            "not progressing at summarize_filing (step 3 of 4, item 3 of 3) after 4 failed attempts"
        ),
        "degradation": STUCK,
        "invocations": [
            {
                "path": "filings.review_filings",
                "pipe_code": "review_filings",
                "pipe_ref": "filings.review_filings",
                "pipe_type": "PipeSequence",
                "status": "running",
                "started_at": "2026-10-12T09:30:00.104Z",
                "ended_at": None,
                "step_count": 4,
            },
            {
                "path": "filings.review_filings/step_1",
                "pipe_code": "extract_filings",
                "pipe_ref": "filings.extract_filings",
                "pipe_type": "PipeExtract",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:00.131Z",
                "ended_at": "2026-10-12T09:30:06.870Z",
            },
            {
                "path": "filings.review_filings/step_2",
                "pipe_code": "choose_depth",
                "pipe_ref": "filings.choose_depth",
                "pipe_type": "PipeCondition",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:06.902Z",
                "ended_at": "2026-10-12T09:30:19.415Z",
                "condition": {"selected_outcome": "detailed"},
            },
            {
                "path": "filings.review_filings/step_2/outcome_detailed",
                "pipe_code": "deep_checks",
                "pipe_ref": "filings.deep_checks",
                "pipe_type": "PipeParallel",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:07.020Z",
                "ended_at": "2026-10-12T09:30:19.401Z",
                "branch_count": 2,
            },
            {
                "path": "filings.review_filings/step_2/outcome_detailed/branch_1",
                "pipe_code": "check_figures",
                "pipe_ref": "filings.check_figures",
                "pipe_type": "PipeLLM",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:07.034Z",
                "ended_at": "2026-10-12T09:30:15.660Z",
            },
            {
                "path": "filings.review_filings/step_2/outcome_detailed/branch_2",
                "pipe_code": "check_wording",
                "pipe_ref": "filings.check_wording",
                "pipe_type": "PipeLLM",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:07.036Z",
                "ended_at": "2026-10-12T09:30:19.388Z",
            },
            {
                "path": "filings.review_filings/step_3",
                "pipe_code": "summarize_filing_batch",
                "pipe_ref": "filings.summarize_filing_batch",
                "pipe_type": "PipeBatch",
                "status": "running",
                "started_at": "2026-10-12T09:30:19.440Z",
                "ended_at": None,
                "batch": {"total": 3, "done": 1, "running": 2, "failed": 0},
            },
            {
                "path": "filings.review_filings/step_3/item_1",
                "pipe_code": "summarize_filing",
                "pipe_ref": "filings.summarize_filing",
                "pipe_type": "PipeSequence",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:19.611Z",
                "ended_at": "2026-10-12T09:30:41.022Z",
                "step_count": 2,
            },
            {
                "path": "filings.review_filings/step_3/item_1/step_1",
                "pipe_code": "read_filing",
                "pipe_ref": "filings.read_filing",
                "pipe_type": "PipeLLM",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:19.630Z",
                "ended_at": "2026-10-12T09:30:30.118Z",
            },
            {
                "path": "filings.review_filings/step_3/item_1/step_2",
                "pipe_code": "condense_filing",
                "pipe_ref": "filings.condense_filing",
                "pipe_type": "PipeLLM",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:30.140Z",
                "ended_at": "2026-10-12T09:30:41.010Z",
            },
            {
                "path": "filings.review_filings/step_3/item_2",
                "pipe_code": "summarize_filing",
                "pipe_ref": "filings.summarize_filing",
                "pipe_type": "PipeSequence",
                "status": "running",
                "started_at": "2026-10-12T09:30:19.640Z",
                "ended_at": None,
                "step_count": 2,
            },
            {
                "path": "filings.review_filings/step_3/item_2/step_1",
                "pipe_code": "read_filing",
                "pipe_ref": "filings.read_filing",
                "pipe_type": "PipeLLM",
                "status": "succeeded",
                "started_at": "2026-10-12T09:30:19.655Z",
                "ended_at": "2026-10-12T09:30:31.902Z",
            },
            {
                "path": "filings.review_filings/step_3/item_2/step_2",
                "pipe_code": "condense_filing",
                "pipe_ref": "filings.condense_filing",
                "pipe_type": "PipeLLM",
                "status": "running",
                "started_at": "2026-10-12T09:30:31.930Z",
                "ended_at": None,
                "attempts": 2,
                "last_failure": {"message": "An internal error occurred.", "at": "2026-10-12T09:30:52.317Z"},
            },
            {
                "path": "filings.review_filings/step_3/item_3",
                "pipe_code": "summarize_filing",
                "pipe_ref": "filings.summarize_filing",
                "pipe_type": "PipeSequence",
                "status": "running",
                "started_at": "2026-10-12T09:30:19.702Z",
                "ended_at": None,
                "step_count": 2,
                "degradation": STUCK,
            },
            {
                "path": "filings.review_filings/step_3/item_3/step_1",
                "pipe_code": "read_filing",
                "pipe_ref": "filings.read_filing",
                "pipe_type": "PipeLLM",
                "status": "running",
                "started_at": "2026-10-12T09:30:19.720Z",
                "ended_at": None,
            },
        ],
    }
    # What a pending run answers: no invocation, and the summary the contract words for it.
    PENDING: ClassVar[dict[str, Any]] = {
        "pipeline_run_id": "run-1",
        "mode": "live",
        "status": "pending",
        "version": 0,
        "assembled_at": "2026-10-12T09:29:58.004Z",
        "summary": "Waiting to start",
        "invocations": [],
    }


class BrandingBodies:
    """An organization's branding and the branding write's refusals, as the platform serializes them.

    `BRANDED` and `UNBRANDED` are its `BrandingResponse`, which both branding routes answer; the refusals
    are its problem documents, the logo ones carrying one `errors[]` entry per broken rule.
    """

    ORG_ID: ClassVar[str] = "0f6c2a4e-org"
    #: What a write sends to set a new logo: a standalone upload of the organization.
    SQUARE_UPLOAD_URI: ClassVar[str] = f"pipelex-storage://{ORG_ID}/assets/7d1e.png"
    WIDE_UPLOAD_URI: ClassVar[str] = f"pipelex-storage://{ORG_ID}/assets/9a3c.svg"

    #: What the answer names: the platform's own copy of an accepted logo, under `branding/`.
    SQUARE_LOGO_URI: ClassVar[str] = f"pipelex-storage://{ORG_ID}/branding/3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b.png"
    WIDE_LOGO_URI: ClassVar[str] = f"pipelex-storage://{ORG_ID}/branding/8c7b6a5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d.svg"

    #: A branding copy that no slot of the organization holds, which a write may not attach.
    STRAY_BRANDING_URI: ClassVar[str] = f"pipelex-storage://{ORG_ID}/branding/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg"

    SQUARE_LOGO: ClassVar[dict[str, Any]] = {
        "uri": SQUARE_LOGO_URI,
        "sha256": "9b2f6d0c1e4a7b3c5d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e",
        "content_type": "image/png",
        "width": 512.0,
        "height": 512.0,
    }

    #: An SVG's size is its viewBox's, which may be fractional.
    WIDE_SVG_LOGO: ClassVar[dict[str, Any]] = {
        "uri": WIDE_LOGO_URI,
        "sha256": "0d1c2b3a49586776a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e",
        "content_type": "image/svg+xml",
        "width": 240.5,
        "height": 64.25,
    }

    #: A branded team: one logo, a partial light set, a partial dark set.
    BRANDED: ClassVar[dict[str, Any]] = {
        "org_id": ORG_ID,
        "org_name": "Acme Corp",
        "colors": {"action": "#14213d", "accent": "#fca311", "header": None},
        "dark_colors": {"action": None, "accent": None, "header": "#e5e5e5"},
        "square_logo": SQUARE_LOGO,
        "wide_logo": None,
    }

    #: A personal workspace, or a team that set nothing: every colour and logo `None`.
    UNBRANDED: ClassVar[dict[str, Any]] = {
        "org_id": ORG_ID,
        "org_name": "Ada's workspace",
        "colors": {"action": None, "accent": None, "header": None},
        "dark_colors": {"action": None, "accent": None, "header": None},
        "square_logo": None,
        "wide_logo": None,
    }

    SQUARE_TOO_SMALL: ClassVar[str] = "The square logo is 100 × 100 px; a square logo must be at least 128 px on each side."
    WIDE_TOO_SHORT: ClassVar[str] = "The wide logo is 240 × 48 px; a wide logo must be at least 64 px tall."

    #: Both slots refused at once: one entry per broken rule, the problem's `detail` their sentences joined.
    LOGOS_REFUSED: ClassVar[dict[str, Any]] = {
        "type": "https://pipelex.com/errors/validation_failed",
        "title": "Validation failed",
        "status": 422,
        "code": "validation_failed",
        "detail": f"{SQUARE_TOO_SMALL} {WIDE_TOO_SHORT}",
        "instance": "urn:pipelex:request:a9a249b93c024bf08ac9a5fd0704ea92",
        "request_id": "a9a249b93c024bf08ac9a5fd0704ea92",
        "errors": [
            {"field": "square_logo", "code": "logo_too_small", "detail": SQUARE_TOO_SMALL},
            {"field": "wide_logo", "code": "logo_too_short", "detail": WIDE_TOO_SHORT},
        ],
    }

    #: The platform's own sentences, from `services/logo_inspection.py`.
    ACTIVE_CONTENT: ClassVar[str] = "The wide logo is an SVG that carries active content, which a logo may not: a <script> element."
    NOT_AN_UPLOAD: ClassVar[str] = (
        "The wide logo must be a newly uploaded file (pipelex-storage://<organization>/assets/<file>) or the URI the wide logo already has."
    )
    PIXEL_CAP: ClassVar[str] = (
        "The square logo looks like a PNG image but cannot be read: "
        "at 5,000 × 5,000 px it has more than the 16,777,216 pixels (4096 × 4096) a logo may have."
    )
    CUT_SHORT: ClassVar[str] = "The square logo looks like a JPEG image but cannot be read: the file is damaged or incomplete."

    #: A colour that is not `#rrggbb`, refused by the body's validation and named by its dotted key.
    COLOR_REFUSED: ClassVar[dict[str, Any]] = {
        "type": "https://pipelex.com/errors/validation_failed",
        "title": "Validation failed",
        "status": 422,
        "code": "validation_failed",
        "detail": "Request body failed validation. See `errors` for the per-field breakdown.",
        "errors": [
            {"field": "dark_colors.header", "code": "string_pattern_mismatch", "detail": "String should match pattern '^#[0-9a-fA-F]{6}$'"},
        ],
    }
