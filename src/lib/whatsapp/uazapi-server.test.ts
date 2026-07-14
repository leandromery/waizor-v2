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
});

describe("uazapiWebhookUrl", () => {
  it("builds the inbound webhook url, collapsing a trailing slash", () => {
    expect(uazapiWebhookUrl("https://v2.waizor.com.br/")).toBe(
      "https://v2.waizor.com.br/api/whatsapp/uazapi/webhook",
    );
  });
});
