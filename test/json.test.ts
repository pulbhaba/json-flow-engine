import { describe, expect, it } from "vitest";
import { checkJsonValue, jsonEquals, isJsonObject } from "../src/json.js";

describe("checkJsonValue", () => {
  it("accepts plain JSON", () => {
    expect(checkJsonValue({ a: [1, "x", null, true, { b: {} }] })).toEqual({ ok: true });
  });
  it("rejects non-JSON with a pointer", () => {
    expect(checkJsonValue({ a: [1, undefined] })).toEqual({
      ok: false,
      path: "/a/1",
      reason: "undefined is not a JSON value",
    });
    expect(checkJsonValue({ "x/y": { n: NaN } })).toMatchObject({ ok: false, path: "/x~1y/n" });
    expect(checkJsonValue(new Date())).toMatchObject({ ok: false, path: "" });
    expect(checkJsonValue({ f: () => 1 })).toMatchObject({ ok: false, path: "/f" });
    expect(checkJsonValue(10n)).toMatchObject({ ok: false });
    expect(checkJsonValue(new Map())).toMatchObject({ ok: false });
  });
  it("isJsonObject excludes arrays and class instances", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(Object.create(null))).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(new Date())).toBe(false);
  });
});

describe("jsonEquals", () => {
  it("compares deeply and strictly", () => {
    expect(jsonEquals({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals(1, "1")).toBe(false);
    expect(jsonEquals([1], { 0: 1 })).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEquals(null, {})).toBe(false);
  });
});
