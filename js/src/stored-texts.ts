/**
 * Which values of a run are stored texts, told by concept — the pure half of loading them.
 *
 * Since the runtime's large-text storage, a `native.Text`, `native.Markdown`, `native.Html` or `native.JSON` value past
 * the runtime's inline threshold is stored under the run's scope and travels as its reference,
 * `{ url, size, mime_type, preview }`, in place of its value field (`text`, `inner_html` or
 * `json_obj`). Its `url` is a `pipelex-storage://` address, exactly as an image's or a document's
 * is, so a reader must tell a stored text from a file, and the MTHDS standard rules how: by the
 * concept at the value's path, never by its URL or its MIME type (a `Document` may well be
 * `text/plain`).
 *
 * The concept at each path comes from the run's own artifacts:
 *
 * ```
 * main stuff's concept ── working_memory.aliases.main_stuff → working_memory.root[name].concept
 *   └── its structure ─── the first output_form / input_form node naming that concept,
 *                         which states each nested field's concept and refinement chain
 *         └── no node ─── the native's own shape: Page → TextAndImages → Text, Image
 * plural ─────────────── a `{ items: [...] }` content, unless the concept has a field `items`
 * ```
 *
 * A concept is a stored text when it, or a concept its `refines` chain names, is one of
 * {@link STORED_TEXT_CONCEPT_REFS}. Nothing here performs I/O: the walk is shared by the loader
 * (`loadStoredTexts`) and by the file walkers (`locateArtifacts`, `collectArtifacts`), which skip
 * a stored text rather than count it as a file. See `docs/run-results.md`, "Stored texts".
 */

import type { InputForm, InputFormItem, OutputForm } from "mthds/protocol";
import type { DictWorkingMemory } from "./models.js";

// ── Constants ────────────────────────────────────────────────────────

/** The concepts whose value the runtime stores past its inline threshold and carries as a reference. */
export const STORED_TEXT_CONCEPT_REFS = [
  "native.Text",
  "native.Markdown",
  "native.Html",
  "native.JSON",
] as const;

/** What a stored text holds once loaded: a text, an HTML fragment, or a JSON object. */
export type StoredTextKind = "text" | "html" | "json";

const KIND_BY_CONCEPT: Readonly<Record<string, StoredTextKind>> = {
  "native.Text": "text",
  "native.Markdown": "text",
  "native.Html": "html",
  "native.JSON": "json",
};

/** The field a loaded value of each kind is carried in: the inline form's value field. */
export const STORED_TEXT_VALUE_FIELD: Readonly<Record<StoredTextKind, string>> = {
  text: "text",
  html: "inner_html",
  json: "json_obj",
};

/** The fields of the referenced form, which the loaded form drops. */
export const STORED_TEXT_REFERENCE_FIELDS = ["url", "size", "mime_type", "preview"] as const;

const MAIN_STUFF_ALIAS = "main_stuff";
const LIST_ITEMS_FIELD = "items";

/**
 * The members of the native composites whose shape the walk knows without a descriptor, so a
 * page's text is found even when the run's forms are missing.
 */
const NATIVE_MEMBERS: Readonly<
  Record<string, Readonly<Record<string, string | readonly [string]>>>
> = {
  "native.Page": { text_and_images: "native.TextAndImages", page_view: "native.Image" },
  "native.TextAndImages": { text: "native.Text", images: ["native.Image"] },
};

const NATIVE_FILE_KINDS: Readonly<Record<string, "image" | "document">> = {
  "native.Image": "image",
  "native.Document": "document",
};

// ── Concept tests ────────────────────────────────────────────────────

/**
 * The kind of stored text a concept holds, read off the concept itself and then its refinement
 * chain (immediate parent first), or `null` for any other concept. `my.Memo refines native.Text`
 * is a `text`; a `native.Document`, whatever its MIME type, is `null`.
 */
export function storedTextKindOf(
  conceptRef: string | null | undefined,
  refines?: readonly string[] | null,
): StoredTextKind | null {
  for (const candidate of [conceptRef, ...(refines ?? [])]) {
    if (typeof candidate !== "string") continue;
    const kind = KIND_BY_CONCEPT[candidate];
    if (kind !== undefined) return kind;
  }
  return null;
}

/** Whether a concept, or one its refinement chain names, is a stored text — see {@link storedTextKindOf}. */
export function isStoredTextConcept(
  conceptRef: string | null | undefined,
  refines?: readonly string[] | null,
): boolean {
  return storedTextKindOf(conceptRef, refines) !== null;
}

/** The domain of the natives: a concept whose chain reaches one is never text by the language's rule alone. */
const NATIVE_PREFIX = "native.";

/**
 * The stored-text kind a descriptor node describes, or `null`: a list is never one, its items may
 * be. A node is a stored text when its concept, or one its refinement chain names, is one of
 * {@link STORED_TEXT_CONCEPT_REFS}, and also when its concept reaches no native at all and the
 * node is text (`prose`, or `text` under a `label` intent): a description-only concept, or one
 * refining such a concept, is text by the language's rule, and the runtime stores it as it stores
 * a `native.Text`. A field typed by a bare field type carries no concept and is always inline.
 */
export function storedTextKindOfNode(node: InputFormItem | undefined): StoredTextKind | null {
  if (node === undefined || node.kind === "list") return null;
  const kind = storedTextKindOf(node.concept_ref, node.refines);
  if (kind !== null) return kind;
  if (node.concept_ref === undefined) return null;
  const chain = [node.concept_ref, ...(node.refines ?? [])];
  if (chain.some((concept) => concept.startsWith(NATIVE_PREFIX))) return null;
  return node.kind === "prose" || node.kind === "text" ? "text" : null;
}

// ── The node at each path ────────────────────────────────────────────

/** The run artifacts the concept facts are read from. */
export interface ConceptSource {
  working_memory?: DictWorkingMemory | null;
  output_form?: OutputForm | null;
  input_form?: InputForm | null;
}

/**
 * The descriptor node of a run's main output, the output-form node the standard states for it,
 * found from the run's own artifacts: the main stuff's concept, which the working memory names,
 * and that concept's structure, which the first `output_form` or `input_form` node naming it
 * states (a concept's node is the same wherever it stands). A concept no form describes keeps the
 * shape the walk knows of a native, and is otherwise opaque. A `{ items: [...] }` content is the
 * plural envelope, unless the concept has a field called `items`.
 *
 * `null` when the results carry no working memory, or one naming no main stuff: nothing then
 * says what the output is, so a walk guided by it treats every value alike.
 */
export function mainStuffNode(
  results: ConceptSource & { main_stuff?: unknown },
): InputFormItem | null {
  const memory = results.working_memory;
  if (memory == null || typeof memory !== "object") return null;
  const aliases = (memory as { aliases?: unknown }).aliases;
  const aliased =
    typeof aliases === "object" && aliases !== null
      ? (aliases as Record<string, unknown>)[MAIN_STUFF_ALIAS]
      : undefined;
  const name = typeof aliased === "string" ? aliased : MAIN_STUFF_ALIAS;
  const stuff = (memory.root as Record<string, unknown> | undefined)?.[name];
  const conceptRef = conceptRefOf((stuff as { concept?: unknown } | undefined)?.concept);
  if (conceptRef === null) return null;
  return contentNode(conceptRef, results.main_stuff, results);
}

/**
 * A descriptor node for a whole working memory (`{ root, aliases }`): each stuff's `content`
 * described by the concept that stuff names, as {@link mainStuffNode} describes the main one.
 * Nothing else in the memory is concept-typed.
 */
export function workingMemoryNode(results: ConceptSource): InputFormItem | null {
  const memory = results.working_memory;
  if (memory == null || typeof memory !== "object") return null;
  const root = (memory as { root?: unknown }).root;
  if (typeof root !== "object" || root === null) return null;
  const stuffFields: InputFormItem[] = [];
  for (const [name, stuff] of Object.entries(root as Record<string, unknown>)) {
    if (typeof stuff !== "object" || stuff === null) continue;
    const conceptRef = conceptRefOf((stuff as { concept?: unknown }).concept);
    if (conceptRef === null) continue;
    const content = contentNode(conceptRef, (stuff as { content?: unknown }).content, results);
    stuffFields.push(
      objectNode(null, [named(name, objectNode(null, [named("content", content)]))]),
    );
  }
  return objectNode(null, [named("root", objectNode(null, stuffFields))]);
}

/**
 * The node describing the child at `key` of a value described by `node`, or `undefined` when
 * nothing describes it: a field of an object node, an item of a list node, and the `items` of the
 * plural envelope a list content is serialized to, which the list node itself goes on describing.
 */
export function childNode(
  node: InputFormItem | undefined,
  parent: unknown,
  key: string | number,
): InputFormItem | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "list") {
    if (Array.isArray(parent)) return node.item;
    return key === LIST_ITEMS_FIELD ? node : undefined;
  }
  if (node.kind === "object" && typeof key === "string" && !Array.isArray(parent)) {
    return node.fields.find((field) => field.name === key);
  }
  return undefined;
}

/** A stuff's concept as its reference: the string the standard carries, or a pre-0.60 `{ code, domain_code }`. */
function conceptRefOf(concept: unknown): string | null {
  if (typeof concept === "string") return concept;
  if (typeof concept === "object" && concept !== null) {
    const fields = concept as Record<string, unknown>;
    const domain = fields["domain_code"] ?? fields["domain"];
    const code = fields["code"];
    if (typeof domain === "string" && typeof code === "string") return `${domain}.${code}`;
  }
  return null;
}

/** The node a content of `conceptRef` is walked with: the concept's node, wrapped when the content is plural. */
function contentNode(conceptRef: string, content: unknown, source: ConceptSource): InputFormItem {
  const element = nodeForConcept(conceptRef, source);
  if (!isPluralEnvelope(content, element)) return element;
  return {
    kind: "list",
    concept_ref: conceptRef,
    ...(element.refines === undefined ? {} : { refines: element.refines }),
    required: true,
    item: element,
  };
}

function isPluralEnvelope(content: unknown, element: InputFormItem): boolean {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return false;
  const keys = Object.keys(content);
  if (keys.length !== 1 || keys[0] !== LIST_ITEMS_FIELD) return false;
  if (!Array.isArray((content as Record<string, unknown>)[LIST_ITEMS_FIELD])) return false;
  return !(
    element.kind === "object" && element.fields.some((field) => field.name === LIST_ITEMS_FIELD)
  );
}

/** The node the forms state for a concept, else the native's own shape, else an opaque node. */
function nodeForConcept(conceptRef: string, source: ConceptSource): InputFormItem {
  for (const form of [source.output_form, source.input_form]) {
    if (form == null || typeof form !== "object") continue;
    for (const descriptor of Object.values(form as Record<string, unknown>)) {
      const roots = descriptorRoots(descriptor);
      for (const root of roots) {
        const found = findConceptNode(root, conceptRef);
        if (found !== undefined) return found;
      }
    }
  }
  return nativeNode(conceptRef);
}

/** The top nodes of one form entry: an output's `field`, an input's `fields`. */
function descriptorRoots(descriptor: unknown): InputFormItem[] {
  if (typeof descriptor !== "object" || descriptor === null) return [];
  const entry = descriptor as { field?: unknown; fields?: unknown };
  const roots: InputFormItem[] = [];
  if (isNode(entry.field)) roots.push(entry.field);
  if (Array.isArray(entry.fields)) roots.push(...entry.fields.filter(isNode));
  return roots;
}

function isNode(value: unknown): value is InputFormItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Depth first, the first node that is not a list and names `conceptRef`. */
function findConceptNode(node: InputFormItem, conceptRef: string): InputFormItem | undefined {
  if (node.kind !== "list" && node.concept_ref === conceptRef) return node;
  if (node.kind === "list" && isNode(node.item)) return findConceptNode(node.item, conceptRef);
  if (node.kind === "object" && Array.isArray(node.fields)) {
    for (const field of node.fields) {
      if (!isNode(field)) continue;
      const found = findConceptNode(field, conceptRef);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A concept no form describes: the shape of a native the walk knows, else an opaque node naming it. */
function nativeNode(conceptRef: string): InputFormItem {
  const members = NATIVE_MEMBERS[conceptRef];
  if (members !== undefined) {
    return objectNode(
      conceptRef,
      Object.entries(members).map(([name, member]) =>
        named(
          name,
          typeof member === "string"
            ? nativeNode(member)
            : {
                kind: "list",
                concept_ref: member[0],
                required: true,
                item: nativeNode(member[0]),
              },
        ),
      ),
    );
  }
  const fileKind = NATIVE_FILE_KINDS[conceptRef];
  if (fileKind !== undefined) return { kind: fileKind, concept_ref: conceptRef, required: true };
  return { kind: "unknown", concept_ref: conceptRef, required: true };
}

function objectNode(conceptRef: string | null, fields: InputFormItem[]): InputFormItem {
  return {
    kind: "object",
    ...(conceptRef === null ? {} : { concept_ref: conceptRef }),
    required: true,
    fields: fields as Extract<InputFormItem, { kind: "object" }>["fields"],
  };
}

function named(name: string, node: InputFormItem): InputFormItem {
  return { ...node, name } as unknown as InputFormItem;
}
