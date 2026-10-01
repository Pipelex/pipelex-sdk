/**
 * The packed form of a template: the tree `git ls-files <template>` lists, as
 * one gzip-compressed file the package carries.
 *
 * npm cannot ship a template as a list of files. `npm pack` never includes
 * `package-lock.json`, and it reads each directory's `.gitignore` as exclusion
 * rules, so a package listing the template's files would publish something
 * other than the template. One file sidesteps both, and reading it back needs
 * nothing but Node's own `zlib`.
 *
 * The file is gzip over one line of JSON, then the contents of every file one
 * after the other. The line is the header:
 *
 *   {"format":1,"template":"webapp-js","version":"0.4.0","source":"<sha>",
 *    "files":[{"path":"package.json","mode":"100644","size":2345}, …]}
 *
 * `version` is the family's, and `source` the commit the tree was packed from,
 * both named by the pristine commit. `mode` is git's: a plain or an executable
 * file, and nothing else. A path is relative to the template's directory.
 */

import zlib from "node:zlib";

export const FORMAT = 1;

/** The modes a packed file may carry, and what each becomes on disk. */
export const MODES = { 100644: 0o644, 100755: 0o755 };

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackError";
  }
}

/**
 * Whether a path is safe to write under a destination: relative, forward
 * slashes, no empty, `.` or `..` segment, and nothing inside a `.git`.
 */
export function safePath(rel) {
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\\")) {
    return false;
  }
  return rel
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

/** Pack a tree: `files` is `[{ path, mode, data }]`, `data` a Buffer. */
export function encodePack({ template, version, source, files }) {
  const header = {
    format: FORMAT,
    template,
    version,
    source,
    files: files.map(({ path, mode, data }) => {
      if (!safePath(path))
        throw new PackError(`${JSON.stringify(path)} is not a path a pack can hold`);
      if (!(mode in MODES))
        throw new PackError(`${path} has mode ${mode}, which a pack cannot hold`);
      return { path, mode, size: data.length };
    }),
  };
  const body = Buffer.concat([
    Buffer.from(`${JSON.stringify(header)}\n`, "utf8"),
    ...files.map(({ data }) => data),
  ]);
  return zlib.gzipSync(body, { level: 9 });
}

/** Read a pack back, refusing anything that is not exactly what `encodePack` writes. */
export function decodePack(buffer) {
  let body;
  try {
    body = zlib.gunzipSync(buffer);
  } catch (error) {
    throw new PackError(`the pack is not gzip data: ${error.message}`);
  }
  const newline = body.indexOf(0x0a);
  if (newline < 0) throw new PackError("the pack has no header line");
  let header;
  try {
    header = JSON.parse(body.subarray(0, newline).toString("utf8"));
  } catch (error) {
    throw new PackError(`the pack's header is not JSON: ${error.message}`);
  }
  if (header.format !== FORMAT) {
    throw new PackError(
      `the pack is in format ${header.format}, and this initializer reads ${FORMAT}`,
    );
  }
  const files = [];
  const seen = new Set();
  let at = newline + 1;
  for (const { path, mode, size } of header.files) {
    if (!safePath(path))
      throw new PackError(`the pack holds ${JSON.stringify(path)}, which is not a safe path`);
    if (seen.has(path)) throw new PackError(`the pack holds ${path} twice`);
    if (!(mode in MODES)) throw new PackError(`the pack gives ${path} mode ${mode}`);
    if (!Number.isInteger(size) || size < 0 || at + size > body.length) {
      throw new PackError(`the pack's size for ${path} runs past its end`);
    }
    seen.add(path);
    files.push({ path, mode, data: body.subarray(at, at + size) });
    at += size;
  }
  if (at !== body.length)
    throw new PackError("the pack carries bytes its header does not account for");
  return { template: header.template, version: header.version, source: header.source, files };
}
