/**
 * The media types the PDF example's file input accepts.
 *
 * The one list both halves read: `requestSummarizePdfUpload` grants a file only
 * in one of these types, judged as the dropzone judges it, so a `.pdf` the
 * browser left untyped is read by its extension; and `PdfForm` narrows the
 * document input to the formats among these, so the dropzone offers exactly what
 * the action grants. A module of its
 * own because neither half can hold it: the action's `"use server"` file may
 * export async functions only, and the form is a client component the action
 * must not import.
 */
export const ALLOWED_MIMES = ["application/pdf"];
