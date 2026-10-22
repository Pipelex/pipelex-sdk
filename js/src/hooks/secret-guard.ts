/**
 * The hook's secret guard: before the validate stage sends a method's tree, it finds each file
 * whose NAME is a known secret file, or whose TEXT holds a well-known key format, in whatever
 * encoding the file is written, so that file never leaves the machine.
 *
 * The rule is the workshop's, pipelex-mcp's `src/capabilities/secret-guard.ts`, with two
 * refinements this copy is ahead on until the workshop takes them up (L-261022-b4770f): an SSH key
 * is found by its default name only when the name is exactly that, and a PEM private key block
 * only when a key's body follows its header. Every other rule is the workshop's, and changes with
 * it. The membership rule already keeps the commonest secret files out by construction,
 * since `.env`, `.ssh/`, `.aws/` and every other dotfile start with a dot. What it cannot keep
 * out is a key file under an ordinary name, or a key pasted into an ordinary file, a Python
 * module being the usual home of one, which is why the guard reads text and not names alone.
 * It is a tripwire for the well-known shapes, never a promise that a tree holds no secret: a
 * password in prose, a scanned contract or a payslip goes through it.
 *
 * A finding names the file and what matched, and **never the matched text**, since the hook's
 * output is shown to a model and may be logged.
 *
 * Pure: it reads the bytes it is handed and nothing else.
 */

/** One file the guard finds, and why, in words that quote nothing of the file. */
export interface SecretFinding {
  /** The file's tree path. */
  path: string;
  /** What it is, or what it holds: "it holds a private key block (PEM)". */
  reason: string;
}

/** Whether the bytes open with a zip archive's local file header, `PK\x03\x04`. */
function isZipArchive(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Secret file names, matched on the last segment of a tree path, ignoring case: key and
 * certificate stores, SSH private keys under their default names, and the credential exports of
 * the cloud consoles. A rule with `unless` lets a file of that name go when its bytes show it is
 * something else.
 *
 * `.pem` is no name rule: a `.pem` file is as often a certificate, which is public, and a private
 * key in one is a PEM block, which the text search finds. A `.key` file is a Keynote deck as
 * often as a key, and a deck is a zip archive, so only a `.key` file that is no zip is found by
 * name, which still catches a DER key, binary and holding no PEM block.
 *
 * An SSH key's default name is matched whole, with the `_sk` of a hardware-backed key, so its
 * `.pub` half, which is public, and a file merely starting with the name, such as
 * `id_rsa_utils.py`, go. Nothing is lost: every SSH private key is PEM-armoured, which the text
 * search finds under any name.
 */
const SECRET_NAMES: readonly {
  pattern: RegExp;
  reason: string;
  unless?: (bytes: Uint8Array) => boolean;
}[] = [
  {
    pattern: /\.key$/i,
    reason: "a key file (.key), and is no zip archive as a Keynote deck is",
    unless: isZipArchive,
  },
  { pattern: /\.(p12|pfx|jks|keystore)$/i, reason: "a certificate or key store" },
  { pattern: /\.ppk$/i, reason: "a PuTTY private key" },
  { pattern: /\.kdbx$/i, reason: "a KeePass password database" },
  {
    pattern: /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
    reason: "an SSH key under its default name",
  },
  { pattern: /^credentials(\.json)?$/i, reason: "a credentials file" },
  { pattern: /^client_secret.*\.json$/i, reason: "an OAuth client secret export" },
];

/**
 * Well-known key formats, matched in a file's text. Each is a prefix a provider puts on its keys
 * so that scanners can find them, with enough of the key's body after it that prose mentioning
 * the prefix does not match.
 *
 * A PEM private key block is its header followed, within a short span, by a run of Base64 as
 * long as a key's body lines: the span holds the line break, written as a real one or as the `\n`
 * of a key escaped into JSON, and the `Proc-Type` and `DEK-Info` headers of an encrypted legacy
 * key. A header named in prose, such as a prompt telling a model what a key looks like, has no
 * such run after it, so it goes.
 */
const KEY_FORMATS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,200}?[A-Za-z0-9+/]{40,}/,
    reason: "a private key block (PEM)",
  },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, reason: "an AWS access key id" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, reason: "a GitHub token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/, reason: "a GitHub fine-grained token" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, reason: "a GitLab token" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, reason: "a Slack token" },
  { pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, reason: "a Stripe live key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/, reason: "a Google API key" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, reason: "an Anthropic API key" },
  {
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
    reason: "an OpenAI API key",
  },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, reason: "an OpenAI-style secret key" },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/, reason: "a Hugging Face token" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, reason: "an npm token" },
  { pattern: /\bplx_sk_[A-Za-z0-9_-]{16,}/, reason: "a Pipelex API key" },
];

/**
 * Bytes read one character per byte. The WHATWG `latin1` decoder is windows-1252, which maps
 * every byte to exactly one character and every ASCII byte to itself, and every key format is
 * ASCII matched with ASCII word boundaries, so it finds what Node's Latin-1 decoding, the
 * workshop's, finds, without reaching for `Buffer`.
 */
const ONE_CHARACTER_PER_BYTE = new TextDecoder("latin1");

/**
 * The texts a file's bytes are searched in. Every key format is ASCII, so the bytes are read one
 * character per byte, which keeps every ASCII run of them whatever the file's encoding: UTF-8,
 * Latin-1, cp1252, or a binary file with a key inside it. A file holding NUL bytes is searched
 * once more with them removed, which is how an ASCII key reads in UTF-16, with or without its
 * byte order mark, and in UTF-32.
 */
function searchableTexts(bytes: Uint8Array): string[] {
  const text = ONE_CHARACTER_PER_BYTE.decode(bytes);
  return text.includes("\0") ? [text, text.replaceAll("\0", "")] : [text];
}

/**
 * The files of a tree the guard finds, in the order given. A file whose name is a secret file's
 * is found on the name alone, unless its rule's `unless` says its bytes are something else; every
 * other file, text in any encoding or binary, is searched for every key format in the texts
 * {@link searchableTexts} reads from its bytes.
 */
export function secretFindings(
  files: Iterable<{ path: string; bytes: Uint8Array }>,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const byName = SECRET_NAMES.find(
      (rule) => rule.pattern.test(name) && rule.unless?.(file.bytes) !== true,
    );
    if (byName !== undefined) {
      findings.push({ path: file.path, reason: `it is named like ${byName.reason}` });
      continue;
    }
    const texts = searchableTexts(file.bytes);
    const held = KEY_FORMATS.filter((format) =>
      texts.some((text) => format.pattern.test(text)),
    ).map((format) => format.reason);
    if (held.length > 0) {
      findings.push({ path: file.path, reason: `it holds ${[...new Set(held)].join(" and ")}` });
    }
  }
  return findings;
}
