import { getPipelexClient } from "@/lib/pipelexClient";
import { classifyPipelineError, type PipelineError } from "@/lib/errors";
import { checkUploadRequest, fileInputErrorToPipelineError } from "@/lib/fileInputs";
import { readClassifyEnv } from "@/lib/serverEnv";
import type { UploadGrant } from "@pipelex/sdk";

export type GrantOutcome = { ok: true; grant: UploadGrant } | { ok: false; error: PipelineError };

/**
 * Ask for a grant to upload one file straight from the browser to Pipelex
 * storage — `POST /v1/upload/grant`. Server-only (it constructs the SDK client
 * and reads `process.env`); a method's `request<Name>Upload` Server Action is a
 * thin call to it with the media types that method takes.
 *
 * The browser holds the file and no key; this server holds the key and never
 * the file. The grant joins them: a presigned, create-only `PUT` for one new
 * object, signed for the declared type and size, which the browser sends with
 * `uploadWithGrant`. So the bytes cross neither this server nor the API gateway,
 * and no Server Action body carries more than a file's name, type and size.
 *
 * The request is checked first, because a Server Action is a public endpoint:
 * `checkUploadRequest` refuses a type the method does not take and a size past
 * `MAX_FILE_BYTES`, before any grant is asked for. The platform refuses a size
 * past its own limit too, with a `413` that stays the authority.
 *
 * **The grant is a bearer capability**: until it expires, whoever holds it can
 * create that one object. It goes to the browser that asked, and nowhere else —
 * never into a log.
 *
 * **A grant action is a public endpoint**, and it lets anyone who can reach the
 * app store a file in the deployment's organisation. It is open here for the
 * reason the run actions are: nothing authenticates the browser that calls a
 * Server Action, which is why the dev and start servers listen on loopback by
 * default (`APP_HOST` in the `Makefile`). A deployment serving more than one
 * person has to decide who may store files before asking for a grant.
 */
export async function grantFileUpload(
  request: unknown,
  opts: { allowedMimes: string[]; maxBytes: number },
): Promise<GrantOutcome> {
  const refused = checkUploadRequest(request, opts);
  if (refused) {
    const filename = (request as { filename?: unknown } | null | undefined)?.filename;
    return {
      ok: false,
      error: fileInputErrorToPipelineError(refused, typeof filename === "string" ? filename : ""),
    };
  }
  // `checkUploadRequest` proved each field's type, so the request is read as one.
  const { filename, content_type, size } = request as {
    filename: string;
    content_type: string;
    size: number;
  };
  try {
    const grant = await getPipelexClient().requestUploadGrant({ filename, content_type, size });
    return { ok: true, grant };
  } catch (err) {
    return {
      ok: false,
      error: classifyPipelineError(err, readClassifyEnv(), { uploadGrant: true }),
    };
  }
}
