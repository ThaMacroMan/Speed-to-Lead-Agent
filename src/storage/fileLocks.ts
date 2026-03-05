import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

import { env } from "../config/env";

function lockPath(namespace: "lead" | "index", id: string): string {
  if (namespace === "lead") {
    return path.join(env.DATA_DIR, "leads", id, ".lock");
  }
  return path.join(env.DATA_DIR, "index", `${id}.lock`);
}

async function withLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(targetPath, "", "utf8");
  } catch {
    // The lock file may already exist from prior operation.
  }

  const release = await lockfile.lock(targetPath, {
    retries: {
      retries: 6,
      minTimeout: 50,
      maxTimeout: 350,
    },
    stale: 10000,
    update: 1500,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function withLeadLock<T>(
  leadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(lockPath("lead", leadId), fn);
}

export async function withIndexLock<T>(
  indexId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(lockPath("index", indexId), fn);
}
