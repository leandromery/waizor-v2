import { describe, it, expect } from "vitest";
import { normalizeUazapiMessage, type UazapiMessage } from "./uazapi-normalize";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";

// A real inbound text message from UAZAPI (fields trimmed to what we read).
// Note: `sender` is the LID; the real phone lives in `sender_pn` / `chatid`.
function msg(over: Partial<UazapiMessage>): UazapiMessage {
  return {
    messageid: "3EB0EBAE153BA28D1F721B",
    sender: "215319780020428@lid",
    sender_pn: "554888060473@s.whatsapp.net",
    chatid: "554888060473@s.whatsapp.net",
    senderName: "Leandro Freitas",
    isGroup: false,
    fromMe: false,
    type: "text",
    messageType: "Conversation",
    messageTimestamp: 1784070248000,
    text: "oie",
    content: "oie",
    quoted: "",
    reaction: "",
    buttonOrListid: "",
    mediaType: "",
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
  it("uses sender_pn (the real phone), NOT sender (the LID)", () => {
    const n = normalizeUazapiMessage(msg({}))!;
    expect(n.fromPhone).toBe(normalizePhone("554888060473"));
    expect(n.fromPhone).not.toContain("215319780020428");
  });

  it("falls back to chatid when sender_pn is absent", () => {
    const n = normalizeUazapiMessage(msg({ sender_pn: undefined }))!;
    expect(n.fromPhone).toBe(normalizePhone("554888060473"));
  });

  it("maps the core text fields", () => {
    const n = normalizeUazapiMessage(msg({}))!;
    expect(n.providerMessageId).toBe("3EB0EBAE153BA28D1F721B");
    expect(n.contactName).toBe("Leandro Freitas");
    expect(n.timestampSeconds).toBe(1784070248); // ms → s
    expect(n.contentType).toBe("text");
    expect(n.contentText).toBe("oie");
    expect(n.mediaUrl).toBeNull();
    expect(n.interactiveReplyId).toBeNull();
    expect(n.replyToProviderMessageId).toBeNull();
    expect(n.reaction).toBeNull();
  });

  it("treats empty-string quoted/reaction/buttonOrListid as absent (null)", () => {
    const n = normalizeUazapiMessage(msg({ quoted: "", reaction: "", buttonOrListid: "" }))!;
    expect(n.replyToProviderMessageId).toBeNull();
    expect(n.interactiveReplyId).toBeNull();
    expect(n.reaction).toBeNull();
  });

  it("carries a non-empty quoted into replyToProviderMessageId", () => {
    const n = normalizeUazapiMessage(msg({ quoted: "PARENTID" }))!;
    expect(n.replyToProviderMessageId).toBe("PARENTID");
  });
});

describe("normalizeUazapiMessage — media", () => {
  it("maps an image with a fileURL", () => {
    const n = normalizeUazapiMessage(
      msg({ type: "image", messageType: "imageMessage", mediaType: "image", text: "veja", fileURL: "https://cdn.uazapi.com/a.jpg" }),
    )!;
    expect(n.contentType).toBe("image");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.jpg");
    expect(n.contentText).toBe("veja");
  });

  it("maps an audio/ptt message", () => {
    const n = normalizeUazapiMessage(
      msg({ type: "ptt", messageType: "audioMessage", mediaType: "ptt", text: "", fileURL: "https://cdn.uazapi.com/a.ogg" }),
    )!;
    expect(n.contentType).toBe("audio");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.ogg");
  });
});

describe("normalizeUazapiMessage — interactive & reaction", () => {
  it("maps a button/list reply into interactiveReplyId", () => {
    const n = normalizeUazapiMessage(msg({ buttonOrListid: "yes", text: "Sim" }))!;
    expect(n.contentType).toBe("interactive");
    expect(n.interactiveReplyId).toBe("yes");
    expect(n.contentText).toBe("Sim");
  });

  it("maps a reaction to its target id + emoji from text", () => {
    const n = normalizeUazapiMessage(msg({ reaction: "TARGETID", text: "👍" }))!;
    expect(n.reaction).toEqual({ targetProviderMessageId: "TARGETID", emoji: "👍" });
  });
});
