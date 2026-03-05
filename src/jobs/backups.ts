import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { addAgentJob } from "./queue";
import {
  getBackupsFolderPath,
  getConversation,
  getDecisions,
  getFollowUps,
  getLead,
  getLeadFolderPath,
  getMessages,
  getStatusMeta,
  listLeadIds,
} from "../storage/leadStore";

export async function scheduleNightlyBackups(): Promise<void> {
  await addAgentJob(
    "create-backup",
    { reason: "scheduled" },
    {
      repeat: {
        pattern: "0 3 * * *",
      },
      jobId: "daily-backup",
    },
  );
}

export async function createBackupSnapshot(
  reason: "scheduled" | "manual",
): Promise<string> {
  const leadIds = await listLeadIds();
  const payload: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    reason,
    leadCount: leadIds.length,
    leads: [] as unknown[],
  };

  for (const leadId of leadIds) {
    const [lead, conversation, followUps, statusMeta, messages, decisions] =
      await Promise.all([
        getLead(leadId),
        getConversation(leadId),
        getFollowUps(leadId),
        getStatusMeta(leadId),
        getMessages(leadId),
        getDecisions(leadId),
      ]);
    (payload.leads as unknown[]).push({
      leadId,
      leadFolderPath: getLeadFolderPath(leadId),
      lead,
      conversation,
      followUps,
      statusMeta,
      messageCount: messages.length,
      decisionCount: decisions.length,
      messages,
      decisions,
    });
  }

  const backupDir = getBackupsFolderPath();
  await fs.mkdir(backupDir, { recursive: true });
  const backupName = `backup-${new Date().toISOString().replaceAll(":", "-")}.json.gz`;
  const backupPath = path.join(backupDir, backupName);
  await fs.writeFile(
    backupPath,
    gzipSync(Buffer.from(JSON.stringify(payload))),
    "binary",
  );
  return backupPath;
}
