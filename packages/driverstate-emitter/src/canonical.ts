/**
 * Canonical encoding + hash chain for driver-state events — the TS mirror of
 * workbench `contracts/driverstate/canonical.go`. This is the cross-language
 * conformance anchor: the byte rules below MUST reproduce the Go encoder
 * exactly, or the two emitters' hash chains diverge. Rules (spec §5):
 *
 *   - UTF-8 JSON object, every field present, in Event declaration order.
 *   - No insignificant whitespace.
 *   - `hash` is always the empty string in the canonical form.
 *   - `body` is spliced in as its JSON bytes verbatim — this emitter never
 *     re-marshals a body it read back off disk, only ones it just built.
 *   - Scalars are encoded with HTML escaping off, so `<`, `>`, `&` survive as
 *     themselves — matching Go's `Encoder.SetEscapeHTML(false)`.
 *
 * `test/fixtures/canonical-vector.json` (copied verbatim from workbench) pins
 * one event to its canonical bytes and hash; `canonical.test.ts` fails if
 * either drifts.
 */

import { createHash } from "node:crypto";

/** The contract version this package writes against (schema.go's Version). */
export const SCHEMA_VERSION = "driver-state-v0.1.0";

/**
 * One driver-state lifecycle event. Field order here IS the canonical-encoding
 * order. `body` is an ordinary JS value — encoded via `JSON.stringify` exactly
 * once per canonical/hash computation, never re-derived from a previously
 * serialized form.
 */
export interface Event {
  id: string;
  run: string;
  v: string;
  kind: string;
  stream: string;
  time: string;
  actor: string;
  ext_ref: string;
  body: unknown;
  prev: string;
  hash: string;
}

/** Returns the canonical bytes of `e` with `hash` forced empty — what ComputeHash hashes. */
export function canonicalBytes(e: Event): Uint8Array {
  return encode({ ...e, hash: "" });
}

/** Returns the persistence encoding: the canonical layout with the real hash. */
export function encodeEvent(e: Event): Uint8Array {
  return encode(e);
}

/** SHA-256 (hex) over `canonicalBytes(e)` — the chain seal. */
export function computeHash(e: Event): string {
  return createHash("sha256").update(canonicalBytes(e)).digest("hex");
}

function encode(e: Event): Uint8Array {
  const parts = [
    '{"id":',
    jsonString(e.id),
    ',"run":',
    jsonString(e.run),
    ',"v":',
    jsonString(e.v),
    ',"kind":',
    jsonString(e.kind),
    ',"stream":',
    jsonString(e.stream),
    ',"time":',
    jsonString(e.time),
    ',"actor":',
    jsonString(e.actor),
    ',"ext_ref":',
    jsonString(e.ext_ref),
    ',"body":',
    rawBody(e.body),
    ',"prev":',
    jsonString(e.prev),
    ',"hash":',
    jsonString(e.hash),
    "}",
  ];
  return new TextEncoder().encode(parts.join(""));
}

/**
 * Encodes `body` once via JSON.stringify, then normalizes the two characters
 * where its output diverges from Go's encoder with HTML escaping off:
 * U+2028/U+2029 pass through JSON.stringify raw but Go always `\uXXXX`-escapes
 * them. `<`, `>`, `&` already agree (both leave them unescaped). Without this,
 * a body string containing a line/paragraph separator would hash differently
 * in the two implementations and silently fork the chain.
 */
function rawBody(body: unknown): string {
  if (body === undefined || body === null) {
    return "null";
  }
  return JSON.stringify(body)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const SINGLE_CHAR_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * Encodes one string scalar matching Go's `encoding/json` output with HTML
 * escaping off: `<`, `>`, `&` pass through unescaped; control characters and
 * the JS-string-literal-breaking U+2028/U+2029 line/paragraph separators are
 * `\uXXXX`-escaped (Go always escapes these two regardless of the HTML-escape
 * setting, for the same JS-embedding-safety reason).
 */
function jsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const escape = SINGLE_CHAR_ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x2028 || cp === 0x2029) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}
