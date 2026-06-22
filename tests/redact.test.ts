import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts an OpenAI-style key", () => {
    const { text, counts } = redactSecrets("token sk-abcdef0123456789ABCDEFGHIJ done");
    expect(text).not.toContain("sk-abcdef0123456789");
    expect(text).toContain("«redacted:openai-key»");
    expect(counts["openai-key"]).toBe(1);
  });

  it("redacts an AWS access key id", () => {
    const { text, counts } = redactSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(text).toBe("«redacted:aws-access-key»");
    expect(counts["aws-access-key"]).toBe(1);
  });

  it("redacts a GitHub token", () => {
    const { text, counts } = redactSecrets("ghp_1234567890abcdefghij1234567890");
    expect(text).toContain("«redacted:github-token»");
    expect(counts["github-token"]).toBe(1);
  });

  it("redacts a Slack token", () => {
    // Assembled at runtime so the source has no coherent token literal (secret
    // scanners flag inline Slack tokens even in test fixtures); the runtime
    // value still matches the redactor's pattern.
    const slackToken = `xoxb-${"1".repeat(12)}-${"abcd".repeat(4)}`;
    const { counts } = redactSecrets(slackToken);
    expect(counts["slack-token"]).toBe(1);
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { text, counts } = redactSecrets(`auth ${jwt}`);
    expect(text).not.toContain(jwt);
    expect(counts["jwt"]).toBe(1);
  });

  it("redacts a PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBmid\ndle+lines\n-----END RSA PRIVATE KEY-----";
    const { text, counts } = redactSecrets(`key:\n${pem}\nafter`);
    expect(text).not.toContain("MIIBmid");
    expect(text).toContain("«redacted:pem-block»");
    expect(text).toContain("after");
    expect(counts["pem-block"]).toBe(1);
  });

  it("redacts a Bearer token", () => {
    const { counts } = redactSecrets("Bearer abcdefghij1234567890");
    expect(counts["bearer-token"]).toBe(1);
  });

  it("redacts an Authorization header", () => {
    const { text, counts } = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(text).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(counts["authorization-header"]).toBe(1);
  });

  it("redacts credentials embedded in a URL", () => {
    const { text, counts } = redactSecrets("https://admin:s3cr3tPass@example.com/path");
    expect(text).toBe("https://«redacted:url-credentials»@example.com/path");
    expect(counts["url-credentials"]).toBe(1);
  });

  it("redacts a generic secret assignment", () => {
    const { text, counts } = redactSecrets('password = "hunter2longvalue"');
    expect(text).not.toContain("hunter2longvalue");
    expect(counts["secret-assignment"]).toBe(1);
  });

  it("leaves ordinary text untouched and reports no counts", () => {
    const input = "The user asked to refactor the login flow and ran the tests.";
    const { text, counts } = redactSecrets(input);
    expect(text).toBe(input);
    expect(counts).toEqual({});
  });

  it("does NOT redact PII such as emails (kept for debugging)", () => {
    const input = "contact alice@example.com about the ticket";
    const { text } = redactSecrets(input);
    expect(text).toContain("alice@example.com");
  });

  it("counts multiple occurrences of the same kind", () => {
    const { counts } = redactSecrets(
      "sk-aaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbb",
    );
    expect(counts["openai-key"]).toBe(2);
  });
});
