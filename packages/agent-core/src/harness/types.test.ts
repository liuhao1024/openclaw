import { describe, expect, it } from "vitest";
import { toError } from "./types.js";

describe("toError", () => {
  it("normalizes hostile non-Error values without stringifying them", () => {
    const hostile = {
      toJSON() {
        throw new Error("json denied");
      },
      toString() {
        throw new Error("stringification denied");
      },
    };

    const error = toError(hostile);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Unknown thrown value");
  });
});
