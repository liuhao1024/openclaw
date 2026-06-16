// Slack plugin module implements image annotation for thread history.
// Injects temporal metadata before image references so the model can reason
// about image freshness relative to the conversation flow.
import type { SlackFile } from "../../types.js";

/** Image MIME type prefixes that indicate a visual image file. */
const IMAGE_MIME_PREFIX = "image/";

/** Common image file extensions. */
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg)$/i;

/** Check whether a Slack file looks like an image based on its MIME type or name. */
export function isImageFile(file: SlackFile): boolean {
  if (file.mimetype?.toLowerCase().startsWith(IMAGE_MIME_PREFIX)) {
    return true;
  }
  const name = file.name?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_RE.test(name);
}

/** Check whether a list of Slack files contains at least one image. */
export function hasImageFiles(files: SlackFile[] | undefined): boolean {
  return files?.some(isImageFile) ?? false;
}

/**
 * Format a Slack-style decimal-seconds timestamp (e.g. "1710590400.123456")
 * into a human-readable date string like "Mon 2026-03-16 10:50 EDT".
 *
 * Falls back to "unknown time" when the timestamp is missing or invalid.
 */
function formatTimestamp(ts: string | undefined, timezone: string): string {
  if (!ts) {
    return "unknown time";
  }
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "unknown time";
  }
  const ms = seconds < 1e12 ? seconds * 1000 : seconds;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  try {
    return date.toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    // Invalid timezone — fall back to UTC.
    return date.toLocaleString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
}

/**
 * Build a metadata annotation line for an image in thread history.
 *
 * Format: `[Image — sent <date>, message N of M in thread, from <author>]`
 * Single-message threads use "standalone message" instead of "N of M in thread".
 *
 * This gives the model temporal context so it can reason about image freshness
 * rather than treating all images as equally current.
 */
export function buildImageAnnotation(params: {
  totalMessages: number;
  messageIndex: number;
  timestamp?: string;
  author?: string;
  timezone?: string;
}): string {
  const timezone = params.timezone ?? "UTC";
  const date = formatTimestamp(params.timestamp, timezone);

  const position =
    params.totalMessages <= 1
      ? "standalone message"
      : `message ${params.messageIndex} of ${params.totalMessages} in thread`;

  const author = params.author?.trim();
  const authorClause = author ? `, from ${author}` : "";

  return `[Image — sent ${date}, ${position}${authorClause}]`;
}
