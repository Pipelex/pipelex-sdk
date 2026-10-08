/** The command's help texts, printed on stdout by `--help`. */

export const MAIN_HELP = `pipelex-sdk: run an MTHDS method on the Pipelex API, with nothing to install.

Usage:
  pipelex-sdk run --method <method> [--pipe <domain.pipe_code>] [--inputs <file> | --inputs-template]
  pipelex-sdk script --method <address | catalog id> [--pipe <domain.pipe_code>] [--name <name>] [--dir <dir>]
  pipelex-sdk --version
  pipelex-sdk <command> --help

Commands:
  run      Run a method and print its main output as JSON on stdout.
  script   Write a shell script that runs one method with this SDK's version pinned.

A method is a published address, github.com/<owner>/<repo>[/<package>][@<tag>], a catalog
id, mt_..., or, for run only, a .mthds file or a bundle directory. A bare catalog id runs the
method's latest published version, mt_...@<version> a fixed version, and mt_...@draft its draft.

The API key is read from PIPELEX_API_KEY, and the API's address from PIPELEX_BASE_URL
(https://api.pipelex.com when unset). No .env file is read.

Exit codes: 0 done, 1 the run failed or the API refused it, 2 a usage error, 130 interrupted.
`;

export const RUN_HELP = `Usage: pipelex-sdk run --method <method> [--pipe <domain.pipe_code>] [--inputs <file> | --inputs-template]

Run a method on the Pipelex API, wait for it however long it takes, and print its main
output as indented JSON on stdout. The run id, each uploaded file and every error go to
stderr. Ctrl-C stops waiting; the run keeps going on the server.

Options:
  --method <method>          A published address (github.com/<owner>/<repo>[/<package>][@<tag>]),
                             a catalog id (mt_..., mt_...@<version> or mt_...@draft), or a path
                             to a .mthds file or a bundle directory.
  --pipe <domain.pipe_code>  The pipe to run, by its qualified ref. Default: the method's main pipe.
  --inputs <file>            The inputs, a JSON object with one entry per input; - reads stdin.
                             A local path or a data: URL at a file input is uploaded first.
  --inputs-template          Print the inputs template, the object --inputs takes, and run nothing.
  -h, --help                 Show this help.

Needs PIPELEX_API_KEY in the environment.
`;

export const SCRIPT_HELP = `Usage: pipelex-sdk script --method <address | catalog id> [--pipe <domain.pipe_code>] [--name <name>] [--dir <dir>]

Check a method with the API, then write an executable shell script that runs it through
this SDK, its version pinned. The script passes its own arguments on to run:
./<name> --inputs inputs.json, or ./<name> --inputs-template. It never overwrites a file.

Options:
  --method <method>          A published address (github.com/<owner>/<repo>[/<package>][@<tag>])
                             or a catalog id (mt_..., mt_...@<version> or mt_...@draft). A local
                             bundle is refused.
  --pipe <domain.pipe_code>  The pipe the script runs. Default: the method's main pipe.
  --name <name>              The script's file name. Default: the address's last segment, or the
                             catalog method's name in kebab-case.
  --dir <dir>                Where to write it. Default: the current directory.
  -h, --help                 Show this help.

Needs PIPELEX_API_KEY in the environment. The script needs a POSIX shell.
`;
