import { describe, expect, it } from "vitest";
import { CompiledUrlPolicy, isPrivateHost } from "../src/http/url-policy.js";

describe("isPrivateHost", () => {
  it("recognises loopback, private, link-local and metadata hosts", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "api.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "[::1]",
      "[::]",
      "[fd12::1]",
      "[fe80::1]",
      "[::ffff:10.0.0.1]",
      "metadata.google.internal",
      "db.internal",
      "printer.local",
      "localhost.",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });
  it("treats public hosts as public", () => {
    for (const host of [
      "api.example.com",
      "8.8.8.8",
      "172.32.0.1",
      "11.0.0.1",
      "[2606:4700::1]",
      "localhost.example.com",
      "100.128.0.1",
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe("CompiledUrlPolicy", () => {
  const check = (policy: ConstructorParameters<typeof CompiledUrlPolicy>[0], url: string) =>
    new CompiledUrlPolicy(policy).check(new URL(url)).allowed;

  it("allows public https by default and nothing else", () => {
    expect(check({}, "https://api.example.com/x")).toBe(true);
    expect(check({}, "http://api.example.com/x")).toBe(false);
    expect(check({}, "https://localhost/x")).toBe(false);
  });

  it("matches allow patterns on scheme, host and port", () => {
    expect(check({ allow: ["http://localhost:3000"] }, "http://localhost:3000/a")).toBe(true);
    expect(check({ allow: ["http://localhost:3000"] }, "http://localhost:3001/a")).toBe(false);
    expect(check({ allow: ["http://localhost:*"] }, "http://localhost:3001/a")).toBe(true);
    expect(check({ allow: ["http://localhost"] }, "http://localhost/a")).toBe(true);
    expect(check({ allow: ["http://localhost"] }, "http://localhost:80/a")).toBe(true);
    expect(check({ allow: ["https://api.example.com"] }, "https://api.example.com:443/a")).toBe(
      true,
    );
    expect(check({ allow: ["https://api.example.com"] }, "http://api.example.com/a")).toBe(false);
    // Plain http is refused unless listed, which makes the wildcard semantics observable.
    expect(check({ allow: ["http://*.example.com"] }, "http://a.b.example.com/a")).toBe(true);
    expect(check({ allow: ["http://*.example.com"] }, "http://example.com/a")).toBe(false);
    expect(check({ allow: ["http://*.example.com"] }, "http://evilexample.com/a")).toBe(false);
    expect(check({ allow: ["http://*.example.com"] }, "http://x.example.com.evil.net/a")).toBe(
      false,
    );
    expect(check({ allow: ["http://*.example.com"] }, "http://A.EXAMPLE.com/a")).toBe(true);
  });

  it("gives a reason when refusing", () => {
    const decision = new CompiledUrlPolicy({}).check(new URL("http://10.0.0.1/"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("plain http");
    expect(
      new CompiledUrlPolicy({ allowHttp: true }).check(new URL("http://10.0.0.1/")).reason,
    ).toContain("private");
  });
});
