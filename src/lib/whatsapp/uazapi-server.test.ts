import { describe, it, expect } from "vitest";
import { normalizeUazapiBaseUrl, uazapiWebhookUrl } from "./uazapi-server";

describe("normalizeUazapiBaseUrl", () => {
  it("trims and strips a trailing slash", () => {
    expect(normalizeUazapiBaseUrl("  https://x.uazapi.com/  ")).toBe("https://x.uazapi.com");
  });

  it("keeps a path-less https url unchanged", () => {
    expect(normalizeUazapiBaseUrl("https://x.uazapi.com")).toBe("https://x.uazapi.com");
  });

  it("rejects an empty value", () => {
    expect(() => normalizeUazapiBaseUrl("")).toThrow(/required/i);
  });

  it("rejects a non-https url", () => {
    expect(() => normalizeUazapiBaseUrl("http://x.uazapi.com")).toThrow(/https/i);
  });

  it("rejects a non-url string", () => {
    expect(() => normalizeUazapiBaseUrl("not a url")).toThrow(/valid/i);
  });

  // SSRF hardening: the server URL is account-admin-supplied and we POST to
  // it, so literal private / loopback / link-local hosts must be refused.
  it.each([
    "https://localhost",
    "https://foo.localhost",
    "https://box.local",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://172.16.9.9",
    "https://192.168.1.10",
    "https://169.254.169.254", // cloud metadata endpoint
    "https://0.0.0.0",
    "https://[::1]", // IPv6 loopback
    "https://[fe80::1]", // IPv6 link-local
    "https://[fc00::1]", // IPv6 unique-local
  ])("rejects the private/loopback/link-local host %s", (url) => {
    expect(() => normalizeUazapiBaseUrl(url)).toThrow(/public host/i);
  });

  it("still accepts a normal public host", () => {
    expect(normalizeUazapiBaseUrl("https://sub.uazapi.com")).toBe("https://sub.uazapi.com");
  });
});

describe("uazapiWebhookUrl", () => {
  it("builds the inbound webhook url, collapsing a trailing slash", () => {
    expect(uazapiWebhookUrl("https://v2.waizor.com.br/")).toBe(
      "https://v2.waizor.com.br/api/whatsapp/uazapi/webhook",
    );
  });
});
