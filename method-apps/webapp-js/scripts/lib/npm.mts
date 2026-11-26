/**
 * How the scripts run npm. A module of its own, needing nothing but Node, so
 * that `serve.mts`, which must run with the app's dependencies alone, can share
 * it with the scripts that load the SDK.
 */
import path from "node:path";
import process from "node:process";

/** How a script runs npm: a command and the arguments that come before npm's own. */
export interface NpmInvocation {
  command: string;
  args: string[];
}

/**
 * How a script runs npm, on every system. Under `npm run`, npm names its own
 * script in `npm_execpath`, and it is run with this Node. Elsewhere it is `npm`
 * on the PATH, except on Windows, where `npm` is `npm.cmd`, which Node will not
 * spawn without a shell: there npm's script is the one the Node installer puts
 * beside `node.exe`.
 */
export function npmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): NpmInvocation {
  const named = env.npm_execpath;
  if (named !== undefined && /\.c?js$/.test(named)) return { command: execPath, args: [named] };
  if (platform !== "win32") return { command: "npm", args: [] };
  return {
    command: execPath,
    args: [
      path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ],
  };
}
