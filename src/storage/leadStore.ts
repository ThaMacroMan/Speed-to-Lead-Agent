import fs from "node:fs/promises";
import path from "node:path";

import { env, validateChannelConfiguration } from "../config/env";
import { withIndexLock, withLeadLock } from "./fileLocks";
import {
  conversationRecordSchema,
  decisionEventSchema,
  followUpRecordSchema,
  leadRecordSchema,
  messageEventSchema,
  statusMetaSchema,
  type ConversationRecord,
  type DecisionEvent,
  type FollowUpRecord,
  type LeadRecord,
  type MessageEvent,
  type StatusMeta,
} from "./leadFolderSchema";

const DATA_DIR = env.DATA_DIR;
const LEADS_DIR = path.join(DATA_DIR, "leads");
const INDEX_DIR = path.join(DATA_DIR, "index");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");

type LeadCreatePayload = {
  source: string;
  contact: {
    name?: string;
    email?: string;
    phone?: string;
  };
  raw?: Record<string, unknown>;
};

function selectFollowupChannel(
  stepIndex: number,
  contact: LeadCreatePayload["contact"],
): "sms" | "email" | "voice" {
  const channels = validateChannelConfiguration();

  if (contact.phone && channels.sms) {
    if (stepIndex === 1 && channels.voice) {
      return "voice";
    }
    return "sms";
  }

  if (contact.email && channels.email) {
    return "email";
  }

  if (contact.phone && channels.voice) {
    return "voice";
  }

  return "sms";
}

function leadDir(leadId: string): string {
  return path.join(LEADS_DIR, leadId);
}

function leadFile(leadId: string, relativePath: string): string {
  return path.join(leadDir(leadId), relativePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(
  filePath: string,
  validate: (value: unknown) => T,
): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDir(directory);
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function appendNdjsonLine(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDir(directory);
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readNdjson<T>(
  filePath: string,
  validate: (value: unknown) => T,
): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => validate(JSON.parse(line)));
  } catch {
    return [];
  }
}

async function readIndex(indexFile: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(indexFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed;
  } catch {
    return {};
  }
}

async function updateContactIndexes(
  leadId: string,
  contact: LeadCreatePayload["contact"],
): Promise<void> {
  await withIndexLock("contact", async () => {
    await ensureDir(INDEX_DIR);
    const byPhonePath = path.join(INDEX_DIR, "by-phone.json");
    const byEmailPath = path.join(INDEX_DIR, "by-email.json");

    const byPhone = await readIndex(byPhonePath);
    const byEmail = await readIndex(byEmailPath);

    if (contact.phone) {
      byPhone[normalizePhone(contact.phone)] = leadId;
    }
    if (contact.email) {
      byEmail[normalizeEmail(contact.email)] = leadId;
    }

    await writeJsonAtomic(byPhonePath, byPhone);
    await writeJsonAtomic(byEmailPath, byEmail);
  });
}

async function addEventIdIfMissing(
  meta: StatusMeta,
  eventId: string,
): Promise<StatusMeta> {
  const existing = new Set(meta.processedEventIds ?? []);
  existing.add(eventId);
  return {
    ...meta,
    processedEventIds: Array.from(existing),
  };
}

export async function ensureDataDirectories(): Promise<void> {
  await ensureDir(LEADS_DIR);
  await ensureDir(INDEX_DIR);
  await ensureDir(BACKUPS_DIR);
}

export async function createLead(
  leadId: string,
  payload: LeadCreatePayload,
): Promise<LeadRecord> {
  return withLeadLock(leadId, async () => {
    const timestamp = nowIso();
    const lead: LeadRecord = {
      id: leadId,
      source: payload.source,
      status: "new",
      tags: [],
      contact: payload.contact,
      createdAt: timestamp,
      updatedAt: timestamp,
      raw: payload.raw,
    };
    const conversation: ConversationRecord = {
      state: "initial",
      preferredChannel: selectFollowupChannel(0, payload.contact),
      updatedAt: timestamp,
    };
    const followUps: FollowUpRecord = {
      sequencePlan: env.FOLLOW_UP_MINUTES.map((atMinutes, index) => ({
        atMinutes,
        channel: selectFollowupChannel(index, payload.contact),
        step: index + 1,
      })),
      attempts: [],
      updatedAt: timestamp,
    };
    const statusMeta: StatusMeta = {
      lastActivityAt: timestamp,
      processedEventIds: [],
    };

    await ensureDir(path.join(leadDir(leadId), "meta"));
    await writeJsonAtomic(leadFile(leadId, "lead.json"), lead);
    await writeJsonAtomic(leadFile(leadId, "conversation.json"), conversation);
    await writeJsonAtomic(leadFile(leadId, "followups.json"), followUps);
    await writeJsonAtomic(leadFile(leadId, "meta/status.json"), statusMeta);

    const initialBody =
      typeof payload.raw?.message === "string"
        ? payload.raw.message
        : JSON.stringify(payload.raw ?? {});
    await appendNdjsonLine(leadFile(leadId, "messages.ndjson"), {
      id: `msg-${Date.now()}`,
      at: timestamp,
      direction: "inbound",
      channel: "form",
      body: initialBody,
      metadata: { source: payload.source },
    } satisfies MessageEvent);

    await appendNdjsonLine(leadFile(leadId, "decisions.ndjson"), {
      id: `dec-${Date.now()}`,
      at: timestamp,
      decisionType: "lead_created",
      inputs: { source: payload.source },
      outputs: { leadId },
    } satisfies DecisionEvent);

    await updateContactIndexes(leadId, payload.contact);
    return lead;
  });
}

export async function getLead(leadId: string): Promise<LeadRecord | null> {
  return readJsonFile(leadFile(leadId, "lead.json"), (value) =>
    leadRecordSchema.parse(value),
  );
}

export async function getConversation(
  leadId: string,
): Promise<ConversationRecord | null> {
  return readJsonFile(leadFile(leadId, "conversation.json"), (value) =>
    conversationRecordSchema.parse(value),
  );
}

export async function getMessages(leadId: string): Promise<MessageEvent[]> {
  return readNdjson(leadFile(leadId, "messages.ndjson"), (value) =>
    messageEventSchema.parse(value),
  );
}

export async function getDecisions(leadId: string): Promise<DecisionEvent[]> {
  return readNdjson(leadFile(leadId, "decisions.ndjson"), (value) =>
    decisionEventSchema.parse(value),
  );
}

export async function getFollowUps(
  leadId: string,
): Promise<FollowUpRecord | null> {
  return readJsonFile(leadFile(leadId, "followups.json"), (value) =>
    followUpRecordSchema.parse(value),
  );
}

export async function getStatusMeta(
  leadId: string,
): Promise<StatusMeta | null> {
  return readJsonFile(leadFile(leadId, "meta/status.json"), (value) =>
    statusMetaSchema.parse(value),
  );
}

export async function updateLead(
  leadId: string,
  patch: Partial<Pick<LeadRecord, "status" | "score" | "tags">>,
): Promise<LeadRecord | null> {
  return withLeadLock(leadId, async () => {
    const lead = await getLead(leadId);
    if (!lead) {
      return null;
    }
    const updated: LeadRecord = {
      ...lead,
      ...patch,
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(leadFile(leadId, "lead.json"), updated);
    return updated;
  });
}

export async function updateConversation(
  leadId: string,
  patch: Partial<ConversationRecord>,
): Promise<ConversationRecord | null> {
  return withLeadLock(leadId, async () => {
    const conversation = await getConversation(leadId);
    if (!conversation) {
      return null;
    }
    const updated: ConversationRecord = {
      ...conversation,
      ...patch,
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(leadFile(leadId, "conversation.json"), updated);
    return updated;
  });
}

export async function appendMessage(
  leadId: string,
  event: MessageEvent,
): Promise<void> {
  await withLeadLock(leadId, async () => {
    await appendNdjsonLine(leadFile(leadId, "messages.ndjson"), event);
    const meta = (await getStatusMeta(leadId)) ?? { lastActivityAt: event.at };
    const updated: StatusMeta = {
      ...meta,
      lastActivityAt: event.at,
      ...(event.direction === "inbound" ? { lastInboundAt: event.at } : {}),
      ...(event.direction === "outbound" ? { lastOutboundAt: event.at } : {}),
    };
    await writeJsonAtomic(leadFile(leadId, "meta/status.json"), updated);
  });
}

export async function appendDecision(
  leadId: string,
  event: DecisionEvent,
): Promise<void> {
  await withLeadLock(leadId, async () => {
    await appendNdjsonLine(leadFile(leadId, "decisions.ndjson"), event);
  });
}

export async function updateFollowUps(
  leadId: string,
  patch: Partial<FollowUpRecord>,
): Promise<FollowUpRecord | null> {
  return withLeadLock(leadId, async () => {
    const followUps = await getFollowUps(leadId);
    if (!followUps) {
      return null;
    }
    const updated: FollowUpRecord = {
      ...followUps,
      ...patch,
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(leadFile(leadId, "followups.json"), updated);
    return updated;
  });
}

export async function updateStatusMeta(
  leadId: string,
  patch: Partial<StatusMeta>,
): Promise<void> {
  await withLeadLock(leadId, async () => {
    const statusMeta = (await getStatusMeta(leadId)) ?? {
      lastActivityAt: nowIso(),
    };
    const updated: StatusMeta = {
      ...statusMeta,
      ...patch,
    };
    await writeJsonAtomic(leadFile(leadId, "meta/status.json"), updated);
  });
}

export async function hasProcessedEvent(
  leadId: string,
  eventId: string,
): Promise<boolean> {
  const meta = await getStatusMeta(leadId);
  if (!meta?.processedEventIds) {
    return false;
  }
  return meta.processedEventIds.includes(eventId);
}

export async function markProcessedEvent(
  leadId: string,
  eventId: string,
): Promise<void> {
  await withLeadLock(leadId, async () => {
    const current = (await getStatusMeta(leadId)) ?? {
      lastActivityAt: nowIso(),
    };
    const updated = await addEventIdIfMissing(current, eventId);
    await writeJsonAtomic(leadFile(leadId, "meta/status.json"), updated);
  });
}

export async function findLeadIdByPhone(phone: string): Promise<string | null> {
  const index = await readIndex(path.join(INDEX_DIR, "by-phone.json"));
  return index[normalizePhone(phone)] ?? null;
}

export async function findLeadIdByEmail(email: string): Promise<string | null> {
  const index = await readIndex(path.join(INDEX_DIR, "by-email.json"));
  return index[normalizeEmail(email)] ?? null;
}

export function getLeadFolderPath(leadId: string): string {
  return leadDir(leadId);
}

export function getBackupsFolderPath(): string {
  return BACKUPS_DIR;
}

export async function listLeadIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(LEADS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
