import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveUazapiServer, uazapiWebhookUrl } from "./uazapi-server";

describe("resolveUazapiServer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the trimmed base url (no trailing slash) and admin token", () => {
    vi.stubEnv("UAZAPI_SERVER_URL", "https://x.uazapi.com/");
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "ADMIN");
    expect(resolveUazapiServer()).toEqual({ baseUrl: "https://x.uazapi.com", adminToken: "ADMIN" });
  });

  it("throws when the server url is missing", () => {
    vi.stubEnv("UAZAPI_SERVER_URL", "");
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "ADMIN");
    expect(() => resolveUazapiServer()).toThrow(/UAZAPI_SERVER_URL/);
  });

  it("throws when the admin token is missing", () => {
    vi.stubEnv("UAZAPI_SERVER_URL", "https://x.uazapi.com");
    vi.stubEnv("UAZAPI_ADMIN_TOKEN", "");
    expect(() => resolveUazapiServer()).toThrow(/UAZAPI_ADMIN_TOKEN/);
  });
});

describe("uazapiWebhookUrl", () => {
  it("builds the inbound webhook url from the site url, collapsing a trailing slash", () => {
    expect(uazapiWebhookUrl("https://v2.waizor.com.br/")).toBe(
      "https://v2.waizor.com.br/api/whatsapp/uazapi/webhook",
    );
  });
});
