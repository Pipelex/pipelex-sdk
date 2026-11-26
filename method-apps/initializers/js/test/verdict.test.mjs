// The commands a verdict names, which a person pastes into whatever shell
// they have: quoted for this system's shells, and named one after the other,
// since no separator reads the same in every shell. Held on any system, since
// the answer depends only on what each is given.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inTurn, shellQuote } from "../lib/verdict.mjs";

describe("the commands a verdict names", () => {
  it("quotes a word with single quotes for a POSIX shell", () => {
    assert.equal(shellQuote("/home/ann/my-app", "linux"), "/home/ann/my-app");
    assert.equal(shellQuote("/home/ann/my app", "darwin"), "'/home/ann/my app'");
    assert.equal(shellQuote("Bob's app", "linux"), "'Bob'\\''s app'");
  });

  it("quotes a word on Windows the way PowerShell and cmd both read", () => {
    // A path with no space stays bare: a backslash is no quote character there.
    assert.equal(shellQuote("C:\\Users\\Ann\\my-app", "win32"), "C:\\Users\\Ann\\my-app");
    assert.equal(shellQuote("C:\\Users\\Ann\\my app", "win32"), '"C:\\Users\\Ann\\my app"');
    assert.equal(shellQuote("Bob's app", "win32"), '"Bob\'s app"');
    // PowerShell would expand these inside double quotes, so it gets its own single quotes.
    assert.equal(shellQuote("cost $5", "win32"), "'cost $5'");
    assert.equal(shellQuote("Bob's $5", "win32"), "'Bob''s $5'");
    // PowerShell splats the one and makes a list of the other when bare.
    for (const word of ["@me/app", "a,b"]) {
      assert.equal(shellQuote(word, "win32"), `"${word}"`, word);
    }
  });

  it("names commands one after the other, never chained with && or ;", () => {
    const line = inTurn(["cd C:\\x", "npm install", "npm run serve"]);
    assert.equal(line, "`cd C:\\x`, then `npm install`, then `npm run serve`");
    assert.doesNotMatch(line, /&&|;/);
  });
});
