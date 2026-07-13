import { describe, it, expect, vi, beforeEach } from "vitest";
import { uazapiProvider } from "./uazapi";
import type { OutboundContext } from "./types";
import type { WhatsAppConfig } from "@/types";

// Capture the args the adapter passes to the raw HTTP layer so we can
// assert the mapping (our interface → UAZAPI payloads) without a network.
const sendText = vi.fn(async (_a: unknown) => ({ messageId: "m-text" }));
const sendMedia = vi.fn(async (_a: unknown) => ({ messageId: "m-media" }));
const sendMenu = vi.fn(async (_a: unknown) => ({ messageId: "m-menu" }));
vi.mock("@/lib/whatsapp/uazapi-api", () => ({
  sendText: (a: unknown) => sendText(a),
  sendMedia: (a: unknown) => sendMedia(a),
  sendMenu: (a: unknown) => sendMenu(a),
}));
// The instance token is stored encrypted; decrypt is identity in tests.
vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));

function ctx(over: Partial<WhatsAppConfig> = {}): OutboundContext {
  return {
    config: {
      id: "cfg-1",
      provider: "uazapi",
      uazapi_base_url: "https://x.uazapi.com",
      uazapi_instance_token: "enc:inst-token",
      ...over,
    } as unknown as WhatsAppConfig,
    db: {} as never,
  };
}

beforeEach(() => {
  sendText.mockClear();
  sendMedia.mockClear();
  sendMenu.mockClear();
});

describe("uazapiProvider — identity & capabilities", () => {
  it("is the uazapi provider with no templates/broadcast but interactive", () => {
    expect(uazapiProvider.id).toBe("uazapi");
    expect(uazapiProvider.capabilities).toEqual({
      templates: false,
      interactive: true,
      broadcast: false,
    });
  });
});

describe("uazapiProvider — credentials", () => {
  it("throws when the base url or instance token is missing", async () => {
    await expect(
      uazapiProvider.sendText(ctx({ uazapi_base_url: undefined }), { to: "1", text: "x" }),
    ).rejects.toThrow(/base url|instance token/i);
  });
});

describe("uazapiProvider — sendText", () => {
  it("maps to uazapi sendText with the decrypted token and reply target", async () => {
    const res = await uazapiProvider.sendText(ctx(), {
      to: "5511999",
      text: "oi",
      contextMessageId: "PARENT",
    });
    expect(sendText).toHaveBeenCalledWith({
      baseUrl: "https://x.uazapi.com",
      token: "inst-token",
      number: "5511999",
      text: "oi",
      replyid: "PARENT",
    });
    expect(res.messageId).toBe("m-text");
  });
});

describe("uazapiProvider — sendMedia", () => {
  it("maps MediaKind→type, link→file, caption→text, filename→docName", async () => {
    await uazapiProvider.sendMedia(ctx(), {
      to: "5511999",
      kind: "document",
      link: "https://cdn/x.pdf",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(sendMedia).toHaveBeenCalledWith({
      baseUrl: "https://x.uazapi.com",
      token: "inst-token",
      number: "5511999",
      type: "document",
      file: "https://cdn/x.pdf",
      text: "invoice",
      docName: "invoice.pdf",
    });
  });
});

describe("uazapiProvider — sendInteractive", () => {
  it("encodes buttons as title|id and body→text, footer→footerText", async () => {
    await uazapiProvider.sendInteractive(ctx(), {
      to: "5511999",
      payload: {
        kind: "buttons",
        body: "Escolha",
        footer: "rodapé",
        buttons: [
          { id: "yes", title: "Sim" },
          { id: "no", title: "Não" },
        ],
      },
    });
    expect(sendMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        number: "5511999",
        type: "button",
        text: "Escolha",
        footerText: "rodapé",
        choices: ["Sim|yes", "Não|no"],
      }),
    );
  });

  it("prepends a header to the body text when present", async () => {
    await uazapiProvider.sendInteractive(ctx(), {
      to: "5511999",
      payload: { kind: "buttons", body: "Corpo", header: "Título", buttons: [{ id: "a", title: "A" }] },
    });
    expect(sendMenu).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Título\n\nCorpo" }),
    );
  });

  it("encodes list sections as [Section] and rows as title|id|description", async () => {
    await uazapiProvider.sendInteractive(ctx(), {
      to: "5511999",
      payload: {
        kind: "list",
        body: "Catálogo",
        button_label: "Ver",
        sections: [
          {
            title: "Eletrônicos",
            rows: [
              { id: "phones", title: "Smartphones", description: "Novos" },
              { id: "notes", title: "Notebooks" },
            ],
          },
        ],
      },
    });
    expect(sendMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "list",
        listButton: "Ver",
        choices: ["[Eletrônicos]", "Smartphones|phones|Novos", "Notebooks|notes"],
      }),
    );
  });
});
