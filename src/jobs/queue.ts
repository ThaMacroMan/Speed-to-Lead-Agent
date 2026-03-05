import { Queue, Worker, type Job, type JobsOptions } from "bullmq";

import { env } from "../config/env";

export type AgentJobName =
  | "dispatch-message"
  | "followup-step"
  | "process-inbound"
  | "create-backup";

export type DispatchMessageJob = {
  leadId: string;
  channel: "sms" | "email" | "voice";
  body: string;
  subject?: string;
  metadata?: Record<string, unknown>;
};

export type FollowupStepJob = {
  leadId: string;
  step: number;
};

export type ProcessInboundJob = {
  leadId: string;
  messageId: string;
};

export type CreateBackupJob = {
  reason: "scheduled" | "manual";
};

export type AgentJobPayloadMap = {
  "dispatch-message": DispatchMessageJob;
  "followup-step": FollowupStepJob;
  "process-inbound": ProcessInboundJob;
  "create-backup": CreateBackupJob;
};

const connection = {
  url: env.REDIS_URL,
};

export const agentQueue = new Queue("speed-to-lead", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 2000,
    attempts: 4,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

export async function addAgentJob<T extends AgentJobName>(
  name: T,
  payload: AgentJobPayloadMap[T],
  options?: JobsOptions,
): Promise<void> {
  await agentQueue.add(name, payload, options);
}

export function createAgentWorker(
  processor: (
    job: Job<AgentJobPayloadMap[AgentJobName], void, AgentJobName>,
  ) => Promise<void>,
): Worker<AgentJobPayloadMap[AgentJobName], void, AgentJobName> {
  return new Worker("speed-to-lead", processor, {
    connection,
    concurrency: 5,
  });
}

export type AgentWorkerJob = Job<
  AgentJobPayloadMap[AgentJobName],
  void,
  AgentJobName
>;
