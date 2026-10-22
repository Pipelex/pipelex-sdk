/**
 * Key-shaped strings for the secret guard's suites, assembled at run time so that no literal in
 * the repository looks like a key to a scanner reading it, a push protection among them. None is a
 * real key: each is a provider's prefix followed by one repeated character. Beside them, the tree
 * of the reported case, written where a suite says.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A PEM block of the given label, such as `RSA PRIVATE KEY` or `CERTIFICATE`, its body two lines
 * of one repeated Base64 character as long as a real key's lines, and with `encrypted` the
 * `Proc-Type` and `DEK-Info` headers of an encrypted legacy key before it.
 */
export function pemBlock(label: string, options: { encrypted?: boolean } = {}): string {
  const headers = options.encrypted
    ? [["Proc-Type: 4", "ENCRYPTED"].join(","), `DEK-Info: AES-128-CBC,${"0".repeat(32)}`, ""]
    : [];
  const body = ["M".repeat(64), "Q".repeat(40)];
  return [["-----BEGIN ", label, "-----"].join(""), ...headers, ...body, `-----END ${label}-----`]
    .join("\n")
    .concat("\n");
}

export const fake = {
  pem: pemBlock(["RSA", "PRIVATE KEY"].join(" ")),
  openssh: pemBlock(["OPENSSH", "PRIVATE KEY"].join(" ")),
  aws: ["AKIA", "Z".repeat(16)].join(""),
  github: ["ghp_", "a".repeat(36)].join(""),
  slack: ["xoxb-", "1234567890-abcdef"].join(""),
  stripe: ["sk_live_", "x".repeat(24)].join(""),
  google: ["AIza", "B".repeat(35)].join(""),
  anthropic: ["sk-ant-", "api03-", "c".repeat(40)].join(""),
  openai: ["sk-proj-", "d".repeat(40)].join(""),
  huggingface: ["hf_", "e".repeat(34)].join(""),
  pipelex: ["plx_sk_", "f".repeat(32)].join(""),
};

/**
 * A Google service-account key file as the cloud console exports it, its private key a PEM block
 * escaped into a JSON string, as the export writes it.
 */
export function serviceAccountJson(): string {
  return JSON.stringify(
    {
      type: ["service", "account"].join("_"),
      project_id: "example-project",
      private_key_id: "0".repeat(40),
      private_key: pemBlock(["PRIVATE", "KEY"].join(" ")),
      client_email: "hook-test@example-project.iam.gserviceaccount.com",
    },
    null,
    2,
  );
}

/** A bundle whose `PipeDocGen` step fills `notice.html`, a file of its tree. */
export const NOTICE_BUNDLE = [
  'domain = "notices"',
  'main_pipe = "print_notice"',
  "",
  "[pipe.print_notice]",
  'type = "PipeDocGen"',
  'description = "Print the notice"',
  'inputs = { notice = "Text" }',
  'output = "Document"',
  'template_file = "notice.html"',
  "",
].join("\n");

export const NOTICE_TEMPLATE = "<html><body><p>{{ notice }}</p></body></html>\n";

/**
 * Write the tree of the reported case under `root`: a method directory, `methods/foo`, holding a
 * bundle, the template its step fills, three secret files under ordinary names and a `.env`,
 * below a `.gitignore` at `root` listing the three, which the lister never reads since it lies
 * above the tree's root. `root` should hold an entry named `.git`, so Manifest Discovery stops
 * there. Returns the method directory and the bundle's path.
 */
export function writeReportedCase(root: string): { dir: string; edited: string } {
  const dir = join(root, "methods", "foo");
  const files: Record<string, string> = {
    [join(root, ".gitignore")]: "*.pem\nsecrets.yaml\nservice-account.json\n",
    [join(dir, "main.mthds")]: NOTICE_BUNDLE,
    [join(dir, "notice.html")]: NOTICE_TEMPLATE,
    [join(dir, "key.pem")]: fake.pem,
    [join(dir, "secrets.yaml")]: `aws_access_key_id: ${fake.aws}\nanthropic: ${fake.anthropic}\n`,
    [join(dir, "service-account.json")]: serviceAccountJson(),
    [join(dir, ".env")]: `PIPELEX_API_KEY=${fake.pipelex}\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return { dir, edited: join(dir, "main.mthds") };
}

/**
 * Text that any of the reported case's secret files holds and nothing else of its tree does, as
 * it reads in a JSON body as in raw bytes: a sent request holding one of them sent a secret.
 */
export const REPORTED_CASE_SECRETS: readonly string[] = [
  "PRIVATE KEY",
  fake.aws,
  fake.anthropic,
  fake.pipelex,
  "gserviceaccount",
];
