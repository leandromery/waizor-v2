import { describe, it, expect, vi } from "vitest";
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
    quoted: "",
    reaction: "",
    buttonOrListid: "",
    mediaType: "",
    ...over,
  };
}

describe("normalizeUazapiMessage — filtering", () => {
  it("drops messages the instance itself sent (fromMe)", async () => {
    expect(await normalizeUazapiMessage(msg({ fromMe: true }))).toBeNull();
  });
  it("drops group messages (CRM is 1:1)", async () => {
    expect(await normalizeUazapiMessage(msg({ isGroup: true }))).toBeNull();
  });
});

describe("normalizeUazapiMessage — text", () => {
  it("uses sender_pn (the real phone), NOT sender (the LID)", async () => {
    const n = (await normalizeUazapiMessage(msg({})))!;
    expect(n.fromPhone).toBe(normalizePhone("554888060473"));
    expect(n.fromPhone).not.toContain("215319780020428");
  });

  it("falls back to chatid when sender_pn is absent", async () => {
    const n = (await normalizeUazapiMessage(msg({ sender_pn: undefined })))!;
    expect(n.fromPhone).toBe(normalizePhone("554888060473"));
  });

  it("maps the core text fields", async () => {
    const n = (await normalizeUazapiMessage(msg({})))!;
    expect(n.providerMessageId).toBe("3EB0EBAE153BA28D1F721B");
    expect(n.contactName).toBe("Leandro Freitas");
    expect(n.timestampSeconds).toBe(1784070248);
    expect(n.contentType).toBe("text");
    expect(n.contentText).toBe("oie");
    expect(n.mediaUrl).toBeNull();
    expect(n.interactiveReplyId).toBeNull();
    expect(n.replyToProviderMessageId).toBeNull();
    expect(n.reaction).toBeNull();
  });

  it("treats empty-string quoted/reaction/buttonOrListid as absent (null)", async () => {
    const n = (await normalizeUazapiMessage(msg({ quoted: "", reaction: "", buttonOrListid: "" })))!;
    expect(n.replyToProviderMessageId).toBeNull();
    expect(n.interactiveReplyId).toBeNull();
    expect(n.reaction).toBeNull();
  });

  it("carries a non-empty quoted into replyToProviderMessageId", async () => {
    const n = (await normalizeUazapiMessage(msg({ quoted: "PARENTID" })))!;
    expect(n.replyToProviderMessageId).toBe("PARENTID");
  });

  it("does NOT resolve media for a text message", async () => {
    const resolveMedia = vi.fn(async () => "https://x/should-not-be-called");
    const n = (await normalizeUazapiMessage(msg({}), resolveMedia))!;
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(n.mediaUrl).toBeNull();
  });
});

describe("normalizeUazapiMessage — media (resolved via callback)", () => {
  it("classifies an audio/ptt message and resolves its URL by messageid", async () => {
    const resolveMedia = vi.fn(async () => "https://cdn.uazapi.com/a.ogg");
    const n = (await normalizeUazapiMessage(
      msg({ type: "media", messageType: "AudioMessage", mediaType: "ptt", text: "" }),
      resolveMedia,
    ))!;
    expect(n.contentType).toBe("audio");
    expect(resolveMedia).toHaveBeenCalledWith("3EB0EBAE153BA28D1F721B");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.ogg");
  });

  it("classifies an image message and resolves its URL", async () => {
    const resolveMedia = vi.fn(async () => "https://cdn.uazapi.com/a.jpg");
    const n = (await normalizeUazapiMessage(
      msg({ type: "media", messageType: "ImageMessage", mediaType: "image", text: "veja" }),
      resolveMedia,
    ))!;
    expect(n.contentType).toBe("image");
    expect(n.mediaUrl).toBe("https://cdn.uazapi.com/a.jpg");
    expect(n.contentText).toBe("veja");
  });

  it("leaves mediaUrl null when no resolver is supplied", async () => {
    const n = (await normalizeUazapiMessage(
      msg({ type: "media", messageType: "AudioMessage", mediaType: "ptt", text: "" }),
    ))!;
    expect(n.contentType).toBe("audio");
    expect(n.mediaUrl).toBeNull();
  });
});

describe("normalizeUazapiMessage — interactive & reaction", () => {
  it("maps a button/list reply into interactiveReplyId", async () => {
    const n = (await normalizeUazapiMessage(msg({ buttonOrListid: "yes", text: "Sim" })))!;
    expect(n.contentType).toBe("interactive");
    expect(n.interactiveReplyId).toBe("yes");
    expect(n.contentText).toBe("Sim");
  });

  it("maps a reaction to its target id + emoji from text", async () => {
    const n = (await normalizeUazapiMessage(msg({ reaction: "TARGETID", text: "👍" })))!;
    expect(n.reaction).toEqual({ targetProviderMessageId: "TARGETID", emoji: "👍" });
  });
});
