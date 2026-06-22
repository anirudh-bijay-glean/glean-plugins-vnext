// Best-effort credential/secret scrubbing for captured session transcripts.
//
// The CISO requirement is to redact CREDENTIALS before a transcript leaves the
// machine; PII (names, emails, etc.) is intentionally left intact because it
// can aid debugging. This is a best-effort regex pass — not a guarantee — so
// the capture flow must still treat the source as potentially sensitive. A
// production pass would layer a dedicated PII/secret engine (e.g. Presidio) on
// top; see the PII extension point at the bottom of REDACTORS.

export interface RedactionResult {
  text: string;
  // Number of matches replaced, keyed by redactor kind. Kinds with zero
  // matches are omitted so the summary stays compact.
  counts: Record<string, number>;
}

interface Redactor {
  kind: string;
  pattern: RegExp; // must be global (/g) so replace() visits every match
  // Replacement may use capture groups; the literal placeholder marks where a
  // secret was removed. The guillemets are excluded from value char-classes
  // below so an already-redacted span is never re-wrapped by a later rule.
  replacement: string | ((match: string, ...groups: string[]) => string);
}

const placeholder = (kind: string) => `«redacted:${kind}»`;

// Ordered most-structured first. Specific token shapes and multi-line blocks
// run before the generic key=value rule so the precise kind is recorded and
// the generic rule doesn't clobber it.
const REDACTORS: Redactor[] = [
  // PEM / OpenSSH key blocks (private keys, certificates).
  {
    kind: "pem-block",
    pattern: /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g,
    replacement: placeholder("pem-block"),
  },
  // JSON Web Tokens (header.payload.signature).
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: placeholder("jwt"),
  },
  // OpenAI-style keys (sk-, sk-proj-, etc.).
  {
    kind: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: placeholder("openai-key"),
  },
  // AWS access key ids.
  {
    kind: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: placeholder("aws-access-key"),
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  {
    kind: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: placeholder("github-token"),
  },
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-).
  {
    kind: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: placeholder("slack-token"),
  },
  // Google API keys.
  {
    kind: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: placeholder("google-api-key"),
  },
  // Credentials embedded in a URL authority (scheme://user:pass@host).
  {
    kind: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi,
    replacement: (_m, scheme: string) => `${scheme}${placeholder("url-credentials")}@`,
  },
  // Bearer tokens.
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    replacement: `Bearer ${placeholder("bearer-token")}`,
  },
  // Authorization headers (any scheme, e.g. "Basic <b64>"). Capture the whole
  // value to end-of-line or a closing quote so the scheme AND the credential go.
  {
    kind: "authorization-header",
    pattern: /\bAuthorization\s*[:=]\s*[^\r\n'"]+/gi,
    replacement: `Authorization: ${placeholder("authorization-header")}`,
  },
  // Generic `key = value` / `key: value` secret assignments. The value class
  // excludes the guillemets so a span already replaced above is not re-wrapped.
  {
    kind: "secret-assignment",
    pattern:
      /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*["']?)([^\s"',«»]{6,})/gi,
    replacement: (_m, key: string, sep: string) =>
      `${key}${sep}${placeholder("secret-assignment")}`,
  },
  // PII extension point: a future pass (e.g. Presidio) for names/emails/phones
  // would be appended here. Deliberately omitted — PII may be sent if it helps
  // debugging (per the security review), so it is NOT redacted by default.
];

export function redactSecrets(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  for (const { kind, pattern, replacement } of REDACTORS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return typeof replacement === "function"
        ? (replacement as (...a: string[]) => string)(...(args.slice(0, -2) as string[]))
        : replacement;
    });
  }
  return { text: out, counts };
}
