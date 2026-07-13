import { describe, it, expect } from "vitest";
import { getProvider } from "./index";

describe("getProvider", () => {
  it("returns the Meta provider for a meta config", () => {
    expect(getProvider({ provider: "meta" }).id).toBe("meta");
  });

  it("defaults to Meta when the provider is unset (pre-migration rows)", () => {
    expect(getProvider({ provider: undefined as never }).id).toBe("meta");
  });

  it("returns the UAZAPI provider for a uazapi config", () => {
    expect(getProvider({ provider: "uazapi" }).id).toBe("uazapi");
  });
});
