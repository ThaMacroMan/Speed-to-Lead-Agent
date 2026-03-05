import { z } from "zod";

export const leadStatusSchema = z.enum([
  "new",
  "contacted",
  "engaged",
  "qualified",
  "booked",
  "handoff",
  "opted_out",
  "closed",
]);

export const conversationStateSchema = z.enum([
  "initial",
  "waiting_for_reply",
  "qualifying",
  "follow_up",
  "handoff",
  "closed",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound", "system"]);
export const messageChannelSchema = z.enum([
  "form",
  "sms",
  "email",
  "voice",
  "system",
]);

export const leadRecordSchema = z.object({
  id: z.string(),
  source: z.string(),
  status: leadStatusSchema,
  score: z.number().int().min(0).max(100).optional(),
  tags: z.array(z.string()),
  contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const conversationRecordSchema = z.object({
  state: conversationStateSchema,
  preferredChannel: z.enum(["sms", "email", "voice"]),
  lastIntent: z.string().optional(),
  memorySummary: z.string().optional(),
  updatedAt: z.string(),
});

export const messageEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  direction: messageDirectionSchema,
  channel: messageChannelSchema,
  body: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const decisionEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  decisionType: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
});

export const followUpPlanItemSchema = z.object({
  atMinutes: z.number().int().nonnegative(),
  channel: z.enum(["sms", "email", "voice"]),
  step: z.number().int().positive(),
});

export const followUpAttemptSchema = z.object({
  step: z.number().int().positive(),
  at: z.string(),
  channel: z.enum(["sms", "email", "voice"]),
  status: z.enum(["scheduled", "sent", "skipped", "failed"]),
  reason: z.string().optional(),
});

export const followUpRecordSchema = z.object({
  sequencePlan: z.array(followUpPlanItemSchema),
  attempts: z.array(followUpAttemptSchema),
  terminalReason: z.string().optional(),
  updatedAt: z.string(),
});

export const statusMetaSchema = z.object({
  lastActivityAt: z.string(),
  lastInboundAt: z.string().optional(),
  lastOutboundAt: z.string().optional(),
  processedEventIds: z.array(z.string()).optional(),
  handoffRequested: z.boolean().optional(),
});

export type LeadStatus = z.infer<typeof leadStatusSchema>;
export type ConversationState = z.infer<typeof conversationStateSchema>;
export type LeadRecord = z.infer<typeof leadRecordSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type DecisionEvent = z.infer<typeof decisionEventSchema>;
export type FollowUpPlanItem = z.infer<typeof followUpPlanItemSchema>;
export type FollowUpAttempt = z.infer<typeof followUpAttemptSchema>;
export type FollowUpRecord = z.infer<typeof followUpRecordSchema>;
export type StatusMeta = z.infer<typeof statusMetaSchema>;
