import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer env: ${name}=${raw}`);
  }
  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function normalizeFormspreeFormId(value: string): string {
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/\/f\/([a-zA-Z0-9]+)$/);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }
  const plainId = trimmed.match(/^([a-zA-Z0-9]+)$/);
  if (plainId?.[1]) {
    return plainId[1];
  }
  return trimmed;
}

function parseFollowUpMinutes(raw: string): number[] {
  const values = raw
    .split(",")
    .map((chunk) => Number.parseInt(chunk.trim(), 10))
    .filter((chunk) => Number.isFinite(chunk) && chunk >= 0);
  if (values.length === 0) {
    return [5, 120, 1440];
  }
  return values;
}

export const env = {
  FORMSPREE_FORM_ID: normalizeFormspreeFormId(requireEnv("FORMSPREE_FORM_ID")),
  PORT: parseIntEnv("PORT", 3000),
  NODE_ENV: optionalEnv("NODE_ENV", "development"),
  DATA_DIR: optionalEnv("DATA_DIR", "./data"),
  REDIS_URL: optionalEnv("REDIS_URL", "redis://localhost:6379"),
  WORKER_ENABLED: parseBoolEnv("WORKER_ENABLED", true),
  OPENAI_API_KEY: optionalEnv("OPENAI_API_KEY", ""),
  OPENAI_MODEL: optionalEnv("OPENAI_MODEL", "gpt-5.2"),
  TWILIO_ACCOUNT_SID: optionalEnv("TWILIO_ACCOUNT_SID", ""),
  TWILIO_AUTH_TOKEN: optionalEnv("TWILIO_AUTH_TOKEN", ""),
  TWILIO_PHONE_NUMBER: optionalEnv("TWILIO_PHONE_NUMBER", ""),
  SENDGRID_API_KEY: optionalEnv("SENDGRID_API_KEY", ""),
  SENDGRID_FROM_EMAIL: optionalEnv("SENDGRID_FROM_EMAIL", ""),
  SENDGRID_FROM_NAME: optionalEnv("SENDGRID_FROM_NAME", "Speed To Lead"),
  BOOKING_LINK: optionalEnv("BOOKING_LINK", ""),
  BUSINESS_TIMEZONE: optionalEnv("BUSINESS_TIMEZONE", "America/New_York"),
  QUIET_HOURS_START: parseIntEnv("QUIET_HOURS_START", 20),
  QUIET_HOURS_END: parseIntEnv("QUIET_HOURS_END", 8),
  FOLLOW_UP_MINUTES: parseFollowUpMinutes(
    optionalEnv("FOLLOW_UP_MINUTES", "5,120,1440"),
  ),
  DRY_RUN: parseBoolEnv("DRY_RUN", true),
  ENABLE_VOICE: parseBoolEnv("ENABLE_VOICE", true),
};

export function validateChannelConfiguration(): {
  sms: boolean;
  email: boolean;
  voice: boolean;
} {
  const sms =
    Boolean(env.TWILIO_ACCOUNT_SID) &&
    Boolean(env.TWILIO_AUTH_TOKEN) &&
    Boolean(env.TWILIO_PHONE_NUMBER);
  const email =
    Boolean(env.SENDGRID_API_KEY) && Boolean(env.SENDGRID_FROM_EMAIL);
  const voice = sms && env.ENABLE_VOICE;
  return { sms, email, voice };
}
