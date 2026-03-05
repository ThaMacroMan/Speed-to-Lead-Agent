import express from "express";

import { env } from "./config/env";
import { scheduleNightlyBackups } from "./jobs/backups";
import { startWorkers } from "./jobs/worker";
import formspreeWebhookRouter from "./routes/formspreeWebhook";
import healthRouter from "./routes/health";
import inboundTwilioRouter from "./routes/inboundTwilio";
import { ensureDataDirectories } from "./storage/leadStore";

async function bootstrap(): Promise<void> {
  await ensureDataDirectories();

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/health", healthRouter);
  app.use("/webhooks/formspree", formspreeWebhookRouter);
  app.use("/webhooks/twilio", inboundTwilioRouter);

  app.listen(env.PORT, () => {
    console.log(
      `speed-to-lead listening on port ${env.PORT} (${env.NODE_ENV})`,
    );
  });

  if (env.WORKER_ENABLED) {
    startWorkers();
    await scheduleNightlyBackups();
    console.log("Background worker started.");
  } else {
    console.log("Background worker disabled (WORKER_ENABLED=false).");
  }
}

void bootstrap().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
