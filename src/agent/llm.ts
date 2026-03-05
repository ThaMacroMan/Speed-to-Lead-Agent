import OpenAI from "openai";

import { env } from "../config/env";
import type { MessageEvent } from "../storage/leadFolderSchema";

export type AgentDecision = {
  intent: "booking" | "pricing" | "handoff" | "general" | "not_interested";
  leadScore: number;
  preferredChannel: "sms" | "email" | "voice";
  reply: string;
  shouldHandoff: boolean;
  shouldVoicemailDrop: boolean;
  memorySummary: string;
};

const openaiClient = env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY })
  : null;

export async function generateAgentDecision(input: {
  leadName?: string;
  transcript: MessageEvent[];
  promptContext: string;
}): Promise<AgentDecision> {
  if (!openaiClient) {
    return fallbackDecision(input.transcript);
  }

  const transcriptText = input.transcript
    .slice(-12)
    .map((item) => `[${item.direction}/${item.channel}] ${item.body}`)
    .join("\n");

  const systemPrompt = `
You are a speed-to-lead qualification assistant.
Return strict JSON with keys:
intent, leadScore, preferredChannel, reply, shouldHandoff, shouldVoicemailDrop, memorySummary.

Rules:
- intent must be one of: booking, pricing, handoff, general, not_interested
- preferredChannel must be one of: sms, email, voice
- leadScore is integer 0-100
- reply is concise and actionable (max 320 chars for sms)
- shouldHandoff true if user asks for a human or legal/contract negotiation
- shouldVoicemailDrop true only for high intent and no contact yet
- memorySummary should be <= 220 chars
`.trim();

  const userPrompt = `
LeadName: ${input.leadName ?? "unknown"}
Context: ${input.promptContext}
Transcript:
${transcriptText}
`.trim();

  try {
    const completion = await openaiClient.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return fallbackDecision(input.transcript);
    }

    const parsed = JSON.parse(content) as Partial<AgentDecision>;
    return {
      intent: validateIntent(parsed.intent),
      leadScore: clampLeadScore(parsed.leadScore),
      preferredChannel: validatePreferredChannel(parsed.preferredChannel),
      reply:
        typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : defaultReply(),
      shouldHandoff: Boolean(parsed.shouldHandoff),
      shouldVoicemailDrop: Boolean(parsed.shouldVoicemailDrop),
      memorySummary:
        typeof parsed.memorySummary === "string" && parsed.memorySummary.trim()
          ? parsed.memorySummary.trim()
          : "Lead conversation initialized.",
    };
  } catch {
    return fallbackDecision(input.transcript);
  }
}

function fallbackDecision(transcript: MessageEvent[]): AgentDecision {
  const latestInbound =
    [...transcript].reverse().find((item) => item.direction === "inbound")
      ?.body ?? "";
  const lower = latestInbound.toLowerCase();
  const intent = inferIntent(lower);

  if (intent === "handoff") {
    return {
      intent,
      leadScore: 85,
      preferredChannel: "sms",
      reply:
        "Absolutely. A specialist will reach out shortly. What is the best callback number for right now?",
      shouldHandoff: true,
      shouldVoicemailDrop: false,
      memorySummary: "Lead requested human handoff.",
    };
  }

  if (intent === "booking") {
    return {
      intent,
      leadScore: 88,
      preferredChannel: "sms",
      reply:
        "Great, let's book this. Are mornings or afternoons better for you this week?",
      shouldHandoff: false,
      shouldVoicemailDrop: false,
      memorySummary: "Lead asked to book a time.",
    };
  }

  if (intent === "pricing") {
    return {
      intent,
      leadScore: 72,
      preferredChannel: "sms",
      reply:
        "Happy to help with pricing. Is this for residential or commercial work, and what timeline are you targeting?",
      shouldHandoff: false,
      shouldVoicemailDrop: false,
      memorySummary:
        "Lead requested pricing; collecting qualification details.",
    };
  }

  if (intent === "not_interested") {
    return {
      intent,
      leadScore: 5,
      preferredChannel: "sms",
      reply:
        "Understood. Thanks for your time. If anything changes, reply here and we can help.",
      shouldHandoff: false,
      shouldVoicemailDrop: false,
      memorySummary: "Lead appears not interested.",
    };
  }

  return {
    intent: "general",
    leadScore: 55,
    preferredChannel: "sms",
    reply: defaultReply(),
    shouldHandoff: false,
    shouldVoicemailDrop: false,
    memorySummary: "New lead engaged; gathering qualification details.",
  };
}

function inferIntent(text: string): AgentDecision["intent"] {
  if (/\b(stop|unsubscribe|not interested|remove me)\b/.test(text)) {
    return "not_interested";
  }
  if (/\b(human|person|call me|speak to someone)\b/.test(text)) {
    return "handoff";
  }
  if (/\b(book|schedule|appointment|calendar|meeting)\b/.test(text)) {
    return "booking";
  }
  if (/\b(price|pricing|quote|cost|estimate)\b/.test(text)) {
    return "pricing";
  }
  return "general";
}

function validateIntent(intent: unknown): AgentDecision["intent"] {
  switch (intent) {
    case "booking":
    case "pricing":
    case "handoff":
    case "general":
    case "not_interested":
      return intent;
    default:
      return "general";
  }
}

function validatePreferredChannel(
  channel: unknown,
): AgentDecision["preferredChannel"] {
  switch (channel) {
    case "sms":
    case "email":
    case "voice":
      return channel;
    default:
      return "sms";
  }
}

function clampLeadScore(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 55;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function defaultReply(): string {
  return "Thanks for reaching out. Quick question so I can route this correctly: is this for residential or commercial work?";
}
