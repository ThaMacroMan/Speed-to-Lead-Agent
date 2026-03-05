import { v4 as uuidv4 } from "uuid";

import { env, validateChannelConfiguration } from "../config/env";
import { scheduleInitialFollowUps } from "../jobs/followups";
import { addAgentJob } from "../jobs/queue";
import {
  appendDecision,
  getConversation,
  getLead,
  getMessages,
  updateConversation,
  updateLead,
  updateStatusMeta,
} from "../storage/leadStore";
import { generateAgentDecision } from "./llm";

type DispatchMessageInput = {
  leadId: string;
  channel: "sms" | "email" | "voice";
  body: string;
  subject?: string;
  metadata?: Record<string, unknown>;
};

const STOP_WORDS = ["stop", "unsubscribe", "remove me", "do not contact"];

export async function runInitialLeadFlow(leadId: string): Promise<void> {
  const lead = await getLead(leadId);
  const conversation = await getConversation(leadId);
  if (!lead || !conversation) {
    return;
  }

  const transcript = await getMessages(leadId);
  const decision = await generateAgentDecision({
    leadName: lead.contact.name,
    transcript,
    promptContext: "Initial outreach after lead submission.",
  });

  const preferredChannel = resolveBestChannel(
    decision.preferredChannel,
    lead.contact,
  );
  if (!preferredChannel) {
    await appendDecision(leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "no_available_channel",
      inputs: { preferred: decision.preferredChannel },
      outputs: { queued: false },
    });
    return;
  }
  const responseBody = withBookingLinkIfNeeded(decision.reply, decision.intent);

  await appendDecision(leadId, {
    id: `dec-${Date.now()}`,
    at: new Date().toISOString(),
    decisionType: "initial_outreach",
    inputs: {
      transcriptSize: transcript.length,
      preferredChannel,
    },
    outputs: {
      intent: decision.intent,
      score: decision.leadScore,
      shouldHandoff: decision.shouldHandoff,
    },
  });

  await updateConversation(leadId, {
    state: decision.shouldHandoff ? "handoff" : "waiting_for_reply",
    preferredChannel,
    memorySummary: decision.memorySummary,
    lastIntent: decision.intent,
  });

  await updateLead(leadId, {
    score: decision.leadScore,
    status: decision.shouldHandoff ? "handoff" : "contacted",
  });

  if (decision.shouldHandoff) {
    await updateStatusMeta(leadId, {
      handoffRequested: true,
    });
  }

  await queueOutboundMessage({
    leadId,
    channel: preferredChannel,
    body: responseBody,
    subject: "Thanks for your request",
    metadata: { reason: "initial_outreach", decisionIntent: decision.intent },
  });

  if (decision.shouldVoicemailDrop && lead.contact.phone) {
    await queueOutboundMessage({
      leadId,
      channel: "voice",
      body: "Thanks for reaching out. We received your request and will follow up shortly.",
      metadata: { reason: "voicemail_drop" },
    });
  }

  await scheduleInitialFollowUps(leadId);
}

export async function runInboundFlow(
  leadId: string,
  inboundMessageId: string,
): Promise<void> {
  const lead = await getLead(leadId);
  const conversation = await getConversation(leadId);
  if (!lead || !conversation) {
    return;
  }

  const transcript = await getMessages(leadId);
  const latestInbound = transcript.find(
    (message) => message.id === inboundMessageId,
  );
  if (!latestInbound) {
    return;
  }

  if (containsStopWord(latestInbound.body)) {
    await updateLead(leadId, { status: "opted_out" });
    await updateConversation(leadId, {
      state: "closed",
      lastIntent: "not_interested",
      memorySummary: "Lead opted out.",
    });
    await appendDecision(leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "opt_out_detected",
      inputs: { inboundMessageId },
      outputs: { status: "opted_out" },
    });
    return;
  }

  const decision = await generateAgentDecision({
    leadName: lead.contact.name,
    transcript,
    promptContext: "Inbound lead response during qualification flow.",
  });

  const preferredChannel = resolveBestChannel(
    decision.preferredChannel,
    lead.contact,
  );
  if (!preferredChannel) {
    await appendDecision(leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "no_available_channel",
      inputs: { preferred: decision.preferredChannel },
      outputs: { queued: false },
    });
    return;
  }
  const responseBody = withBookingLinkIfNeeded(decision.reply, decision.intent);

  await appendDecision(leadId, {
    id: `dec-${Date.now()}`,
    at: new Date().toISOString(),
    decisionType: "inbound_response",
    inputs: {
      inboundMessageId,
      preferredChannel,
    },
    outputs: {
      intent: decision.intent,
      score: decision.leadScore,
      shouldHandoff: decision.shouldHandoff,
    },
  });

  const mappedStatus = mapIntentToStatus(
    decision.intent,
    decision.shouldHandoff,
  );
  const mappedState = mapIntentToConversationState(
    decision.intent,
    decision.shouldHandoff,
  );

  await updateLead(leadId, {
    status: mappedStatus,
    score: decision.leadScore,
  });
  await updateConversation(leadId, {
    state: mappedState,
    lastIntent: decision.intent,
    preferredChannel,
    memorySummary: decision.memorySummary,
  });

  if (decision.intent === "not_interested") {
    return;
  }

  await queueOutboundMessage({
    leadId,
    channel: preferredChannel,
    body: responseBody,
    subject: "Quick follow-up",
    metadata: { reason: "inbound_flow", decisionIntent: decision.intent },
  });
}

function withBookingLinkIfNeeded(reply: string, intent: string): string {
  if (intent !== "booking" || !env.BOOKING_LINK) {
    return reply;
  }
  return `${reply} You can pick a time here: ${env.BOOKING_LINK}`;
}

function containsStopWord(value: string): boolean {
  const lower = value.toLowerCase();
  return STOP_WORDS.some((word) => lower.includes(word));
}

function resolveBestChannel(
  preferred: "sms" | "email" | "voice",
  contact: { phone?: string; email?: string },
): "sms" | "email" | "voice" | null {
  const channels = validateChannelConfiguration();
  const available = {
    sms: channels.sms && Boolean(contact.phone),
    email: channels.email && Boolean(contact.email),
    voice: channels.voice && Boolean(contact.phone),
  };

  if (preferred === "sms" && available.sms) {
    return "sms";
  }
  if (preferred === "voice" && available.voice) {
    return "voice";
  }
  if (preferred === "email" && available.email) {
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

function mapIntentToStatus(
  intent: "booking" | "pricing" | "handoff" | "general" | "not_interested",
  shouldHandoff: boolean,
): "contacted" | "engaged" | "qualified" | "handoff" | "closed" {
  if (shouldHandoff || intent === "handoff") {
    return "handoff";
  }

  const narrowedIntent = intent;
  switch (narrowedIntent) {
    case "booking":
      return "qualified";
    case "pricing":
      return "engaged";
    case "not_interested":
      return "closed";
    case "general":
      return "engaged";
    default:
      return assertNever(narrowedIntent);
  }
}

function mapIntentToConversationState(
  intent: "booking" | "pricing" | "handoff" | "general" | "not_interested",
  shouldHandoff: boolean,
): "waiting_for_reply" | "qualifying" | "handoff" | "closed" {
  if (shouldHandoff || intent === "handoff") {
    return "handoff";
  }

  const narrowedIntent = intent;
  switch (narrowedIntent) {
    case "booking":
      return "qualifying";
    case "pricing":
      return "qualifying";
    case "not_interested":
      return "closed";
    case "general":
      return "waiting_for_reply";
    default:
      return assertNever(narrowedIntent);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${String(value)}`);
}

async function queueOutboundMessage(
  input: DispatchMessageInput,
): Promise<void> {
  if (isInQuietHours() && input.channel !== "email") {
    await appendDecision(input.leadId, {
      id: `dec-${Date.now()}`,
      at: new Date().toISOString(),
      decisionType: "quiet_hours_block",
      inputs: { channel: input.channel },
      outputs: { queued: false },
    });
    return;
  }

  await addAgentJob("dispatch-message", {
    ...input,
    metadata: {
      messageId: `msg-${uuidv4()}`,
      ...(input.metadata ?? {}),
    },
  });
}

function isInQuietHours(): boolean {
  const now = new Date();
  const localHour = Number.parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: env.BUSINESS_TIMEZONE,
    }).format(now),
    10,
  );

  if (env.QUIET_HOURS_START === env.QUIET_HOURS_END) {
    return false;
  }
  if (env.QUIET_HOURS_START < env.QUIET_HOURS_END) {
    return (
      localHour >= env.QUIET_HOURS_START && localHour < env.QUIET_HOURS_END
    );
  }
  return localHour >= env.QUIET_HOURS_START || localHour < env.QUIET_HOURS_END;
}
