import { describe, expect, it } from "vitest";
import { parseExpression, parseTemplate } from "../src/expressions/parse.js";
import { resolveString, resolveValue, type ExpressionScope } from "../src/expressions/resolve.js";
import { JsonFlowError } from "../src/errors.js";

const scope: ExpressionScope = {
  input: {
    userId: "u-1",
    count: 3,
    active: true,
    tags: ["a", "b"],
    nested: { deep: { value: null } },
    "odd key": 1,
  },
  steps: {
    "fetch-user": { status: 200, body: { id: 42, roles: ["admin"], profile: null } },
    optional: null,
  },
  constants: { baseUrl: "https://api.example.com", retries: 2 },
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof JsonFlowError) return error.code;
    throw error;
  }
  throw new Error("expected an error");
}

describe("parseExpression", () => {
  it("parses references with dots, indexes and quoted keys", () => {
    expect(parseExpression('steps.fetch-user.body.roles[0]["x y"]')).toEqual({
      kind: "reference",
      root: "steps",
      segments: [
        { kind: "key", key: "fetch-user" },
        { kind: "key", key: "body" },
        { kind: "key", key: "roles" },
        { kind: "index", index: 0 },
        { kind: "key", key: "x y" },
      ],
    });
  });

  it("parses fallbacks and literals", () => {
    expect(parseExpression(" input.limit ?? 10 ")).toMatchObject({ fallback: 10 });
    expect(parseExpression('input.name ?? "anon"')).toMatchObject({ fallback: "anon" });
    expect(parseExpression("input.flag ?? null")).toMatchObject({ fallback: null });
    expect(parseExpression('"{{"')).toEqual({ kind: "literal", value: "{{" });
    expect(parseExpression("-1.5e3")).toEqual({ kind: "literal", value: -1500 });
  });

  it("rejects anything outside the grammar", () => {
    for (const bad of [
      "",
      "foo.bar",
      "input.a + 1",
      "steps",
      "steps[0]",
      "input.a ?? input.b",
      "input.(x)",
      "process.env",
      "input.a; drop",
      "input.a ?? ",
    ]) {
      expect(
        code(() => parseExpression(bad)),
        bad,
      ).toBe("EXPRESSION_INVALID");
    }
  });
});

describe("parseTemplate", () => {
  it("splits text and expressions", () => {
    const parsed = parseTemplate("{{constants.baseUrl}}/users/{{input.userId}}?x=1");
    expect(parsed.single).toBe(false);
    expect(parsed.parts.map((p) => p.kind)).toEqual(["expression", "text", "expression", "text"]);
  });

  it("treats a lone expression as single", () => {
    expect(parseTemplate("{{ input.count }}").single).toBe(true);
    expect(parseTemplate(" {{input.count}}").single).toBe(false);
  });

  it("rejects unterminated expressions", () => {
    expect(code(() => parseTemplate("{{input.a"))).toBe("EXPRESSION_INVALID");
  });

  it("allows }} inside a string literal", () => {
    expect(parseTemplate('{{"}}"}}').parts).toEqual([
      { kind: "expression", expression: { kind: "literal", value: "}}" }, raw: '"}}"' },
    ]);
  });
});

describe("resolveString", () => {
  it("keeps the JSON type of a single expression", () => {
    expect(resolveString("{{input.count}}", scope)).toBe(3);
    expect(resolveString("{{input.active}}", scope)).toBe(true);
    expect(resolveString("{{input.tags}}", scope)).toEqual(["a", "b"]);
    expect(resolveString("{{steps.fetch-user.body}}", scope)).toEqual({
      id: 42,
      roles: ["admin"],
      profile: null,
    });
    expect(resolveString("{{input.nested.deep.value}}", scope)).toBeNull();
    expect(resolveString('{{input["odd key"]}}', scope)).toBe(1);
    expect(resolveString("{{input}}", scope)).toBe(scope.input);
  });

  it("interpolates primitives into text", () => {
    expect(
      resolveString(
        "{{constants.baseUrl}}/users/{{input.userId}}/{{input.count}}/{{input.active}}",
        scope,
      ),
    ).toBe("https://api.example.com/users/u-1/3/true");
  });

  it("never coerces objects, arrays or null into text", () => {
    expect(code(() => resolveString("id={{steps.fetch-user.body}}", scope))).toBe(
      "EXPRESSION_TYPE",
    );
    expect(code(() => resolveString("tags={{input.tags}}", scope))).toBe("EXPRESSION_TYPE");
    expect(code(() => resolveString("v={{input.nested.deep.value}}", scope))).toBe(
      "EXPRESSION_TYPE",
    );
  });

  it("fails closed on missing values and honours fallbacks", () => {
    expect(code(() => resolveString("{{input.missing}}", scope))).toBe("EXPRESSION_UNRESOLVED");
    expect(code(() => resolveString("{{steps.unknown.body}}", scope))).toBe(
      "EXPRESSION_UNRESOLVED",
    );
    expect(code(() => resolveString("{{steps.fetch-user.body.profile.name}}", scope))).toBe(
      "EXPRESSION_UNRESOLVED",
    );
    expect(code(() => resolveString("{{input.tags[5]}}", scope))).toBe("EXPRESSION_UNRESOLVED");
    expect(resolveString("{{input.missing ?? 7}}", scope)).toBe(7);
    expect(resolveString('{{steps.fetch-user.body.profile ?? "none"}}', scope)).toBe("none");
    expect(resolveString("{{steps.optional.body ?? null}}", scope)).toBeNull();
    expect(resolveString('v={{input.nested.deep.value ?? "-"}}', scope)).toBe("v=-");
  });

  it("escapes literal braces through a string literal", () => {
    expect(resolveString('{{"{{"}}not an expression}}', scope)).toBe("{{not an expression}}");
  });

  it("does not look at prototype properties", () => {
    expect(code(() => resolveString("{{input.constructor}}", scope))).toBe("EXPRESSION_UNRESOLVED");
    expect(code(() => resolveString("{{input.__proto__}}", scope))).toBe("EXPRESSION_UNRESOLVED");
    expect(code(() => resolveString("{{input.tags.length}}", scope))).toBe("EXPRESSION_UNRESOLVED");
  });
});

describe("resolveValue", () => {
  it("resolves nested structures and leaves keys alone", () => {
    expect(
      resolveValue(
        {
          url: "{{constants.baseUrl}}/x",
          body: { id: "{{steps.fetch-user.body.id}}", "{{input.userId}}": 1 },
          list: ["{{input.count}}", "n"],
        },
        scope,
      ),
    ).toEqual({
      url: "https://api.example.com/x",
      body: { id: 42, "{{input.userId}}": 1 },
      list: [3, "n"],
    });
  });
});
