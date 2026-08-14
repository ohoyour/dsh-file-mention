/**
 * Stable wire representation for a selected workspace reference.
 *
 * The input pipeline keeps `ReferenceInsert.ref` as structured state until
 * submit. The serialized form is intentionally readable (`@{path}`), while
 * escaping delimiter-sensitive characters keeps legal paths round-trippable.
 */

const ESCAPED_REFERENCE_CHAR = /[%{}\r\n]/g
const ESCAPED_REFERENCE_CHAR_MAP: Record<string, string> = {
  '%': '%25',
  '{': '%7B',
  '}': '%7D',
  '\r': '%0D',
  '\n': '%0A',
}

/** Serialize a workspace-relative path for clipboard and model text. */
export function serializeFileReference(path: string): string {
  const escaped = path.replace(ESCAPED_REFERENCE_CHAR, char => ESCAPED_REFERENCE_CHAR_MAP[char]!)
  return `@{${escaped}}`
}

