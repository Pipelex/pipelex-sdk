/**
 * JSON whose integers stay exact.
 *
 * JavaScript reads every JSON number as a double, so an integer past `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1) reads rounded, `12345678901234567891` as `12345678901234567000`, and is written back
 * rounded. `parseExactJson` reads such an integer as a `bigint` holding its exact digits instead,
 * and `stringifyExactJson` writes a `bigint` back as those digits where `JSON.stringify` throws;
 * everything else reads and writes exactly as `JSON.parse` and `JSON.stringify` read and write it.
 * A number with a fraction or an exponent stays a double: `3.0` reads as `3`, as it does
 * everywhere in JavaScript, and is written back as `3`.
 *
 * The client reads a method example's answers with `parseExactJson` and writes every request body
 * with `stringifyExactJson`, so inputs saved by another client go back to the platform digit for
 * digit, whether to `updateMethodExample` or as a run's inputs. The barrel exports both, for a
 * caller that shows such inputs as JSON text or reads them back from it. This module imports
 * nothing.
 */

/** An integer as JSON spells one: a sign and digits, with no fraction and no exponent. */
const INTEGER_TOKEN = /^-?\d+$/;

/**
 * A run of 16 digits. Every integer past the safe range spells at least that many, the smallest
 * being `9007199254740992`, so a text without one holds no such integer and `JSON.parse` reads it
 * exactly. A run inside a string only sends the text through the exact reader for nothing.
 */
const LONG_DIGIT_RUN = /\d{16}/;

/** The four characters JSON allows between its tokens. */
const JSON_WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

/** The characters a JSON number is spelled with. */
const NUMBER_CHARACTERS: ReadonlySet<string> = new Set("-+.eE0123456789");

/** `JSON`, with the `rawJSON` the TypeScript library this package compiles against does not declare. */
const JSON_WITH_RAW = JSON as unknown as { rawJSON?: (text: string) => unknown };

/**
 * Read a JSON text as `JSON.parse` reads it, except that an integer past `Number.MAX_SAFE_INTEGER`
 * in either direction is a `bigint` holding its exact digits. Throws the `SyntaxError`
 * `JSON.parse` throws for a text that is not JSON.
 */
export function parseExactJson(text: string): unknown {
  // `JSON.parse` checks the whole text first, so the reader below only walks well-formed JSON.
  const parsed: unknown = JSON.parse(text);
  return LONG_DIGIT_RUN.test(text) ? new ExactJsonReader(text).readText() : parsed;
}

/**
 * Write a value as `JSON.stringify` writes it, `space` indenting as its own does, except that a
 * `bigint` is written as its exact digits rather than refused. That rests on `JSON.rawJSON`, which
 * every runtime this package supports provides; on one without it, a `bigint` is refused with a
 * `TypeError`, as `JSON.stringify` refuses it, and never written rounded.
 */
export function stringifyExactJson(value: unknown, space?: string | number): string {
  return JSON.stringify(value, writeBigIntExactly, space);
}

/** The replacer of `stringifyExactJson`: a `bigint` as raw JSON text, anything else unchanged. */
function writeBigIntExactly(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  if (typeof JSON_WITH_RAW.rawJSON !== "function") {
    throw new TypeError(
      `This runtime has no JSON.rawJSON, so the bigint ${value.toString()} cannot be written ` +
        "as its exact digits.",
    );
  }
  return JSON_WITH_RAW.rawJSON(value.toString());
}

/**
 * A reader over a text `JSON.parse` has accepted: it walks the structure with a cursor and leaves
 * the grammar to that check. A string's escapes are decoded by `JSON.parse` itself, an object is
 * built as `JSON.parse` builds one, and a number reads as `Number` reads it, unless it is an
 * integer past the safe range.
 */
class ExactJsonReader {
  private at = 0;

  constructor(private readonly text: string) {}

  /** The value the whole text holds. */
  readText(): unknown {
    const value = this.readValue();
    this.skipWhitespace();
    if (this.at !== this.text.length) this.malformed();
    return value;
  }

  private readValue(): unknown {
    this.skipWhitespace();
    switch (this.text[this.at]) {
      case "{":
        return this.readObject();
      case "[":
        return this.readArray();
      case '"':
        return this.readString();
      case "t":
        return this.readLiteral("true", true);
      case "f":
        return this.readLiteral("false", false);
      case "n":
        return this.readLiteral("null", null);
      default:
        return this.readNumber();
    }
  }

  private readObject(): Record<string, unknown> {
    const entries: [string, unknown][] = [];
    this.at += 1;
    this.skipWhitespace();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return {};
    }
    while (this.at < this.text.length) {
      this.skipWhitespace();
      const key = this.readString();
      this.skipWhitespace();
      this.expect(":");
      entries.push([key, this.readValue()]);
      this.skipWhitespace();
      if (this.text[this.at] === "}") {
        this.at += 1;
        // Each key is defined as an own property, `__proto__` included, and a repeated key keeps
        // its first place with its last value, exactly as `JSON.parse` builds an object.
        return Object.fromEntries(entries);
      }
      this.expect(",");
    }
    return this.malformed();
  }

  private readArray(): unknown[] {
    const items: unknown[] = [];
    this.at += 1;
    this.skipWhitespace();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return items;
    }
    while (this.at < this.text.length) {
      items.push(this.readValue());
      this.skipWhitespace();
      if (this.text[this.at] === "]") {
        this.at += 1;
        return items;
      }
      this.expect(",");
    }
    return this.malformed();
  }

  private readString(): string {
    const start = this.at;
    this.expect('"');
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      // An escape is two characters at least, and its second may be a quote.
      this.at += this.text[this.at] === "\\" ? 2 : 1;
    }
    this.expect('"');
    return JSON.parse(this.text.slice(start, this.at)) as string;
  }

  private readLiteral<T>(spelling: string, value: T): T {
    if (!this.text.startsWith(spelling, this.at)) this.malformed();
    this.at += spelling.length;
    return value;
  }

  private readNumber(): number | bigint {
    const start = this.at;
    while (this.at < this.text.length && NUMBER_CHARACTERS.has(this.text[this.at] as string)) {
      this.at += 1;
    }
    const token = this.text.slice(start, this.at);
    if (token === "") this.malformed();
    const value = Number(token);
    return Number.isSafeInteger(value) || !INTEGER_TOKEN.test(token) ? value : BigInt(token);
  }

  private expect(character: string): void {
    if (this.text[this.at] !== character) this.malformed();
    this.at += 1;
  }

  private skipWhitespace(): void {
    while (this.at < this.text.length && JSON_WHITESPACE.has(this.text[this.at] as string)) {
      this.at += 1;
    }
  }

  /**
   * Unreachable on a text `JSON.parse` accepted; it stops the walk rather than let a fault of this
   * reader loop or misread a value.
   */
  private malformed(): never {
    throw new SyntaxError(`The exact JSON reader lost its place at position ${this.at}.`);
  }
}
