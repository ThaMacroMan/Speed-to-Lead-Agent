import twilio from "twilio";

import { env, validateChannelConfiguration } from "../config/env";

export type VoiceDropInput = {
  to: string;
  message: string;
  statusCallbackUrl?: string;
};

export type VoiceDropResult = {
  providerId: string;
  status: "queued" | "dry_run";
};

const twilioClient =
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
    ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
    : null;

export async function sendVoicemailDrop(
  input: VoiceDropInput,
): Promise<VoiceDropResult> {
  if (env.DRY_RUN) {
    return {
      providerId: `dryrun-voice-${Date.now()}`,
      status: "dry_run",
    };
  }

  if (!validateChannelConfiguration().voice || !twilioClient) {
    throw new Error(
      "Twilio Voice is not configured. Check TWILIO_* env values.",
    );
  }

  const twiml = `<Response><Say voice="alice">${escapeForXml(input.message)}</Say></Response>`;
  const call = await twilioClient.calls.create({
    to: input.to,
    from: env.TWILIO_PHONE_NUMBER,
    twiml,
    statusCallback: input.statusCallbackUrl,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });

  return {
    providerId: call.sid,
    status: "queued",
  };
}

function escapeForXml(content: string): string {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
