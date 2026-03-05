import { Router } from "express";

import { addAgentJob } from "../jobs/queue";
import {
  appendDecision,
  appendMessage,
  findLeadIdByPhone,
  hasProcessedEvent,
  markProcessedEvent,
} from "../storage/leadStore";

const router = Router();

router.post("/sms", async (req, res) => {
  const from = normalizePhone(readField(req.body.From));
  const body = readField(req.body.Body) ?? "";
  const messageSid = readField(req.body.MessageSid) ?? `sms-${Date.now()}`;

  if (!from) {
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  const leadId = await findLeadIdByPhone(from);
  if (!leadId) {
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  if (await hasProcessedEvent(leadId, messageSid)) {
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  await markProcessedEvent(leadId, messageSid);
  await appendMessage(leadId, {
    id: `msg-${messageSid}`,
    at: new Date().toISOString(),
    direction: "inbound",
    channel: "sms",
    body,
    metadata: { providerMessageSid: messageSid, from },
  });
  await addAgentJob("process-inbound", {
    leadId,
    messageId: `msg-${messageSid}`,
  });

  res.status(200).type("text/xml").send("<Response></Response>");
});

router.post("/voice", async (req, res) => {
  const to = normalizePhone(readField(req.body.To));
  const callSid = readField(req.body.CallSid) ?? `call-${Date.now()}`;
  const callStatus = readField(req.body.CallStatus) ?? "unknown";

  if (!to) {
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  const leadId = await findLeadIdByPhone(to);
  if (!leadId) {
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  await appendDecision(leadId, {
    id: `dec-${Date.now()}`,
    at: new Date().toISOString(),
    decisionType: "voice_status_callback",
    inputs: { callSid },
    outputs: { callStatus },
  });

  res.status(200).type("text/xml").send("<Response></Response>");
});

function readField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizePhone(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/[^\d+]/g, "");
}

export default router;
