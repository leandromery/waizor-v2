import { describe, it, expect } from "vitest";
import { normalizeUazapiMessage, type UazapiMessage } from "./uazapi-normalize";

function msg(over: Partial<UazapiMessage>): UazapiMessage {
  return {
    messageid: "3EB0ABC",
    sender: "5511999999999@s.whatsapp.net",
    senderName: "Ana",
    isGroup: false,
    fromMe: false,
    messageType: "text",
    messageTimestamp: 1672531200000,
    text: "olá",
    ...over,
  };
}

describe("normalizeUazapiMessage — filtering", () => {
  it("drops messages the instance itself sent (fromMe)", () => {
    expect(normalizeUazapiMessage(msg({ fromMe: true }))).toBeNull();
  });

  it("drops group messages (CRM is 1:1)", () => {
    expect(normalizeUazapiMessage(msg({ isGroup: true }))).toBeNull();
  });
});

describe("normalizeUazapiMessage — text", () => {
  it("maps a plain text message and normalizes phone + timestamp", () => {
    const n = normalizeUazapiMessage(msg({}))!;
    expect(n.providerMessageId).toBe("3EB0ABC");
    expect(n.fromPhone).toBe("5511999999999"); // JID suffix stripped
    expect(n.contactName).toBe("Ana");
    expect(n.timestampSeconds).toBe(1672531200); // ms → s
    expect(n.contentType).toBe("text");
    expect(n.contentText).toBe("olá");
    expect(n.mediaUrl).toBeNull();
    expect(n.interactiveReplyId).toBeNull();
    expect(n.reaction).toBeNull();
  });

  it("strips an @lid sender suffix too", () => {
    const n = normalizeUazapiMessage(msg({ sender: "5511999999999@lid" }))!;
    expect(n.fromPhone).toBe("5511999999999");
  });

  it("carries the quoted provider id into replyToProviderMessageId", () => {
    const n = normalizeUazapiMessage(msg({ quoted: "PARENTID" }))!;
    expect(n.replyToProviderMessageId).toBe("PARENTID");
  });
});

describe("normalizeUazapiMessage — media", () => {
  it("maps an image with a caption to contentType image + fileURL verbatim", () => {
    const n = normalizeUazapiMessage(
      msg({ messageType: "imageMessage", text: "veja", fileURL: "https://cdn.uazapi.com/a.jpg" }),
    )!;
    expect(n.contentType).toBe("image");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.jpg");
    expect(n.contentText).toBe("veja");
  });

  it("maps a ptt/audio message to contentType audio", () => {
    const n = normalizeUazapiMessage(
      msg({ messageType: "audioMessage", text: "", fileURL: "https://cdn.uazapi.com/a.ogg" }),
    )!;
    expect(n.contentType).toBe("audio");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.ogg");
  });

  it("maps a document message and keeps the caption text", () => {
    const n = normalizeUazapiMessage(
      msg({ messageType: "documentMessage", text: "contrato", fileURL: "https://cdn.uazapi.com/c.pdf" }),
    )!;
    expect(n.contentType).toBe("document");
  });
});

describe("normalizeUazapiMessage — interactive & reaction", () => {
  it("maps a button/list reply into interactiveReplyId", () => {
    const n = normalizeUazapiMessage(
      msg({ messageType: "buttonsResponseMessage", buttonOrListid: "yes", text: "Sim" }),
    )!;
    expect(n.contentType).toBe("interactive");
    expect(n.interactiveReplyId).toBe("yes");
    expect(n.contentText).toBe("Sim");
  });

  it("maps a reaction to the reaction target id + emoji from text", () => {
    const n = normalizeUazapiMessage(
      msg({ messageType: "reaction", reaction: "TARGETID", text: "👍" }),
    )!;
    expect(n.reaction).toEqual({ targetProviderMessageId: "TARGETID", emoji: "👍" });
  });
});
