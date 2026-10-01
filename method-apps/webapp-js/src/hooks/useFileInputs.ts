"use client";

import { useCallback, useState } from "react";
import { setValueAtPath } from "@pipelex/mthds-form";
// The browser-safe entry: it reaches no Node builtin, so it bundles for the
// client with nothing marked external.
import { uploadWithGrant } from "@pipelex/sdk/upload";
import {
  buildFilePreparationError,
  classifyTransportError,
  classifyUploadError,
  type PipelineError,
} from "@/lib/errors";
import {
  MAX_FILE_BYTES,
  fileInputErrorToPipelineError,
  fileTooLargeError,
  type UploadRequest,
} from "@/lib/fileInputs";
import type { GrantOutcome } from "@/lib/uploadGrant";

/**
 * The host side of the form kernel's file seam, in one hook.
 *
 * The kernel never uploads: a `DocumentField` or `ImageField` fires
 * `env.onDropFile(id, file)` and waits, and the host is expected to store the
 * file and write a `FileValue` (`{url, filename}`) back at the field's dotted
 * path. This hook stores it in Pipelex storage, straight from the browser:
 *
 * 1. It asks the method's Server Action for an upload grant, sending the file's
 *    name, type and size — never its bytes. The action holds the API key and
 *    checks the type and the size before asking the platform for the grant.
 * 2. It sends the file itself to storage with `uploadWithGrant`, a `PUT` the
 *    grant signed for exactly that type and size.
 * 3. It writes the grant's `pipelex-storage://` reference into the form.
 *
 * So the run that follows carries references and no bytes, however many files
 * a list input holds: the bytes cross neither this app's server nor the API
 * gateway, and nothing caps a submission but the platform's limit on one file.
 *
 * The rules it keeps, each of which is a bug when dropped:
 *
 *  - **Clear before every await.** Every path that is about to replace a
 *    selection un-sets the value *before* its first await, so the form's value
 *    is only ever a successfully stored file: a replacement still in flight, or
 *    one that fails, leaves nothing behind to submit by accident.
 *  - **Stay busy for the whole operation, not just one step.** While an id is
 *    in `uploadingIds` the kernel shuts every door into that value — the
 *    dropzone, the "paste a URL instead" toggle, the URL input behind it — and
 *    shows a spinner. The grant request and the upload are one operation: a
 *    window between them where the field is writable is a window where an older
 *    selection lands last and silently replaces the newer.
 *  - **Write the reference only once storage has the file.** A grant's URI
 *    names nothing until storage answers the `PUT`, so a form holding it any
 *    earlier would start a run that fails on a missing object.
 *  - **Check the size before asking.** Purely to save a round trip: the grant
 *    action checks the same exported constant, and the platform's own limit is
 *    the authority behind both.
 *
 * `uploadingIds` is a set rather than a refcount, which matters for a caller
 * that nests one `dropFile` inside its own busy span (a sample-file shortcut
 * that fetches a file and then drops it does): the inner release frees the field while the outer span is
 * still open. That is safe only because nothing awaits after the inner call
 * returns.
 */
export interface UseFileInputsOptions {
  /** Write the stored file's `FileValue` into the form's values at a dotted path. */
  setValues: (update: (current: Record<string, unknown>) => Record<string, unknown>) => void;
  /**
   * The method's grant action — `request<Name>Upload`, which `make add-method`
   * writes beside the run actions with the media types that method takes.
   */
  requestUpload: (request: UploadRequest) => Promise<GrantOutcome>;
  /**
   * Run before a new selection is accepted — a scaffolded form clears the
   * previous run so only the new selection shows. Called before any await.
   */
  onSelectionStart?: () => void;
  /**
   * Last chance to fix a `File` the browser described badly, before it is
   * uploaded. For instance, re-wrap a `.pdf` whose `file.type` is empty. This is
   * a description fix, not validation — the grant action checks the type it is
   * given, and storage holds the upload to it.
   */
  prepareFile?: (file: File) => File;
  /** The size cap, in bytes. Defaults to the platform's limit on one upload. */
  maxBytes?: number;
}

export interface UseFileInputs {
  /** Hand straight to `<RunInputsForm env={{ onDropFile }}>`. */
  dropFile: (id: string, file: File) => Promise<void>;
  /** Hand straight to `<RunInputsForm env={{ uploadingIds }}>`. */
  uploadingIds: ReadonlySet<string>;
  /**
   * A refused or failed upload. Separate from the run's own error because it
   * happens *before* a run, so there is no `useRun` error to carry it.
   */
  fileError: PipelineError | null;
  /** Clear the rejection — a value the user has already fixed keeps no alert. */
  clearError: () => void;
  /** Hold a field busy across an operation of the host's own, such as a fetch. */
  markBusy: (id: string, busy: boolean) => void;
  /** Report a failure of such an operation as this hook's own file error. */
  reportError: (err: unknown) => void;
  /** Un-select the file at `id`, before an await that will replace it. */
  clearFile: (id: string) => void;
}

const NO_UPLOADS: ReadonlySet<string> = new Set<string>();

export function useFileInputs({
  setValues,
  requestUpload,
  onSelectionStart,
  prepareFile,
  maxBytes = MAX_FILE_BYTES,
}: UseFileInputsOptions): UseFileInputs {
  const [fileError, setFileError] = useState<PipelineError | null>(null);
  const [uploadingIds, setUploadingIds] = useState<ReadonlySet<string>>(NO_UPLOADS);

  const clearError = useCallback(() => setFileError(null), []);

  const clearFile = useCallback(
    (id: string) => setValues((current) => setValueAtPath(current, id.split("."), undefined)),
    [setValues],
  );

  const markBusy = useCallback((id: string, busy: boolean) => {
    setUploadingIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const reportError = useCallback((err: unknown) => setFileError(classifyTransportError(err)), []);

  const dropFile = useCallback(
    async (id: string, dropped: File) => {
      setFileError(null);
      onSelectionStart?.();
      clearFile(id); // before the size check and before any await
      // The host's own code: a throw here must reach the user as a file error,
      // not escape as a rejection nobody handles — the kernel does not await
      // `onDropFile`.
      let file: File;
      try {
        file = prepareFile ? prepareFile(dropped) : dropped;
      } catch (err) {
        setFileError(buildFilePreparationError(err));
        return;
      }
      if (file.size > maxBytes) {
        setFileError(
          fileInputErrorToPipelineError(fileTooLargeError(file.size, maxBytes), file.name),
        );
        return;
      }
      markBusy(id, true);
      try {
        const granted = await requestUpload({
          filename: file.name,
          content_type: file.type,
          size: file.size,
        });
        if (!granted.ok) {
          setFileError(granted.error);
          return;
        }
        // The SDK bounds the upload itself, by the file's size, so a stalled
        // one ends as an `UploadTransportError` rather than a spinner.
        const { uri } = await uploadWithGrant(granted.grant, file);
        setValues((current) =>
          setValueAtPath(current, id.split("."), { url: uri, filename: file.name }),
        );
      } catch (err) {
        setFileError(classifyUploadError(err));
      } finally {
        markBusy(id, false);
      }
    },
    [onSelectionStart, clearFile, prepareFile, maxBytes, markBusy, requestUpload, setValues],
  );

  return {
    dropFile,
    uploadingIds,
    fileError,
    clearError,
    markBusy,
    reportError,
    clearFile,
  };
}
