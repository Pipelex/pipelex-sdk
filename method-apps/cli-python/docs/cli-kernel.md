# The CLI kernel: options derived from the method's input form

The command takes one option per input the method declares, and no line of its code names an input. When the command loads, [`lib/inputs.py`](../src/pipelex_method_cli_python/lib/inputs.py) reads the bound pipe's input-form descriptor and IO contract out of the committed `generated/contracts.json` (see [`codegen.md`](codegen.md)) and builds the options from them, in the order the method declares its inputs; [`cli.py`](../src/pipelex_method_cli_python/cli.py) puts them before its own options in the command's assembled signature. Changing the method and running `make codegen` changes the options, and there is nothing else to edit.

This is why nothing is written per method: a generated module of options would be one more file to keep in step with the method, and one more place for a hand edit to drift from it. The descriptor already says everything an option needs (the kind of each input, whether the run needs it, its bounds, its choices and its help), so the command reads it at run time, the same way the web app template renders its form from it.

## How each kind is taken

| Field kind | Option | What it takes |
| --- | --- | --- |
| `text`, `prose` | `--name TEXT` | A string. `@path` reads it from a UTF-8 file, a leading `~` in the path naming the home directory, `@-` from stdin, and a leading `@@` stands for a literal `@` |
| `date` | `--name DATE`, or `--name DATETIME` when the descriptor says `datetime` | An ISO 8601 calendar date, or a date and time. A calendar date given with a time of day is refused unless the time is midnight, rather than silently cut |
| `number` | `--name N`, or `--name INTEGER` | A finite number, or an integer when the descriptor says so, inside the descriptor's bounds, written in ASCII digits with an optional sign, decimal point and exponent, which is what the form kernel's `Number()` reads: `1_000`, `1_0.5` and digits of other scripts are refused |
| `boolean` | `--name / --no-name` | One of the pair; without either, the input is not given |
| `enum` | `--name [a\|b\|c]` | One of the descriptor's choices, which Click checks |
| `document`, `image` | `--name PATH\|URL` | A local file or a `data:` URL, which the SDK uploads before the run, or an `https://` or `pipelex-storage://` URL, which passes through |
| `list` of any kind above | the same option, repeated | One value per item. A list of booleans, whose flag could not repeat, takes `true` or `false` per item. A fixed `item_count`, or the schema's `minItems` and `maxItems`, is enforced |
| `object`, `unknown`, and a list of objects or of lists | `--name JSON` | JSON, inline or `@file.json`, a file read as `@path` reads one for a text input. An object must be a JSON object and a list a JSON array of the right length; what is inside is left to the API, which validates the run's inputs against the contract before any inference runs |

An input's option is `--<name>` with its underscores written as dashes. An input whose option would take one of the command's own flags, or a flag an earlier input took, is offered as `--input-<name>` instead; one for which both are taken is refused when the command loads, saying to rename the input. The Python parameter behind every input's option is `input_<name>`, a namespace the command's own options never use.

**The help is the descriptor's.** Each option's help is the input's description, then how to give it, then `Required.`, `Optional.` or `An empty list when not given.`, then the descriptor's examples.

## Which inputs a run needs

The descriptor's `gating` says whether the run cannot start without an input. Once the options and `--inputs FILE` are merged, an input that gates the run and holds nothing, given nowhere or given only blank, is refused as a usage error, exit code 2, naming each missing input with its option, before any request is sent. A value is judged by what it carries, whether an option or the file gave it: an envelope, an object whose keys are exactly `concept` and `content`, which is how the SDK's `prepare_inputs` and the runtime recognise one, by its content, so `{"concept": "native.Text", "content": {"text": " "}}` in the file is as blank as `--text " "`, and anything else by itself, including a bare structured value whose own fields include `concept` and `content` beside others, such as `{"concept": "proposal", "content": null, "title": "Ready"}`. An optional input given nowhere is left out, so the runtime records a real absence. A plural input given nowhere is sent as the empty list.

**`--inputs FILE` and the options combine.** The file is a JSON object of inputs in the shape `mthds run --inputs` takes, and its values pass as they are; an input given by its option replaces the file's value for it. `--inputs-template` prints the method's inputs template, the JSON object `--inputs` takes with a placeholder for every input, and runs nothing; it must be given alone. A resumed run takes no input option, since it already has its inputs.

**A local file is uploaded by the SDK.** When the method declares a file input anywhere in its form, the run's inputs go through the SDK's `prepare_inputs` before the run starts, which uploads every local path and `data:` URL at a file position, from an option or from the inputs file, and rewrites it to the `pipelex-storage://` reference the run reads. The command prints each upload on stderr. A method with no file input skips that request.

## What goes on the wire

The value each option puts on the wire is the value the web app template's form kernel, `@pipelex/mthds-form`, sends for the same field and value, so a method receives the same inputs whichever template runs it. [`lib/wire.py`](../src/pipelex_method_cli_python/lib/wire.py) holds a port of the kernel's payload rules, function by function and named after the originals:

| Given | Sent |
| --- | --- |
| `--headline "Hello"`, a `text` or `prose` input | `{"concept": "<concept>", "content": {"text": "Hello"}}`: the value inside the one property its content model declares, which is `time` for a `native.Time`, `number` for a number and `yes_no` for a boolean |
| `--day 2026-07-06`, a `date` input whose content is a string | `{"concept": "<concept>", "content": "2026-07-06"}` |
| `--level high`, an `enum` input | `{"concept": "<concept>", "content": "high"}` |
| `--picture cat.png`, an `image` input | `{"concept": "native.Image", "content": {"url": "pipelex-storage://…", "filename": "cat.png"}}`, once uploaded |
| `--many a --many b`, a list | `{"concept": "<concept>", "content": [{"text": "a"}, {"text": "b"}]}`, each item as its kind is sent |
| a plural input given nowhere | `[]`, without the envelope, the form the runtime builds an empty list of the declared concept from |
| an optional input given nowhere | nothing: the input is left out |
| `--priority '{"level": "urgent"}'`, an `object` input | `{"concept": "<concept>", "content": {"level": "urgent"}}`, repaired as below |

Before it is enveloped, every value an option gave is repaired against the inputs' combined schema as the kernel's gate repairs a form: a lone `{"text": …}` where the schema wants a string is unwrapped, a midnight timestamp where it wants a calendar date is cut to its day, and an optional property left empty is dropped. The kernel's JSON Schema validation is not ported: the API validates the same contract before any inference runs, and the person running the command holds the key it spends, so a second gate would guard no trust boundary.

## Held to the kernel by a recorded table

`tests/fixtures/wire/table.json` records what the TypeScript kernel sends for every pipe of a set of contracts, given every input, the required ones only, or none, with the option values the command is given for the same values. `tests/test_wire_table.py` runs the command on those option values over a fake client and holds it to each verdict: where the kernel sends inputs, the run the command starts carries exactly the same inputs, uploads included; where the kernel refuses, the command refuses as a usage error and names every input the kernel names as missing.

<!-- template-only:begin -->

The table is recorded by the method-app family's `scripts/record-wire-table.mjs`, from the kernel the web app template installs, over the web app template's contract fixtures and `scripts/wire-table/every-kind.json`, a contract assembled to reach every field kind those fixtures do not. Its test in the family's suite fails when the committed table is not what the installed kernel sends, byte for byte, so a kernel upgrade that changes a payload is caught there: rerun `node scripts/record-wire-table.mjs` in `method-apps/`, commit the result, and make this command agree with it.

<!-- template-only:end -->

## Where the command and the kernel disagree, on purpose

- **An `unknown` input, such as a `native.JSON` one.** The kernel sends the raw string its text area holds, which its own schema check then refuses as "must be object" and reports as missing, so the web app cannot run such a pipe. The command parses the JSON its option is given and sends the object, which is what the input's schema asks for. The replay lists these cases and holds the command to what it sends instead.
- **An empty list of a fixed count.** The kernel's missing scan passes over it, and only its schema errors report it; the command names it as missing. Both refuse the run, and the replay allows the command to name an input the kernel's errors name.

## What is deliberately not built

- **No validation of nested structures beyond their JSON type and item count.** An object's fields and a list of objects' items are the API's to validate, with the contract, before any inference runs.
- **No option per nested field.** A structure is given as JSON, since flags cannot say where one item of a list of objects ends and the next begins.
- **No prompt for a missing input.** The command is for scripts and agents as much as for people, so a missing input is a usage error that names its option, never a question.
