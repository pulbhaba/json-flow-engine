import { JsonFlowError } from "../errors.js";
import type { JsonPrimitive } from "../json.js";

/**
 * Expression grammar (inside `{{` and `}}`):
 *
 *   expression := reference ( "??" literal )? | literal
 *   reference  := root segment*
 *   root       := "input" | "steps" | "constants"
 *   segment    := "." identifier | "[" integer "]" | "[" json-string "]"
 *   identifier := [A-Za-z_][A-Za-z0-9_-]*
 *   literal    := json-string | json-number | "true" | "false" | "null"
 *
 * There are no operators, function calls or arbitrary code. Anything else is rejected
 * with EXPRESSION_INVALID.
 */

export const REFERENCE_ROOTS = ["input", "steps", "constants"] as const;
export type ReferenceRoot = (typeof REFERENCE_ROOTS)[number];

export type PathSegment = { kind: "key"; key: string } | { kind: "index"; index: number };

export interface ReferenceExpression {
  kind: "reference";
  root: ReferenceRoot;
  segments: readonly PathSegment[];
  /** Literal used when the referenced value is missing or null. */
  fallback?: JsonPrimitive;
}

export interface LiteralExpression {
  kind: "literal";
  value: JsonPrimitive;
}

export type Expression = ReferenceExpression | LiteralExpression;

export type TemplatePart =
  { kind: "text"; text: string } | { kind: "expression"; expression: Expression; raw: string };

export interface ParsedTemplate {
  parts: readonly TemplatePart[];
  /** True when the whole string is exactly one expression, so its JSON type is preserved. */
  single: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*/;
const INTEGER = /^(0|[1-9][0-9]*)/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

export function containsTemplate(text: string): boolean {
  return text.includes("{{");
}

/** Renders a reference as `steps.fetch-user.body["content-type"][0]` for messages. */
export function formatReference(root: ReferenceRoot, segments: readonly PathSegment[]): string {
  let out: string = root;
  for (const segment of segments) {
    if (segment.kind === "index") out += `[${segment.index}]`;
    else if (IDENTIFIER.exec(segment.key)?.[0] === segment.key) {
      out += `.${segment.key}`;
    } else out += `[${JSON.stringify(segment.key)}]`;
  }
  return out;
}

function invalid(raw: string, reason: string): JsonFlowError {
  return new JsonFlowError("EXPRESSION_INVALID", `Invalid expression "${raw}": ${reason}`, {
    details: { expression: raw, reason },
  });
}

class Scanner {
  pos = 0;
  constructor(
    readonly source: string,
    readonly raw: string,
  ) {}

  rest(): string {
    return this.source.slice(this.pos);
  }

  skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source.charAt(this.pos))) this.pos++;
  }

  peek(text: string): boolean {
    return this.source.startsWith(text, this.pos);
  }

  take(text: string): boolean {
    if (!this.peek(text)) return false;
    this.pos += text.length;
    return true;
  }

  match(regex: RegExp): string | undefined {
    const found = regex.exec(this.rest());
    if (!found) return undefined;
    this.pos += found[0].length;
    return found[0];
  }

  done(): boolean {
    return this.pos >= this.source.length;
  }
}

/** Finds the end of a JSON string literal starting at `start` (which must be a quote). */
function scanJsonString(source: string, start: number): number | undefined {
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return undefined;
}

function parseLiteral(scanner: Scanner): JsonPrimitive | undefined {
  if (scanner.peek('"')) {
    const end = scanJsonString(scanner.source, scanner.pos);
    if (end === undefined) throw invalid(scanner.raw, "unterminated string literal");
    const text = scanner.source.slice(scanner.pos, end);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalid(scanner.raw, `malformed string literal ${text}`);
    }
    if (typeof value !== "string") throw invalid(scanner.raw, "malformed string literal");
    scanner.pos = end;
    return value;
  }
  if (scanner.take("true")) return true;
  if (scanner.take("false")) return false;
  if (scanner.take("null")) return null;
  const number = scanner.match(NUMBER);
  if (number !== undefined) return Number(number);
  return undefined;
}

function parseReferenceRoot(scanner: Scanner): ReferenceRoot | undefined {
  for (const root of REFERENCE_ROOTS) {
    if (scanner.peek(root)) {
      const next = scanner.source.charAt(scanner.pos + root.length);
      if (next === "" || next === "." || next === "[" || /\s/.test(next) || next === "?") {
        scanner.pos += root.length;
        return root;
      }
    }
  }
  return undefined;
}

function parseSegments(scanner: Scanner): PathSegment[] {
  const segments: PathSegment[] = [];
  for (;;) {
    if (scanner.take(".")) {
      const key = scanner.match(IDENTIFIER);
      if (key === undefined) throw invalid(scanner.raw, "expected a property name after '.'");
      segments.push({ kind: "key", key });
      continue;
    }
    if (scanner.take("[")) {
      scanner.skipWhitespace();
      if (scanner.peek('"')) {
        const key = parseLiteral(scanner);
        if (typeof key !== "string") throw invalid(scanner.raw, "expected a quoted key in [ ]");
        scanner.skipWhitespace();
        if (!scanner.take("]")) throw invalid(scanner.raw, "expected ']'");
        segments.push({ kind: "key", key });
        continue;
      }
      const index = scanner.match(INTEGER);
      if (index === undefined)
        throw invalid(scanner.raw, "expected an array index or quoted key in [ ]");
      scanner.skipWhitespace();
      if (!scanner.take("]")) throw invalid(scanner.raw, "expected ']'");
      segments.push({ kind: "index", index: Number(index) });
      continue;
    }
    return segments;
  }
}

/** Parses the text between `{{` and `}}`. */
export function parseExpression(raw: string): Expression {
  const scanner = new Scanner(raw, raw);
  scanner.skipWhitespace();
  if (scanner.done()) throw invalid(raw, "empty expression");

  const root = parseReferenceRoot(scanner);
  let expression: Expression;
  if (root !== undefined) {
    const segments = parseSegments(scanner);
    if (root === "steps" && segments.length === 0) {
      throw invalid(raw, "'steps' must be followed by a step id, e.g. steps.fetch-user.body");
    }
    if (root === "steps" && segments[0]?.kind !== "key") {
      throw invalid(raw, "'steps' must be followed by a step id, e.g. steps.fetch-user.body");
    }
    expression = { kind: "reference", root, segments };
    scanner.skipWhitespace();
    if (scanner.take("??")) {
      scanner.skipWhitespace();
      const fallback = parseLiteral(scanner);
      if (fallback === undefined) {
        throw invalid(
          raw,
          "expected a JSON literal (string, number, true, false or null) after '??'",
        );
      }
      expression = { ...expression, fallback };
    }
  } else {
    const literal = parseLiteral(scanner);
    if (literal === undefined) {
      throw invalid(
        raw,
        `expected a reference starting with ${REFERENCE_ROOTS.join(", ")} or a JSON literal`,
      );
    }
    expression = { kind: "literal", value: literal };
  }
  scanner.skipWhitespace();
  if (!scanner.done()) throw invalid(raw, `unexpected "${scanner.rest()}"`);
  return expression;
}

/**
 * Splits a string into literal text and `{{ }}` expressions. A `{{` without a matching `}}`
 * is an error, so a typo never silently ships as literal text. To emit a literal `{{`,
 * write `{{"{{"}}`.
 */
export function parseTemplate(text: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("{{", cursor);
    if (open === -1) break;
    if (open > cursor) parts.push({ kind: "text", text: text.slice(cursor, open) });
    const close = findClose(text, open + 2);
    if (close === undefined) {
      throw new JsonFlowError("EXPRESSION_INVALID", `Unterminated expression in "${text}"`, {
        details: { template: text },
      });
    }
    const raw = text.slice(open + 2, close);
    parts.push({ kind: "expression", expression: parseExpression(raw), raw });
    cursor = close + 2;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  const single = parts.length === 1 && parts[0]?.kind === "expression";
  return { parts, single };
}

function findClose(text: string, from: number): number | undefined {
  let i = from;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') {
      const end = scanJsonString(text, i);
      if (end === undefined) return undefined;
      i = end;
      continue;
    }
    if (text.startsWith("}}", i)) return i;
    i++;
  }
  return undefined;
}
