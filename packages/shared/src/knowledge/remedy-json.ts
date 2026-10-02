// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded structural recovery for one malformed REMEDY answer.
 *
 * Ordinary `JSON.parse` is always tried first and this never runs when it succeeds. What follows
 * is only for output that is not valid JSON, and its job is to recover STRUCTURE that is present
 * but malformed. It is not a permissive parser and it must never become one.
 *
 * ## Why it exists, measured rather than assumed
 *
 * On the frozen eval, 11 of 47 answers fail ordinary parsing; on real workspace memories it is
 * 10 of 20. Reading all 11 gives exactly two families, and the one everybody expected is the
 * smaller one:
 *
 *  - **Unclosed array (7 of 11).** The model opens `"condition_spans":[`, writes one complete
 *    string, and then writes `,"condition_summary":` while still inside the array. The array is
 *    never closed. Nothing is ambiguous here: a complete string, a comma, and a known contract
 *    key followed by a colon can only mean the array ended.
 *  - **Raw unescaped quote inside a string (4 of 11).** The model quotes source text that itself
 *    contains a `"`, for example
 *    ``treat `prompt` as "waiting on the user", not as silence``.
 *
 * The second family is what made this urgent. The old recovery paired quote characters greedily
 * with `/"((?:[^"\\]|\\.)*)"/g`, so an internal quote read as a terminator and one intended span
 * became two fragments. The first fragment ends mid-sentence AND is still byte-present in the
 * source, so exact grounding accepted it and a shredded span reached a proposed atom. Grounding
 * was doing its job; it was being handed the wrong input.
 *
 * ## How a string ends
 *
 * The whole fix is one question: when scanning a string, does an unescaped `"` terminate it?
 *
 * A terminator is followed, after optional whitespace, by a token that can legally follow a
 * string value: `:` (it was a key), `]`, `}`, or `,` where the comma is itself followed by `"`,
 * `]` or `}`. Anything else means the quote is a literal character in the text and scanning
 * continues. `"waiting on the user",` is followed by ` not as silence`, so it is literal;
 * `not \`Color(hex: "EADEFF\`)"],` ends at a quote followed by `]`, so that one terminates.
 * Both measured cases resolve correctly, and so does every well-formed array.
 *
 * ## When it refuses to decide
 *
 * One shape has no local answer. On eval item r27 the model wrote `...to send.\","\"- `: it
 * escaped the quotes belonging to the TEXT and then forgot the one that closes the JSON string.
 * Read one way that is a single element containing a comma; read the other it is two elements.
 * Both are structurally plausible.
 *
 * The first version of this scanner guessed, and merged them. That is the same class of defect
 * as the regex it replaced, only rarer: the joined text happened not to ground here, but a
 * source containing the joined shape would have made a welded span into evidence. So a literal
 * quote sitting directly after a comma marks the field ambiguous and the field is dropped. The
 * item loses that evidence, which is the correct trade: no atom is better than a fabricated one.
 *
 * In practice the loss is usually larger than one field. An ambiguous string has already been
 * scanned to wherever it eventually terminated, which for a run-on is typically the end of the
 * answer, so the fields after it are gone too. Resuming at the next contract key would recover
 * them, and it is deliberately not done: that landmark is trustworthy for an array the model
 * forgot to close, where the structure before it was sound, and it is not trustworthy inside a
 * region whose boundaries are already known to be undecidable. On r27 this costs the evidence
 * state, which was worthless anyway with no spans to attach it to.
 *
 * ## What it will not do
 *
 * It never invents characters, never joins fragments, never rewrites evidence, and never emits a
 * string that was cut off by the token budget: a truncated final string is a prefix of what the
 * model meant, which is the fragment shape this module exists to stop, so it is dropped rather
 * than repaired. Shape it does not understand is refused outright.
 */

/** A value in the REMEDY contract: every field is a string or an array of strings. */
export type RecoveredValue = string | string[];

export interface RecoveredObject {
  fields: Map<string, RecoveredValue>;
  /** Structural repairs applied, for reporting. Never a licence to repair more. */
  notes: RecoveryNote[];
}

export type RecoveryNote =
  | "closed_unterminated_array"
  | "dropped_truncated_string"
  | "dropped_truncated_array"
  | "ignored_trailing_content"
  | "read_literal_quote"
  | "abstained_ambiguous_field";

/** The characters that may follow a closing quote. Anything else and the quote was literal. */
function isTerminator(text: string, quoteIndex: number): boolean {
  let i = quoteIndex + 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (i >= text.length) return true; // end of input: nothing can follow, so it closed
  const ch = text[i]!;
  if (ch === ":" || ch === "]" || ch === "}") return true;
  if (ch !== ",") return false;
  // A comma only separates when something that can start a value or close the container
  // follows it. `", not as silence"` is prose; `", "` is the next element.
  let j = i + 1;
  while (j < text.length && /\s/.test(text[j]!)) j += 1;
  if (j >= text.length) return true;
  const after = text[j]!;
  return after === '"' || after === "]" || after === "}";
}

interface StringScan {
  value: string;
  /** Index just past the closing quote. */
  end: number;
  /** The input ran out before the string closed, so `value` is a prefix of the intended text. */
  truncated: boolean;
  /** An unescaped quote was read as a literal character rather than as a terminator. */
  literalQuotes: number;
  /**
   * The scan crossed a `,"` while inside a string, so where this element ends cannot be decided.
   *
   * Measured on eval item r27: the model wrote `...to send.\","\"- ` , escaping the quotes that
   * belong to the TEXT and then forgetting the one that closes the JSON string. Read one way
   * that is one element containing a comma; read the other it is two elements. Both are
   * structurally plausible, so the field is refused rather than guessed, which is the difference
   * between recovery and a parser that quietly welds two spans together.
   */
  ambiguous: boolean;
}

/**
 * Read one JSON string starting at its opening quote.
 *
 * Escapes are honoured exactly as JSON defines them, so `\"` is a quote in the value and never a
 * terminator, and `\\` before a quote leaves that quote unescaped.
 */
function scanString(text: string, start: number): StringScan {
  let out = "";
  let literalQuotes = 0;
  let ambiguous = false;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        return { value: out, end: text.length, truncated: true, literalQuotes, ambiguous };
      }
      // Decode through JSON itself rather than a hand-written escape table: the table is the
      // kind of thing that silently loses \uXXXX.
      const pair = text.slice(i, i + 2);
      if (next === "u" && i + 6 <= text.length) {
        try {
          out += JSON.parse(`"${text.slice(i, i + 6)}"`) as string;
          i += 6;
          continue;
        } catch {
          out += pair;
          i += 2;
          continue;
        }
      }
      try {
        out += JSON.parse(`"${pair}"`) as string;
      } catch {
        out += pair;
      }
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (isTerminator(text, i)) {
        return { value: out, end: i + 1, truncated: false, literalQuotes, ambiguous };
      }
      // A quote that opens right after a comma is the element-separator shape. Reading it as a
      // literal is one plausible parse and reading the comma as a separator is the other, and
      // nothing local decides between them, so the field is refused upstream.
      let back = i - 1;
      while (back >= 0 && /\s/.test(text[back]!)) back -= 1;
      if (text[back] === ",") ambiguous = true;
      out += '"';
      literalQuotes += 1;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { value: out, end: text.length, truncated: true, literalQuotes, ambiguous };
}

const skipWs = (text: string, i: number): number => {
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
};

/** Does a known contract key start here? That is the signal an array was left unclosed. */
function keyAt(text: string, i: number, keys: ReadonlySet<string>): string | null {
  if (text[i] !== '"') return null;
  const scan = scanString(text, i);
  if (scan.truncated || !keys.has(scan.value)) return null;
  const after = skipWs(text, scan.end);
  return text[after] === ":" ? scan.value : null;
}

/**
 * Recover the contract object from malformed text, or refuse.
 *
 * `null` means the text is not recognisably this contract. That is a legitimate answer and the
 * caller must treat it as a parse failure rather than as an empty result.
 */
export function recoverContractObject(
  text: string,
  contractKeys: readonly string[],
): RecoveredObject | null {
  const keys = new Set(contractKeys);
  const notes = new Set<RecoveryNote>();
  const fields = new Map<string, RecoveredValue>();

  let i = text.indexOf("{");
  if (i < 0) return null;
  i += 1;

  while (i < text.length) {
    i = skipWs(text, i);
    if (i >= text.length) break;
    if (text[i] === "}") {
      // The object closed. Anything after it is not part of this answer, EXCEPT that a model
      // that closed early may still be writing contract fields; those are read on the next
      // iteration rather than discarded, and unrecognised trailing text is noted and ignored.
      const after = skipWs(text, i + 1);
      if (after >= text.length) break;
      if (text[after] === ",") {
        notes.add("ignored_trailing_content");
        i = after + 1;
        continue;
      }
      if (keyAt(text, after, keys)) {
        notes.add("ignored_trailing_content");
        i = after;
        continue;
      }
      break;
    }
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] !== '"') {
      // Not a key where a key must be. Shape this module does not understand: refuse rather
      // than guess, which is the whole difference between recovery and permissiveness.
      return fields.size > 0 ? { fields, notes: [...notes] } : null;
    }

    const keyScan = scanString(text, i);
    if (keyScan.truncated) break;
    const key = keyScan.value;
    i = skipWs(text, keyScan.end);
    if (text[i] !== ":") return fields.size > 0 ? { fields, notes: [...notes] } : null;
    i = skipWs(text, i + 1);

    if (text[i] === '"') {
      const scan = scanString(text, i);
      if (scan.literalQuotes > 0) notes.add("read_literal_quote");
      if (scan.ambiguous) {
        notes.add("abstained_ambiguous_field");
        fields.delete(key);
        i = scan.end;
        continue;
      }
      if (scan.truncated) {
        // A prefix of what the model meant. Emitting it is exactly the fragment failure.
        notes.add("dropped_truncated_string");
        i = scan.end;
        break;
      }
      if (keys.has(key)) fields.set(key, scan.value);
      i = scan.end;
      continue;
    }

    if (text[i] === "[") {
      i += 1;
      const items: string[] = [];
      let closed = false;
      let ambiguousField = false;
      while (i < text.length) {
        i = skipWs(text, i);
        if (i >= text.length) break;
        if (text[i] === "]") {
          closed = true;
          i += 1;
          break;
        }
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        // The measured failure: a known key where an element belongs. The array ended here and
        // the model forgot to say so. Close it and let the outer loop read the key.
        if (keyAt(text, i, keys)) {
          notes.add("closed_unterminated_array");
          closed = true;
          break;
        }
        if (text[i] !== '"') break;
        const scan = scanString(text, i);
        if (scan.literalQuotes > 0) notes.add("read_literal_quote");
        if (scan.ambiguous) {
          // Where this element ends cannot be decided. Emitting either reading risks welding
          // two spans into one, which is the failure this module exists to stop, so the whole
          // field is abandoned and the item loses that evidence.
          ambiguousField = true;
          i = scan.end;
          break;
        }
        if (scan.truncated) {
          notes.add("dropped_truncated_string");
          i = scan.end;
          break;
        }
        if (scan.value.trim()) items.push(scan.value);
        i = scan.end;
      }
      if (ambiguousField) {
        notes.add("abstained_ambiguous_field");
        fields.delete(key);
        continue;
      }
      if (!closed) notes.add("dropped_truncated_array");
      if (keys.has(key)) fields.set(key, items);
      continue;
    }

    // A value shape the contract does not contain (number, boolean, null, nested object).
    // Refuse rather than skip it: skipping means guessing where it ends.
    return fields.size > 0 ? { fields, notes: [...notes] } : null;
  }

  return fields.size > 0 ? { fields, notes: [...notes] } : null;
}

/** Read a field as a list of strings, accepting the single-string shape the model also emits. */
export function asStrings(value: RecoveredValue | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  return value.filter((v) => v.trim().length > 0);
}

/** Read a field as one string. An array where a string belongs takes its first element. */
export function asString(value: RecoveredValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : (value[0] ?? "");
}
