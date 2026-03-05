import { addAgentJob } from "./queue";
import { validateChannelConfiguration } from "../config/env";
import {
  appendDecision,
  getConversation,
  getFollowUps,
  getLead,
  getMessages,
  updateFollowUps,
} from "../storage/leadStore";

type FollowupStepPayload = {
  leadId: string;
  step: number;
};

const TERMINAL_STATUSES = new Set(["booked", "opted_out", "closed", "handoff"]);

export async function scheduleInitialFollowUps(leadId: string): Promise<void> {
  const followUps = await getFollowUps(leadId);
  if (!followUps) {
    return;
  }
  for (const item of followUps.sequencePlan) {
    await addAgentJob(
      "followup-step",
      {
        leadId,
        step: item.step,
      },
      {
        delay: item.atMinutes * 60 * 1000,
        jobId: `followup:${leadId}:${item.step}`,
      },
    );
  }
}

export async function runFollowupStep(
  payload: FollowupStepPayload,
): Promise<void> {
  const lead = await getLead(payload.leadId);
  if (!lead) {
    return;
  }

  if (TERMINAL_STATUSES.has(lead.status)) {
    await appendDecision(payload.leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "followup_skipped_terminal_status",
      inputs: { step: payload.step, status: lead.status },
      outputs: { skipped: true },
    });
    return;
  }

  const followUps = await getFollowUps(payload.leadId);
  if (!followUps) {
    return;
  }
  const plan = followUps.sequencePlan.find(
    (item) => item.step === payload.step,
  );
  if (!plan) {
    return;
  }

  const conversation = await getConversation(payload.leadId);
  if (!conversation) {
    return;
  }
  if (conversation.state === "handoff" || conversation.state === "closed") {
    return;
  }

  const messages = await getMessages(payload.leadId);
  const hasInboundAfterFirstOutbound = hasReplyAfterOutbound(messages);
  if (hasInboundAfterFirstOutbound) {
    await appendDecision(payload.leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "followup_skipped_recent_reply",
      inputs: { step: payload.step },
      outputs: { skipped: true },
    });
    await recordFollowupAttempt(
      payload.leadId,
      payload.step,
      plan.channel,
      "skipped",
      "lead_replied",
    );
    return;
  }

  const leadName = lead.contact.name ?? "there";
  const dispatchChannel = resolveDispatchChannel(plan.channel, {
    phone: lead.contact.phone,
    email: lead.contact.email,
  });
  if (!dispatchChannel) {
    await appendDecision(payload.leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "followup_skipped_no_channel",
      inputs: { step: payload.step, plannedChannel: plan.channel },
      outputs: { skipped: true },
    });
    await recordFollowupAttempt(
      payload.leadId,
      payload.step,
      plan.channel,
      "skipped",
      "no_available_channel",
    );
    return;
  }

  const body =
    payload.step === 1
      ? `Hey ${leadName}, checking in. I can help you get this moving quickly. Want a quick quote today?`
      : payload.step === 2
        ? `Quick follow-up, ${leadName}. If you share your timeline and project type, I can route this immediately.`
        : `Final check-in: I can still help with this request if needed. Reply here and I will prioritize it.`;

  await addAgentJob("dispatch-message", {
    leadId: payload.leadId,
    channel: dispatchChannel,
    body,
    subject: "Quick follow-up on your request",
    metadata: { reason: "followup", step: payload.step },
  });

  await recordFollowupAttempt(
    payload.leadId,
    payload.step,
    dispatchChannel,
    "scheduled",
  );
}

async function recordFollowupAttempt(
  leadId: string,
  step: number,
  channel: "sms" | "email" | "voice",
  status: "scheduled" | "sent" | "skipped" | "failed",
  reason?: string,
): Promise<void> {
  const followUps = await getFollowUps(leadId);
  if (!followUps) {
    return;
  }

  const attempts = [...followUps.attempts];
  attempts.push({
    step,
    at: new Date().toISOString(),
    channel,
    status,
    reason,
  });

  await updateFollowUps(leadId, { attempts });
}

function hasReplyAfterOutbound(
  messages: Array<{
    at: string;
    direction: "inbound" | "outbound" | "system";
  }>,
): boolean {
  const firstOutbound = messages.find(
    (message) => message.direction === "outbound",
  );
  if (!firstOutbound) {
    return false;
  }
  return messages.some(
    (message) =>
      message.direction === "inbound" && message.at > firstOutbound.at,
  );
}

function resolveDispatchChannel(
  planned: "sms" | "email" | "voice",
  contact: { phone?: string; email?: string },
): "sms" | "email" | "voice" | null {
  const channels = validateChannelConfiguration();
  const available = {
    sms: channels.sms && Boolean(contact.phone),
    email: channels.email && Boolean(contact.email),
    voice: channels.voice && Boolean(contact.phone),
  };

  if (planned === "sms" && available.sms) {
    return "sms";
  }
  if (planned === "voice" && available.voice) {
    return "voice";
  }
  if (planned === "email" && available.email) {
    return "email";
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
