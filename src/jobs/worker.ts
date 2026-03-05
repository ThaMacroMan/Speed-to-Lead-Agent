import { runInboundFlow } from "../agent/orchestrator";
import { sendEmail } from "../channels/sendgridEmail";
import { sendSms } from "../channels/twilioSms";
import { sendVoicemailDrop } from "../channels/twilioVoice";
import { validateChannelConfiguration } from "../config/env";
import { createBackupSnapshot } from "./backups";
import { runFollowupStep } from "./followups";
import { createAgentWorker, type AgentWorkerJob } from "./queue";
import {
  appendDecision,
  appendMessage,
  getFollowUps,
  getLead,
  updateFollowUps,
} from "../storage/leadStore";
import type { AgentJobPayloadMap } from "./queue";

export function startWorkers() {
  const worker = createAgentWorker(async (job: AgentWorkerJob) => {
    switch (job.name) {
      case "dispatch-message":
        await runDispatchMessage(
          job.data as AgentJobPayloadMap["dispatch-message"],
        );
        return;
      case "followup-step":
        await runFollowupStep(job.data as AgentJobPayloadMap["followup-step"]);
        return;
      case "process-inbound":
        await runInboundFlow(
          (job.data as AgentJobPayloadMap["process-inbound"]).leadId,
          (job.data as AgentJobPayloadMap["process-inbound"]).messageId,
        );
        return;
      case "create-backup":
        await createBackupSnapshot(
          (job.data as AgentJobPayloadMap["create-backup"]).reason,
        );
        return;
      default:
        return assertNever(job.name);
    }
  });

  worker.on("completed", (job) => {
    console.log(`[worker] completed ${job.id} (${job.name})`);
  });
  worker.on("failed", (job, error) => {
    console.error(`[worker] failed ${job?.id} (${job?.name})`, error);
  });

  return worker;
}

async function runDispatchMessage(
  payload: AgentJobPayloadMap["dispatch-message"],
): Promise<void> {
  const lead = await getLead(payload.leadId);
  if (!lead) {
    return;
  }

  const messageId = String(payload.metadata?.messageId ?? `msg-${Date.now()}`);
  const sentAt = new Date().toISOString();

  try {
    const targetChannel = resolveDispatchChannel(payload.channel, {
      phone: lead.contact.phone,
      email: lead.contact.email,
    });
    if (!targetChannel) {
      throw new Error("No configured channel available for this lead.");
    }

    if (targetChannel === "sms") {
      if (!lead.contact.phone) {
        throw new Error("Lead has no phone number for SMS.");
      }
      const sms = await sendSms({
        to: lead.contact.phone,
        body: payload.body,
      });
      await appendMessage(payload.leadId, {
        id: messageId,
        at: sentAt,
        direction: "outbound",
        channel: "sms",
        body: payload.body,
        metadata: {
          providerId: sms.providerId,
          status: sms.status,
          ...payload.metadata,
        },
      });
    } else if (targetChannel === "email") {
      if (!lead.contact.email) {
        throw new Error("Lead has no email for email channel.");
      }
      const email = await sendEmail({
        to: lead.contact.email,
        subject: payload.subject ?? "Thanks for your request",
        text: payload.body,
      });
      await appendMessage(payload.leadId, {
        id: messageId,
        at: sentAt,
        direction: "outbound",
        channel: "email",
        body: payload.body,
        metadata: {
          providerId: email.providerId,
          status: email.status,
          ...payload.metadata,
        },
      });
    } else {
      if (!lead.contact.phone) {
        throw new Error("Lead has no phone number for voice.");
      }
      const voice = await sendVoicemailDrop({
        to: lead.contact.phone,
        message: payload.body,
      });
      await appendMessage(payload.leadId, {
        id: messageId,
        at: sentAt,
        direction: "outbound",
        channel: "voice",
        body: payload.body,
        metadata: {
          providerId: voice.providerId,
          status: voice.status,
          ...payload.metadata,
        },
      });
    }

    if (
      payload.metadata?.reason === "followup" &&
      typeof payload.metadata?.step === "number"
    ) {
      await markFollowupSent(payload.leadId, payload.metadata.step);
    }
  } catch (error) {
    await appendDecision(payload.leadId, {
      id: `dec-${Date.now()}`,
      at: sentAt,
      decisionType: "dispatch_failed",
      inputs: { channel: payload.channel, messageId },
      outputs: {
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });
    throw error;
  }
}

async function markFollowupSent(leadId: string, step: number): Promise<void> {
  const followUps = await getFollowupsSafely(leadId);
  if (!followUps) {
    return;
  }
  const attempts = [...followUps.attempts];
  const index = attempts.findIndex(
    (attempt) => attempt.step === step && attempt.status === "scheduled",
  );
  if (index < 0) {
    return;
  }
  attempts[index] = {
    ...attempts[index],
    status: "sent",
    at: new Date().toISOString(),
  };
  await updateFollowUps(leadId, { attempts });
}

async function getFollowupsSafely(leadId: string) {
  try {
    return await getFollowUps(leadId);
  } catch {
    return null;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled job name: ${String(value)}`);
}

function resolveDispatchChannel(
  requested: "sms" | "email" | "voice",
  contact: { phone?: string; email?: string },
): "sms" | "email" | "voice" | null {
  const channels = validateChannelConfiguration();
  const available = {
    sms: channels.sms && Boolean(contact.phone),
    email: channels.email && Boolean(contact.email),
    voice: channels.voice && Boolean(contact.phone),
  };

  if (requested === "sms" && available.sms) {
    return "sms";
  }
  if (requested === "email" && available.email) {
    return "email";
  }
  if (requested === "voice" && available.voice) {
    return "voice";
  }

  if (available.sms) {
    return "sms";
  }
  if (available.voice) {
    return "voice";
  }
  if (available.email) {
    return "email";
  }

  return null;
}
