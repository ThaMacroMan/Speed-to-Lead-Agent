import sgMail from "@sendgrid/mail";

import { env, validateChannelConfiguration } from "../config/env";

export type EmailSendInput = {
  to: string;
  subject: string;
  text: string;
};

export type EmailSendResult = {
  providerId: string;
  status: "accepted" | "dry_run";
};

if (env.SENDGRID_API_KEY) {
  sgMail.setApiKey(env.SENDGRID_API_KEY);
}

export async function sendEmail(
  input: EmailSendInput,
): Promise<EmailSendResult> {
  if (env.DRY_RUN) {
    return {
      providerId: `dryrun-email-${Date.now()}`,
      status: "dry_run",
    };
  }

  if (!validateChannelConfiguration().email) {
    throw new Error(
      "SendGrid email is not configured. Check SENDGRID_* env values.",
    );
  }

  const [response] = await sgMail.send({
    to: input.to,
    from: {
      email: env.SENDGRID_FROM_EMAIL,
      name: env.SENDGRID_FROM_NAME,
    },
    subject: input.subject,
    text: input.text,
  });

  const requestId = response.headers["x-message-id"];
  return {
    providerId: Array.isArray(requestId)
      ? requestId[0]
      : String(requestId ?? `email-${Date.now()}`),
    status: "accepted",
  };
}
