import { JsonFlowError } from "../errors.js";

/**
 * Controls which URLs `http.request` may call in live execution.
 *
 * Default policy: only `https://` to public hosts. Plain `http://`, loopback, private,
 * link-local and cloud-metadata addresses are refused unless the origin is listed in `allow`
 * or the matching flag is set. The check is on the URL's host literal only; it does not
 * resolve DNS, so a public name that resolves to a private address is not caught. Workflows
 * that run with network access are trusted configuration, not untrusted input.
 */
export interface UrlPolicy {
  /**
   * Allowed origins, e.g. `"http://localhost:3000"`, `"https://api.example.com"`,
   * `"https://*.example.com"` (subdomains only) or `"http://127.0.0.1:*"` (any port).
   * A listed origin is allowed even if it is private or plain http.
   */
  allow?: string[];
  /** Allow `http://` to any host. Default false. */
  allowHttp?: boolean;
  /** Allow loopback, private and link-local hosts. Default false. */
  allowPrivateNetworks?: boolean;
}

export interface UrlPolicyDecision {
  allowed: boolean;
  reason?: string;
}

const ORIGIN_PATTERN = /^(https?):\/\/(\*\.)?([^:/\s*]+)(?::(\d+|\*))?$/i;

interface AllowRule {
  protocol: "http:" | "https:";
  wildcard: boolean;
  host: string;
  /** Digits, `*` for any port, or empty for the scheme default. */
  port: string;
}

function parseAllowRule(pattern: string): AllowRule {
  const match = ORIGIN_PATTERN.exec(pattern.trim());
  if (!match) {
    throw new JsonFlowError(
      "HTTP_URL_INVALID",
      `Invalid URL policy pattern "${pattern}": use scheme://host[:port], e.g. http://localhost:3000`,
      { details: { pattern } },
    );
  }
  const [, scheme = "", wildcard, host = "", port = ""] = match;
  return {
    protocol: scheme.toLowerCase() === "http" ? "http:" : "https:",
    wildcard: wildcard !== undefined,
    host: host.toLowerCase(),
    port,
  };
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function ruleMatches(rule: AllowRule, url: URL): boolean {
  if (rule.protocol !== url.protocol) return false;
  const hostname = url.hostname.toLowerCase();
  const hostOk = rule.wildcard
    ? hostname.endsWith(`.${rule.host}`) && hostname.length > rule.host.length + 1
    : hostname === rule.host;
  if (!hostOk) return false;
  if (rule.port === "*") return true;
  const expectedPort = rule.port === "" ? (rule.protocol === "https:" ? "443" : "80") : rule.port;
  return effectivePort(url) === expectedPort;
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : undefined;
}

/** True for loopback, private, link-local, unspecified, CGNAT and well-known metadata hosts. */
export function isPrivateHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (hostname === "metadata.google.internal") return true;
  const v4 = parseIpv4(hostname);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const v6 = hostname.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link local
    const mapped = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped?.[1] !== undefined) return isPrivateHost(mapped[1]);
    if (/^(?:0*:)*ffff:[0-9a-f]+:[0-9a-f]+$/.test(v6)) return true;
  }
  return false;
}

export class CompiledUrlPolicy {
  private readonly rules: AllowRule[];

  constructor(private readonly policy: UrlPolicy) {
    this.rules = (policy.allow ?? []).map(parseAllowRule);
  }

  check(url: URL): UrlPolicyDecision {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { allowed: false, reason: `protocol ${url.protocol} is not allowed` };
    }
    if (url.username !== "" || url.password !== "") {
      return { allowed: false, reason: "credentials in the URL are not allowed" };
    }
    if (this.rules.some((rule) => ruleMatches(rule, url))) return { allowed: true };
    if (url.protocol === "http:" && this.policy.allowHttp !== true) {
      return {
        allowed: false,
        reason: `plain http is not allowed by default; add "${url.origin}" to urlPolicy.allow or set allowHttp`,
      };
    }
    if (isPrivateHost(url.hostname) && this.policy.allowPrivateNetworks !== true) {
      return {
        allowed: false,
        reason: `private or loopback host "${url.hostname}" is not allowed by default; add "${url.origin}" to urlPolicy.allow or set allowPrivateNetworks`,
      };
    }
    return { allowed: true };
  }
}
