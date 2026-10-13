/**
 * JSON whose integers stay exact: `parseExactJson` reads an integer past `Number.MAX_SAFE_INTEGER`
 * as a `bigint` holding its digits and everything else as `JSON.parse` reads it, and
 * `stringifyExactJson` writes a `bigint` as its digits and everything else as `JSON.stringify`
 * writes it. The client writes every request body with the latter, so a body JSON cannot carry
 * is the caller's argument, refused before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError, runMayHaveStartedOf } from "../src/errors.js";
import {
  ExactJsonUnsupportedError,
  parseExactJson,
  stringifyExactJson,
} from "../src/exact-json.js";

/** `JSON`, with the `rawJSON` the TypeScript library this package compiles against does not declare. */
const JSON_WITH_RAW = JSON as unknown as { rawJSON?: (text: string) => unknown };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseExactJson", () => {
  it("reads an integer past the safe range as a bigint with its exact digits, at any depth", () => {
    const value = parseExactJson(
      '{"big":12345678901234567891,"nested":{"list":[-98765432109876543210,9007199254740992]}}',
    );

    expect(value).toEqual({
      big: 12345678901234567891n,
      nested: { list: [-98765432109876543210n, 9007199254740992n] },
    });
  });

  it("keeps a safe integer, a fraction and an exponent the number JSON.parse reads", () => {
    const text =
      '{"max":9007199254740991,"min":-9007199254740991,"float":3.0,"rate":3.5,' +
      '"exp":1e21,"long":1.2345678901234567891,"small":12345678901234567e-3}';

    const value = parseExactJson(text) as Record<string, unknown>;

    expect(value).toEqual(JSON.parse(text));
    expect(Object.values(value).every((item) => typeof item === "number")).toBe(true);
    // `3.0` reads as `3`, as it does everywhere in JavaScript: its spelling is not kept.
    expect(value.float).toBe(3);
  });

  it("reads everything else exactly as JSON.parse does, long digit runs in strings included", () => {
    const text =
      ' { "id" : "run_12345678901234567890" , "escaped":"\\"\\\\\\u00e9\\n\\ud83d\\ude00",' +
      '"__proto__":{"polluted":true},"dup":1,"dup":2,"empty":{},"none":[],' +
      '"flags":[true,false,null],"ws" :\t[ 1 ,\n 2 ]\r\n} ';

    const exact = parseExactJson(text);
    const plain: unknown = JSON.parse(text);

    expect(JSON.stringify(exact)).toBe(JSON.stringify(plain));
    expect(Object.getPrototypeOf(exact)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(exact, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads a text that is a bare value", () => {
    expect(parseExactJson("12345678901234567891")).toBe(12345678901234567891n);
    expect(parseExactJson('"12345678901234567891"')).toBe("12345678901234567891");
  });

  it.each([
    ["a text cut short", '{"big":12345678901234567891'],
    ["an empty text", ""],
    ["a trailing comma", "[12345678901234567891,]"],
  ])("throws the SyntaxError JSON.parse throws for %s", (_label, text) => {
    expect(() => parseExactJson(text)).toThrow(SyntaxError);
  });

  it("reads an integer too long for a double, which JSON.parse reads as Infinity, exactly", () => {
    const digits = `1${"0".repeat(400)}`;

    expect(parseExactJson(`[${digits},1e400]`)).toEqual([BigInt(digits), Infinity]);
  });

  it("reads with one JSON.parse and no second reader, a long digit run in a string included", () => {
    const spy = vi.spyOn(JSON, "parse");

    const value = parseExactJson(
      '{"id":"run_12345678901234567890","big":12345678901234567891,"names":["a","b","c"]}',
    );
    const calls = spy.mock.calls.length;
    spy.mockRestore();

    expect(calls).toBe(1);
    expect(value).toEqual({
      id: "run_12345678901234567890",
      big: 12345678901234567891n,
      names: ["a", "b", "c"],
    });
  });
});

describe("parseExactJson on a runtime whose JSON.parse hands a reviver no source text", () => {
  type Reviver = (this: unknown, key: string, value: unknown) => unknown;

  /** Make `JSON.parse` call a reviver as a runtime before the source-text proposal does: no context. */
  function withoutSourceText(): void {
    const parse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Reviver): unknown => {
      if (reviver === undefined) return parse(text);
      return parse(text, function (this: unknown, key: string, value: unknown): unknown {
        return reviver.call(this, key, value);
      });
    });
  }

  it.each([
    ["an integer past the safe range", '{"big":12345678901234567891}'],
    ["a negative one", "[-98765432109876543210]"],
    ["one too long for a double", `[1${"0".repeat(400)}]`],
  ])("refuses %s with ExactJsonUnsupportedError rather than round it", (_label, text) => {
    withoutSourceText();

    expect(() => parseExactJson(text)).toThrow(ExactJsonUnsupportedError);
  });

  it("reads a text holding no number past the safe range as JSON.parse reads it", () => {
    withoutSourceText();
    const text = '{"id":"run_12345678901234567890","max":9007199254740991,"rate":3.5}';

    expect(parseExactJson(text)).toEqual({
      id: "run_12345678901234567890",
      max: 9007199254740991,
      rate: 3.5,
    });
  });

  it("makes the client's answer one the SDK cannot read, saying why", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        '{"pipeline_run_id":"run_7","status":"COMPLETED","inputs":{"big":12345678901234567891}}',
        { status: 200 },
      ),
    );
    withoutSourceText();

    const err = await new PipelexApiClient({ baseUrl: "http://localhost:8081", apiKey: "t" })
      .getRunDetail("run_7")
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as Error).message).toBe(
      "API GET /v1/runs/run_7 answered 200 with a body holding a number past " +
        "Number.MAX_SAFE_INTEGER, which this runtime cannot read exactly",
    );
    expect((err as Error).cause).toBeInstanceOf(ExactJsonUnsupportedError);
  });
});

describe("stringifyExactJson", () => {
  it("writes a bigint as its exact digits, at any depth", () => {
    expect(
      stringifyExactJson({ big: 12345678901234567891n, list: [-98765432109876543210n, 1n] }),
    ).toBe('{"big":12345678901234567891,"list":[-98765432109876543210,1]}');
  });

  it("writes everything else exactly as JSON.stringify does", () => {
    const value = {
      date: new Date(0),
      skipped: undefined,
      list: [undefined, 1.5, "é\n"],
      nested: { toJSON: (): string => "custom" },
    };

    expect(stringifyExactJson(value)).toBe(JSON.stringify(value));
    expect(stringifyExactJson(value, 2)).toBe(JSON.stringify(value, null, 2));
  });

  it("writes a value holding no bigint with one plain JSON.stringify, no replacer called", () => {
    const spy = vi.spyOn(JSON, "stringify");

    const text = stringifyExactJson({ total: 3, list: [1.5, "a"] }, 2);
    const replacers = spy.mock.calls.map((call) => call[1]);
    spy.mockRestore();

    expect(replacers).toEqual([undefined]);
    expect(text).toBe(JSON.stringify({ total: 3, list: [1.5, "a"] }, null, 2));
  });

  it("hands back what parseExactJson read, digit for digit", () => {
    const text =
      '{"big":12345678901234567891,"rate":3.5,"total":3,"id":"12345678901234567890",' +
      '"nested":[-98765432109876543210,{"x":null}]}';

    expect(stringifyExactJson(parseExactJson(text))).toBe(text);
  });

  it("refuses a bigint with a TypeError on a runtime without JSON.rawJSON", () => {
    const rawJson = JSON_WITH_RAW.rawJSON;
    delete JSON_WITH_RAW.rawJSON;
    try {
      expect(() => stringifyExactJson({ big: 12345678901234567891n })).toThrow(TypeError);
      expect(stringifyExactJson({ total: 3 })).toBe('{"total":3}');
    } finally {
      JSON_WITH_RAW.rawJSON = rawJson;
    }
  });
});

describe("a request body", () => {
  const BASE_URL = "http://localhost:8081";

  function makeClient(): PipelexApiClient {
    return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
  }

  it("carries a bigint as its exact digits", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ pipeline_run_id: "run_1" }), { status: 202 }),
      );

    await makeClient().start({ method_id: "mt_x", inputs: { big: 12345678901234567891n } });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toContain('"inputs":{"big":12345678901234567891}');
  });

  it("that JSON cannot carry is refused before anything is sent, never blamed on the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const inputs: Record<string, unknown> = { total: 3 };
    inputs.self = inputs;

    const err = await makeClient()
      .start({ method_id: "mt_x", inputs })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(
      /^The body of POST \/v1\/start cannot be written as JSON, so nothing was sent: /,
    );
    expect((err as Error).cause).toBeInstanceOf(TypeError);
    expect(runMayHaveStartedOf(err)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("holding a bigint is refused before anything is sent on a runtime without JSON.rawJSON", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const rawJson = JSON_WITH_RAW.rawJSON;
    delete JSON_WITH_RAW.rawJSON;
    try {
      const err = await makeClient()
        .start({ method_id: "mt_x", inputs: { big: 12345678901234567891n } })
        .catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      JSON_WITH_RAW.rawJSON = rawJson;
    }
  });
});
