import { Router } from "express";
import { v4 as uuidv4 } from "uuid";

import { env } from "../config/env";
import { runInitialLeadFlow } from "../agent/orchestrator";
import { addAgentJob } from "../jobs/queue";
import {
  appendMessage,
  createLead,
  findLeadIdByEmail,
  findLeadIdByPhone,
  getLead,
  hasProcessedEvent,
  markProcessedEvent,
} from "../storage/leadStore";

export interface FormspreePayload {
  _form_id?: string;
  form_id?: string;
  _submission_id?: string;
  name?: string;
  Name?: string;
  email?: string;
  Email?: string;
  phone?: string;
  Phone?: string;
  tel?: string;
  message?: string;
  Message?: string;
  [key: string]: unknown;
}

const router = Router();
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_REQUESTS = 5;
const CONTACT_COOLDOWN_MS = 30 * 1000;
const ipRateLimitStore = new Map<string, number[]>();
const contactCooldownStore = new Map<string, number>();

router.post("/", async (req, res) => {
  const requesterIp = readRequesterIp(req.headers, req.ip);
  if (isIpRateLimited(requesterIp)) {
    res.status(429).json({
      error: "rate_limited",
      message:
        "Too many form submissions from this IP. Please try again later.",
    });
    return;
  }

  const payload = req.body as FormspreePayload;
  const normalizedFormId = normalizeFormId(payload);
  if (!normalizedFormId || normalizedFormId !== env.FORMSPREE_FORM_ID) {
    res.status(400).json({
      error: "invalid_form",
      message: "Form ID does not match FORMSPREE_FORM_ID",
    });
    return;
  }

  const leadInput = normalizeLead(payload);
  if (!leadInput.email && !leadInput.phone) {
    res.status(400).json({
      error: "missing_contact",
      message: "Payload must include at least email or phone",
    });
    return;
  }
  const contactKey = buildContactCooldownKey(leadInput.email, leadInput.phone);
  if (contactKey && isContactCoolingDown(contactKey)) {
    res.status(429).json({
      error: "contact_cooldown",
      message:
        "We just received this contact. Please wait before submitting again.",
    });
    return;
  }
  if (contactKey) {
    markContactSubmission(contactKey);
  }

  const eventId = resolveEventId(req.headers, payload);
  const existingLeadIdCandidate =
    (leadInput.phone ? await findLeadIdByPhone(leadInput.phone) : null) ??
    (leadInput.email ? await findLeadIdByEmail(leadInput.email) : null);
  const existingLeadId = existingLeadIdCandidate
    ? (await getLead(existingLeadIdCandidate))
      ? existingLeadIdCandidate
      : null
    : null;

  if (existingLeadId) {
    const duplicate = await hasProcessedEvent(existingLeadId, eventId);
    if (duplicate) {
      res.status(200).json({
        received: true,
        duplicate: true,
        leadId: existingLeadId,
      });
      return;
    }

    const messageId = `msg-${uuidv4()}`;
    await markProcessedEvent(existingLeadId, eventId);
    await appendMessage(existingLeadId, {
      id: messageId,
      at: new Date().toISOString(),
      direction: "inbound",
      channel: "form",
      body: leadInput.message ?? "Form submission update",
      metadata: { source: "formspree", eventId },
    });
    await addAgentJob("process-inbound", {
      leadId: existingLeadId,
      messageId,
    });
    res.status(200).json({
      received: true,
      existing: true,
      leadId: existingLeadId,
    });
    return;
  }

  const leadId = uuidv4();
  await createLead(leadId, {
    source: "formspree",
    contact: {
      name: leadInput.name,
      email: leadInput.email,
      phone: leadInput.phone,
    },
    raw: leadInput.raw,
  });
  await markProcessedEvent(leadId, eventId);
  await runInitialLeadFlow(leadId);

  const lead = await getLead(leadId);
  res.status(200).json({
    received: true,
    leadId,
    status: lead?.status ?? "new",
  });
});

function resolveEventId(
  headers: Record<string, unknown>,
  payload: FormspreePayload,
): string {
  const candidates = [
    headers["x-formspree-event-id"],
    headers["x-formspree-idempotency"],
    payload._submission_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return `evt-${uuidv4()}`;
}

function normalizeFormId(payload: FormspreePayload): string | null {
  const raw = payload._form_id ?? payload.form_id;
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim();
  const fromUrl = value.match(/\/f\/([a-zA-Z0-9]+)$/);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }
  const plainId = value.match(/^([a-zA-Z0-9]+)$/);
  if (plainId?.[1]) {
    return plainId[1];
  }
  return value;
}

function normalizeLead(payload: FormspreePayload): {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  raw: Record<string, unknown>;
} {
  const name = readFirstString(payload.name, payload.Name);
  const email = readFirstString(payload.email, payload.Email)
    ?.trim()
    .toLowerCase();
  const phone = normalizePhone(
    readFirstString(payload.phone, payload.Phone, payload.tel),
  );
  const message = readFirstString(payload.message, payload.Message);

  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith("_")) {
      raw[key] = value;
    }
  }
  if (message) {
    raw.message = message;
  }

  return {
    name,
    email,
    phone,
    message,
    raw,
  };
}

function normalizePhone(phone?: string): string | undefined {
  if (!phone) {
    return undefined;
  }
  const stripped = phone.replace(/[^\d+]/g, "");
  return stripped.length > 0 ? stripped : undefined;
}

function readFirstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readRequesterIp(
  headers: Record<string, unknown>,
  requestIp?: string,
): string {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwarded) && typeof forwarded[0] === "string") {
    return forwarded[0].split(",")[0]?.trim() || "unknown";
  }
  return requestIp?.trim() || "unknown";
}

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = ipRateLimitStore.get(ip) ?? [];
  const recent = existing.filter((timestamp) => now - timestamp < IP_WINDOW_MS);
  if (recent.length >= IP_MAX_REQUESTS) {
    ipRateLimitStore.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipRateLimitStore.set(ip, recent);
  cleanupIpStore(now);
  return false;
}

function cleanupIpStore(now: number): void {
  for (const [ip, timestamps] of ipRateLimitStore.entries()) {
    const recent = timestamps.filter(
      (timestamp) => now - timestamp < IP_WINDOW_MS,
    );
    if (recent.length === 0) {
      ipRateLimitStore.delete(ip);
      continue;
    }
    if (recent.length !== timestamps.length) {
      ipRateLimitStore.set(ip, recent);
    }
  }
}

function buildContactCooldownKey(
  email?: string,
  phone?: string,
): string | null {
  if (phone) {
    return `phone:${phone}`;
  }
  if (email) {
    return `email:${email.trim().toLowerCase()}`;
  }
  return null;
}

function isContactCoolingDown(contactKey: string): boolean {
  const lastSeen = contactCooldownStore.get(contactKey);
  if (!lastSeen) {
    return false;
  }
  return Date.now() - lastSeen < CONTACT_COOLDOWN_MS;
}

function markContactSubmission(contactKey: string): void {
  const now = Date.now();
  contactCooldownStore.set(contactKey, now);
  cleanupContactStore(now);
}

function cleanupContactStore(now: number): void {
  for (const [contactKey, lastSeen] of contactCooldownStore.entries()) {
    if (now - lastSeen >= CONTACT_COOLDOWN_MS) {
      contactCooldownStore.delete(contactKey);
    }
  }
}

export default router;
