import twilio from "twilio";

import { env, validateChannelConfiguration } from "../config/env";

export type SmsSendInput = {
  to: string;
  body: string;
  statusCallbackUrl?: string;
};

export type SmsSendResult = {
  providerId: string;
  status: "sent" | "queued" | "dry_run";
};

const twilioClient =
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
    ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
    : null;

export async function sendSms(input: SmsSendInput): Promise<SmsSendResult> {
  if (env.DRY_RUN) {
    return {
      providerId: `dryrun-sms-${Date.now()}`,
      status: "dry_run",
    };
  }

  if (!validateChannelConfiguration().sms || !twilioClient) {
    throw new Error("Twilio SMS is not configured. Check TWILIO_* env values.");
  }

  const message = await twilioClient.messages.create({
    to: input.to,
    from: env.TWILIO_PHONE_NUMBER,
    body: input.body,
    statusCallback: input.statusCallbackUrl,
  });

  return {
    providerId: message.sid,
    status: message.status === "queued" ? "queued" : "sent",
  };
}
