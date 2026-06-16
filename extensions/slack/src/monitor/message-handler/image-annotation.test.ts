// Verification for image annotation utility.
import { describe, expect, it } from "vitest";
import {
  buildImageAnnotation,
  hasImageFiles,
  isImageFile,
} from "./image-annotation.js";

describe("isImageFile", () => {
  it("returns true for image MIME type", () => {
    expect(isImageFile({ mimetype: "image/png", name: "photo.png" })).toBe(true);
    expect(isImageFile({ mimetype: "image/jpeg" })).toBe(true);
    expect(isImageFile({ mimetype: "IMAGE/GIF" })).toBe(true);
  });

  it("returns true for image file extension", () => {
    expect(isImageFile({ name: "screenshot.png" })).toBe(true);
    expect(isImageFile({ name: "photo.jpg" })).toBe(true);
    expect(isImageFile({ name: "animation.gif" })).toBe(true);
    expect(isImageFile({ name: "modern.webp" })).toBe(true);
    expect(isImageFile({ name: "vector.svg" })).toBe(true);
    expect(isImageFile({ name: "pic.HEIC" })).toBe(true);
  });

  it("returns false for non-image files", () => {
    expect(isImageFile({ mimetype: "application/pdf", name: "doc.pdf" })).toBe(false);
    expect(isImageFile({ mimetype: "text/plain", name: "readme.txt" })).toBe(false);
    expect(isImageFile({ name: "data.csv" })).toBe(false);
  });

  it("returns false when no mimetype or name", () => {
    expect(isImageFile({})).toBe(false);
  });
});

describe("hasImageFiles", () => {
  it("returns true when files contain an image", () => {
    expect(hasImageFiles([{ mimetype: "image/png" }])).toBe(true);
  });

  it("returns false when files are all non-images", () => {
    expect(hasImageFiles([{ mimetype: "application/pdf" }])).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasImageFiles(undefined)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasImageFiles([])).toBe(false);
  });
});

describe("buildImageAnnotation", () => {
  it("formats annotation with all fields", () => {
    const result = buildImageAnnotation({
      totalMessages: 8,
      messageIndex: 1,
      timestamp: "1710590400",
      author: "alice (user)",
      timezone: "UTC",
    });
    expect(result).toContain("Image — sent");
    expect(result).toContain("message 1 of 8 in thread");
    expect(result).toContain("from alice (user)");
    expect(result).not.toContain("unknown time");
  });

  it("handles missing timestamp gracefully", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
    });
    expect(result).toContain("unknown time");
    expect(result).toContain("message 2 of 3 in thread");
    expect(result).not.toContain("undefined");
  });

  it("omits author clause when author is absent", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
      timestamp: "1710590400",
    });
    expect(result).not.toContain("from");
  });

  it("omits author clause when author is empty string", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
      timestamp: "1710590400",
      author: "  ",
    });
    expect(result).not.toContain("from");
  });

  it('shows "standalone message" for single-message threads', () => {
    const result = buildImageAnnotation({
      totalMessages: 1,
      messageIndex: 1,
      timestamp: "1710590400",
      author: "bob",
    });
    expect(result).toContain("standalone message");
    expect(result).not.toContain("of 1 in thread");
  });

  it("handles Slack-style decimal timestamp", () => {
    const result = buildImageAnnotation({
      totalMessages: 5,
      messageIndex: 3,
      timestamp: "1710590400.123456",
      timezone: "UTC",
    });
    expect(result).not.toContain("unknown time");
    expect(result).toContain("message 3 of 5 in thread");
  });

  it("handles empty timestamp string", () => {
    const result = buildImageAnnotation({
      totalMessages: 2,
      messageIndex: 1,
      timestamp: "",
    });
    expect(result).toContain("unknown time");
  });

  it("uses UTC as default timezone", () => {
    const result = buildImageAnnotation({
      totalMessages: 2,
      messageIndex: 1,
      timestamp: "1710590400",
    });
    expect(result).toContain("Image — sent");
    expect(result).not.toContain("unknown time");
  });
});
