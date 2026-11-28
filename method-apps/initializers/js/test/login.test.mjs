// The family's reading of the login's key, `initializers/login-key.json`,
// executed against this initializer's reader. The webapp-js template's
// `npm run create` executes a copy of the same table, so the two read the
// login's file alike.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { displayPath, loginCommand, MAX_LOGIN_FILE_BYTES, readLoginKey } from "../lib/login.mjs";
import { tempRoot } from "./support.mjs";

const TABLE = JSON.parse(fs.readFileSync(new URL("../../login-key.json", import.meta.url), "utf8"));

/** A path of the table, `<root>` and `/` made this run's. */
function local(text, root) {
  return text.replace("<root>", root).replaceAll("/", path.sep);
}

describe("initializers/login-key.json", () => {
  for (const c of TABLE.cases) {
    it(c.name, () => {
      const root = tempRoot("create-method-app-login-");
      const home = path.join(root, "home");
      fs.mkdirSync(home);
      if (c.file !== undefined) {
        const file = path.join(root, local(c.file, ""));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (c.kind === "directory") fs.mkdirSync(file);
        else if (c.kind === "over-limit") {
          const line = "PIPELEX_API_KEY=plx_sk_case_large\n";
          fs.writeFileSync(file, line.padEnd(MAX_LOGIN_FILE_BYTES + 1, "#"));
        } else fs.writeFileSync(file, c.content);
      }
      const env = c.pipelex_home === undefined ? {} : { PIPELEX_HOME: local(c.pipelex_home, root) };
      const homedir = () => home;
      const read = readLoginKey(env, { homedir });

      assert.equal(read.status, c.expect.status);
      if (c.expect.file !== undefined) {
        assert.equal(displayPath(read.file, homedir), local(c.expect.file, root));
      }
      if (c.expect.status === "key") {
        assert.equal(read.key, c.expect.key);
        assert.equal(read.baseUrl ?? null, c.expect.base_url);
      } else {
        assert.equal(read.key, undefined);
        assert.equal(read.baseUrl, undefined);
      }
    });
  }
});

describe("the login command", () => {
  it("is npx.cmd on Windows and npx elsewhere", () => {
    assert.equal(loginCommand("win32"), "npx.cmd -y @pipelex/mcp@latest login");
    assert.equal(loginCommand("darwin"), "npx -y @pipelex/mcp@latest login");
    assert.equal(loginCommand("linux"), "npx -y @pipelex/mcp@latest login");
  });
});
