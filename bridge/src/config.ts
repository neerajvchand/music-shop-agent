import { z } from "zod";

const Schema = z.object({
  XAI_API_KEY: z.string().min(1, "XAI_API_KEY is required"),
  XAI_API_URL: z.string().default("wss://api.x.ai/v1/realtime"),
  XAI_MODEL: z.string().default("grok-voice-think-fast-1.0"),

  PORT: z.coerce.number().int().positive().default(8080),
  HOSTNAME: z.string().min(1, "HOSTNAME is required (public host the bridge serves from)"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  DASHBOARD_BASE_URL: z.string().url(),
  AGENT_API_SECRET: z.string().min(1),

  FAREWELL_SAFETY_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  SILENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  GOODBYE_DRAIN_MS: z.coerce.number().int().nonnegative().default(3000),
});

export type BridgeConfig = {
  xaiApiKey: string;
  xaiApiUrl: string;
  xaiModel: string;
  port: number;
  hostname: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  dashboardBaseUrl: string;
  agentApiSecret: string;
  farewellSafetyTimeoutMs: number;
  silenceTimeoutMs: number;
  callTimeoutMs: number;
  goodbyeDrainMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid bridge configuration:\n  ${issues}`);
  }
  const v = parsed.data;
  return {
    xaiApiKey: v.XAI_API_KEY,
    xaiApiUrl: v.XAI_API_URL,
    xaiModel: v.XAI_MODEL,
    port: v.PORT,
    hostname: v.HOSTNAME.replace(/^https?:\/\//, ""),
    supabaseUrl: v.SUPABASE_URL,
    supabaseServiceRoleKey: v.SUPABASE_SERVICE_ROLE_KEY,
    dashboardBaseUrl: v.DASHBOARD_BASE_URL.replace(/\/$/, ""),
    agentApiSecret: v.AGENT_API_SECRET,
    farewellSafetyTimeoutMs: v.FAREWELL_SAFETY_TIMEOUT_MS,
    silenceTimeoutMs: v.SILENCE_TIMEOUT_MS,
    callTimeoutMs: v.CALL_TIMEOUT_MS,
    goodbyeDrainMs: v.GOODBYE_DRAIN_MS,
  };
}
