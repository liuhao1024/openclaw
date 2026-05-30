import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WebInboundMessage } from "../../inbound/types.js";

const WHATSAPP_AUDIO_PLACEHOLDER_BODY = "<media:audio>";

type WhatsAppAudioPreflightRuntime = typeof import("./audio-preflight.runtime.js");

let whatsappAudioPreflightRuntimePromise: Promise<WhatsAppAudioPreflightRuntime> | undefined;

function loadWhatsAppAudioPreflightRuntime(): Promise<WhatsAppAudioPreflightRuntime> {
  whatsappAudioPreflightRuntimePromise ??= import("./audio-preflight.runtime.js");
  return whatsappAudioPreflightRuntimePromise;
}

export type WhatsAppAudioPreflightInput = {
  ctx: {
    MediaPaths: string[];
    MediaTypes: string[];
    From: string;
    To: string;
    Provider: "whatsapp";
    Surface: "whatsapp";
    OriginatingChannel: "whatsapp";
    OriginatingTo: string;
    AccountId: string;
  };
};

export type WhatsAppAudioPreflightInputResolution =
  | { kind: "available"; input: WhatsAppAudioPreflightInput }
  | { kind: "not_audio" };

export type WhatsAppAudioPreflightResult =
  | { kind: "not_provided" }
  | { kind: "not_audio" }
  | { kind: "transcript"; transcript: string }
  | { kind: "no_transcript" };

export const WHATSAPP_AUDIO_PREFLIGHT_NOT_PROVIDED: WhatsAppAudioPreflightResult = {
  kind: "not_provided",
};

export const WHATSAPP_AUDIO_PREFLIGHT_NOT_AUDIO: WhatsAppAudioPreflightResult = {
  kind: "not_audio",
};

export function resolveWhatsAppAudioPreflightTranscript(
  result: WhatsAppAudioPreflightResult,
): string | undefined {
  return result.kind === "transcript" ? result.transcript : undefined;
}

export function resolveWhatsAppAudioPreflightInput(params: {
  msg: WebInboundMessage;
}): WhatsAppAudioPreflightInputResolution {
  const media = params.msg.payload.media;
  if (
    media?.type?.startsWith("audio/") !== true ||
    params.msg.payload.body !== WHATSAPP_AUDIO_PLACEHOLDER_BODY ||
    !media.path
  ) {
    return { kind: "not_audio" };
  }

  const admission = params.msg.admission;
  const conversationId = admission.conversation.id;
  return {
    kind: "available",
    input: {
      ctx: {
        MediaPaths: [media.path],
        MediaTypes: [media.type],
        From: conversationId,
        To: params.msg.platform.recipientJid,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
        AccountId: admission.accountId,
      },
    },
  };
}

export async function transcribeWhatsAppAudioPreflight(params: {
  input: WhatsAppAudioPreflightInput;
  cfg: OpenClawConfig;
  onError?: () => void;
}): Promise<WhatsAppAudioPreflightResult> {
  try {
    const { transcribeFirstAudio } = await loadWhatsAppAudioPreflightRuntime();
    const transcript = await transcribeFirstAudio({
      ctx: params.input.ctx,
      cfg: params.cfg,
    });
    return transcript !== undefined
      ? { kind: "transcript", transcript }
      : { kind: "no_transcript" };
  } catch {
    params.onError?.();
    return { kind: "no_transcript" };
  }
}
