import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendText,
  sendMedia,
  sendMenu,
  createInstance,
  connectInstance,
  getInstanceStatus,
  disconnectInstance,
  configureWebhook,
} from "./uazapi-api";

// Capture the request each helper makes so we can assert the exact URL,
// auth header, and JSON body shape without hitting a real UAZAPI server.
interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let captured: Captured | null = null;

function okFetch(json: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : null,
    };
    return { ok: true, json: async () => json } as Response;
  });
}

const BASE = { baseUrl: "https://x.uazapi.com", token: "inst-token" } as const;

describe("uazapi-api — send helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sendText POSTs /send/text with the instance token and returns messageid", async () => {
    vi.stubGlobal("fetch", okFetch({ messageid: "3EB0ABC", response: { status: "success" } }));
    const res = await sendText({ ...BASE, number: "5511999", text: "oi" });

    expect(captured?.url).toBe("https://x.uazapi.com/send/text");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.token).toBe("inst-token");
    expect(captured?.body).toEqual({ number: "5511999", text: "oi" });
    expect(res.messageId).toBe("3EB0ABC");
  });

  it("sendText includes replyid only when a reply target is given", async () => {
    vi.stubGlobal("fetch", okFetch({ messageid: "id1" }));
    await sendText({ ...BASE, number: "5511999", text: "re", replyid: "PARENT" });
    expect(captured?.body?.replyid).toBe("PARENT");
  });

  it("sendMedia POSTs /send/media with type/file/caption/docName", async () => {
    vi.stubGlobal("fetch", okFetch({ messageid: "m1" }));
    await sendMedia({
      ...BASE,
      number: "5511999",
      type: "document",
      file: "https://cdn/x.pdf",
      text: "invoice",
      docName: "invoice.pdf",
    });
    expect(captured?.url).toBe("https://x.uazapi.com/send/media");
    expect(captured?.body).toEqual({
      number: "5511999",
      type: "document",
      file: "https://cdn/x.pdf",
      text: "invoice",
      docName: "invoice.pdf",
    });
  });

  it("sendMenu POSTs /send/menu with choices verbatim", async () => {
    vi.stubGlobal("fetch", okFetch({ messageid: "menu1" }));
    await sendMenu({
      ...BASE,
      number: "5511999",
      type: "button",
      text: "pick",
      footerText: "foot",
      choices: ["Yes|yes", "No|no"],
    });
    expect(captured?.url).toBe("https://x.uazapi.com/send/menu");
    expect(captured?.body).toEqual({
      number: "5511999",
      type: "button",
      text: "pick",
      footerText: "foot",
      choices: ["Yes|yes", "No|no"],
    });
  });

  it("throws with the API error message on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "Invalid token" }) }) as Response),
    );
    await expect(sendText({ ...BASE, number: "1", text: "x" })).rejects.toThrow("Invalid token");
  });
});

describe("uazapi-api — instance lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("createInstance POSTs /instance/create with the admintoken and returns id+token", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ instance: { id: "inst-1", token: "tok-1", status: "disconnected" }, token: "tok-1" }),
    );
    const inst = await createInstance({ baseUrl: BASE.baseUrl, adminToken: "ADMIN", name: "waizor" });

    expect(captured?.url).toBe("https://x.uazapi.com/instance/create");
    expect(captured?.headers.admintoken).toBe("ADMIN");
    expect(captured?.body).toEqual({ name: "waizor" });
    expect(inst.id).toBe("inst-1");
    expect(inst.token).toBe("tok-1");
  });

  it("createInstance falls back to the top-level token when instance.token is absent", async () => {
    vi.stubGlobal("fetch", okFetch({ instance: { id: "inst-2", status: "disconnected" }, token: "top-tok" }));
    const inst = await createInstance({ baseUrl: BASE.baseUrl, adminToken: "ADMIN", name: "w" });
    expect(inst.token).toBe("top-tok");
  });

  it("connectInstance POSTs /instance/connect and returns the instance with its qrcode", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({ instance: { id: "inst-1", status: "connecting", qrcode: "data:image/png;base64,AAA" } }),
    );
    const inst = await connectInstance(BASE);
    expect(captured?.url).toBe("https://x.uazapi.com/instance/connect");
    expect(captured?.headers.token).toBe("inst-token");
    expect(inst.status).toBe("connecting");
    expect(inst.qrcode).toBe("data:image/png;base64,AAA");
  });

  it("getInstanceStatus GETs /instance/status and returns the instance + paired number", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch({
        instance: { id: "inst-1", status: "connected", profileName: "Loja" },
        status: { connected: true, loggedIn: true, jid: { user: "5511999999999", server: "s.whatsapp.net" } },
      }),
    );
    const res = await getInstanceStatus(BASE);
    expect(captured?.url).toBe("https://x.uazapi.com/instance/status");
    expect(captured?.method).toBe("GET");
    expect(res.instance.status).toBe("connected");
    expect(res.instance.profileName).toBe("Loja");
    expect(res.connected).toBe(true);
    expect(res.waNumber).toBe("5511999999999");
  });

  it("disconnectInstance POSTs /instance/disconnect", async () => {
    vi.stubGlobal("fetch", okFetch({}));
    await disconnectInstance(BASE);
    expect(captured?.url).toBe("https://x.uazapi.com/instance/disconnect");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.token).toBe("inst-token");
  });

  it("configureWebhook POSTs /webhook enabled with url, plural events, and excludeMessages", async () => {
    vi.stubGlobal("fetch", okFetch({}));
    await configureWebhook({
      ...BASE,
      url: "https://app/api/whatsapp/uazapi/webhook",
      events: ["messages", "connection"],
      excludeMessages: ["wasSentByApi"],
    });
    expect(captured?.url).toBe("https://x.uazapi.com/webhook");
    // enabled:true is REQUIRED — UAZAPI's webhook `enabled` defaults to false,
    // so omitting it registers a disabled webhook that never delivers.
    expect(captured?.body).toEqual({
      enabled: true,
      url: "https://app/api/whatsapp/uazapi/webhook",
      events: ["messages", "connection"],
      excludeMessages: ["wasSentByApi"],
    });
  });
});
