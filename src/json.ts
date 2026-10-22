/**
 * JSON value model shared by workflow definitions, inputs, step outputs and results.
 *
 * Everything that crosses the engine boundary (inputs, operation outputs, mock responses)
 * must be a `JsonValue`: no `undefined`, functions, class instances, `Date`, `BigInt`,
 * `NaN` or `Infinity`. This keeps execution deterministic and results serialisable.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonCheckResult = { ok: true } | { ok: false; path: string; reason: string };

/** Checks that a value is plain JSON. Returns the JSON pointer of the first offending value. */
export function checkJsonValue(value: unknown, path = ""): JsonCheckResult {
  if (value === null) return { ok: true };
  switch (typeof value) {
    case "string":
    case "boolean":
      return { ok: true };
    case "number":
      return Number.isFinite(value)
        ? { ok: true }
        : { ok: false, path, reason: "non-finite number (NaN or Infinity)" };
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const result = checkJsonValue(value[i], `${path}/${i}`);
          if (!result.ok) return result;
        }
        return { ok: true };
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        return { ok: false, path, reason: "non-plain object (class instance, Date, Map, ...)" };
      }
      for (const [key, entry] of Object.entries(value)) {
        const result = checkJsonValue(entry, `${path}/${escapePointerSegment(key)}`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "undefined":
      return { ok: false, path, reason: "undefined is not a JSON value" };
    case "function":
    case "symbol":
    case "bigint":
      return { ok: false, path, reason: `${typeof value} is not a JSON value` };
    default:
      return { ok: false, path, reason: "unsupported value" };
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  return checkJsonValue(value).ok;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Deep-freezes a JSON value in place and returns it. Used so steps cannot mutate shared state. */
export function deepFreeze<T extends JsonValue>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const entry of value) deepFreeze(entry);
    } else {
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
  }
  return value;
}

/** Structural clone for JSON values (never shares references with the source). */
export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, i) => {
      const other = b[i];
      return other !== undefined && jsonEquals(entry, other);
    });
  }
  if (Array.isArray(b) || typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => {
    const other = b[key];
    const mine = a[key];
    return other !== undefined && mine !== undefined && jsonEquals(mine, other);
  });
}

/** Describes the JSON type of a value for error messages. */
export function jsonTypeName(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** RFC 6901 escaping for a JSON pointer segment. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Builds a JSON pointer from path segments (`["steps", 1, "config"]` -> `/steps/1/config`). */
export function jsonPointer(segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${escapePointerSegment(String(segment))}`).join("");
}
