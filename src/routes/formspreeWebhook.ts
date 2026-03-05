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

router.post("/", async (req, res) => {
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

export default router;
