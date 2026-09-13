import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const optionalText = z.string().trim().optional();
const positiveInteger = (fallback: number, maximum: number) =>
  z.string().regex(/^[1-9]\d*$/).default(String(fallback))
    .transform(Number).pipe(z.number().int().positive().max(maximum));

const restRequired = [
  "PG_GITHUB_TOKEN", "PG_GITHUB_REPOSITORY",
  "PG_HUBSPOT_ACCESS_TOKEN", "PG_HUBSPOT_PORTAL_ID",
  "PG_SLACK_BOT_TOKEN", "PG_SLACK_READER_TOKEN", "PG_SLACK_TEAM_ID",
  "PG_SLACK_CHANNEL_ID", "PG_SLACK_APPROVER_IDS",
  "PG_GMAIL_CLIENT_ID", "PG_GMAIL_CLIENT_SECRET", "PG_GMAIL_REFRESH_TOKEN", "PG_GMAIL_MAILBOX",
] as const;

// This schema is server-only. F02 owns domain/API schemas; A01/I01 own dispatch.
const environmentSchema = z.object({
  PG_HOST: z.string().trim().min(1).default("127.0.0.1"),
  PG_PORT: positiveInteger(3000, 65535),
  PG_MODEL_MODE: z.enum(["mock", "live"]).default("mock"),
  PG_ADAPTER_MODE: z.enum(["fake", "rest"]).default("fake"),
  PG_FIXTURE_ID: optionalText,
  PG_DATABASE_PATH: z.string().trim().min(1).default(".local/application.sqlite"),
  PG_CHECKPOINT_PATH: z.string().trim().min(1).default(".local/checkpoints.sqlite"),
  PG_EVIDENCE_DIR: z.string().trim().min(1).default(".local/evidence"),
  OPENAI_API_KEY: optionalText,
  OPENAI_MODEL: optionalText,
  OPENAI_MODEL_ANALYST: optionalText,
  OPENAI_MODEL_DRAFTER: optionalText,
  OPENAI_MODEL_AUDITOR: optionalText,
  PG_MODEL_TIMEOUT_MS: positiveInteger(30000, 300000),
  PG_MODEL_ROLE_BUDGET_MS: positiveInteger(90000, 900000),
  PG_MODEL_MAX_ATTEMPTS: positiveInteger(2, 10),
  PG_MODEL_MAX_OUTPUT_TOKENS: positiveInteger(2000, 100000),
  PG_MODEL_MAX_INPUT_CHARS: positiveInteger(24000, 1000000),
  PG_GITHUB_TOKEN: optionalText,
  PG_GITHUB_REPOSITORY: optionalText,
  PG_GITHUB_READER_TOKEN: optionalText,
  PG_HUBSPOT_ACCESS_TOKEN: optionalText,
  PG_HUBSPOT_PORTAL_ID: optionalText,
  PG_HUBSPOT_READER_TOKEN: optionalText,
  PG_SLACK_BOT_TOKEN: optionalText,
  PG_SLACK_READER_TOKEN: optionalText,
  PG_SLACK_TEAM_ID: optionalText,
  PG_SLACK_CHANNEL_ID: optionalText,
  PG_SLACK_APPROVER_IDS: optionalText,
  PG_GMAIL_CLIENT_ID: optionalText,
  PG_GMAIL_CLIENT_SECRET: optionalText,
  PG_GMAIL_REFRESH_TOKEN: optionalText,
  PG_GMAIL_MAILBOX: optionalText,
  PG_GMAIL_READER_REFRESH_TOKEN: optionalText,
}).superRefine((env, ctx) => {
  const invalid = (name: string) => ctx.addIssue({ code: "custom", path: [name], message: "Invalid configuration" });
  if ((env.PG_MODEL_MODE === "mock" || env.PG_ADAPTER_MODE === "fake") &&
      !env.PG_FIXTURE_ID?.match(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)) invalid("PG_FIXTURE_ID");
  if (env.PG_MODEL_MODE === "live") {
    if (!env.OPENAI_API_KEY) invalid("OPENAI_API_KEY");
    if (!env.OPENAI_MODEL) invalid("OPENAI_MODEL");
  }
  if (env.PG_ADAPTER_MODE === "rest") {
    for (const name of restRequired) if (!env[name]) invalid(name);
    if (env.PG_GITHUB_REPOSITORY && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.PG_GITHUB_REPOSITORY)) invalid("PG_GITHUB_REPOSITORY");
    if (env.PG_GMAIL_MAILBOX && !z.email().safeParse(env.PG_GMAIL_MAILBOX).success) invalid("PG_GMAIL_MAILBOX");
    if (env.PG_SLACK_APPROVER_IDS && !/^[UW][A-Z0-9]+(?:,[UW][A-Z0-9]+)*$/.test(env.PG_SLACK_APPROVER_IDS)) invalid("PG_SLACK_APPROVER_IDS");
  }
  if (env.PG_MODEL_ROLE_BUDGET_MS < env.PG_MODEL_TIMEOUT_MS) invalid("PG_MODEL_ROLE_BUDGET_MS");
  if (resolve(env.PG_DATABASE_PATH) === resolve(env.PG_CHECKPOINT_PATH)) invalid("PG_CHECKPOINT_PATH");
  if ([env.PG_DATABASE_PATH, env.PG_CHECKPOINT_PATH].some(path => resolve(path) === resolve(env.PG_EVIDENCE_DIR))) invalid("PG_EVIDENCE_DIR");
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    // Never print Zod issues/inputs: they may contain tokens, paths or private IDs.
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join(".")))];
    throw new Error(`Invalid server configuration: ${fields.join(", ")}. Check .env.example; mock/fake modes require PG_FIXTURE_ID and live modes require their credentials.`);
  }
  const value = parsed.data;
  return {
    host: value.PG_HOST,
    port: value.PG_PORT,
    modelMode: value.PG_MODEL_MODE,
    adapterMode: value.PG_ADAPTER_MODE,
    fixtureId: value.PG_MODEL_MODE === "mock" || value.PG_ADAPTER_MODE === "fake" ? value.PG_FIXTURE_ID! : null,
    storage: { databasePath: resolve(value.PG_DATABASE_PATH), checkpointPath: resolve(value.PG_CHECKPOINT_PATH), evidenceDir: resolve(value.PG_EVIDENCE_DIR) },
    model: {
      name: value.OPENAI_MODEL,
      roles: { analyst: value.OPENAI_MODEL_ANALYST || value.OPENAI_MODEL, drafter: value.OPENAI_MODEL_DRAFTER || value.OPENAI_MODEL, auditor: value.OPENAI_MODEL_AUDITOR || value.OPENAI_MODEL },
      timeoutMs: value.PG_MODEL_TIMEOUT_MS, roleBudgetMs: value.PG_MODEL_ROLE_BUDGET_MS,
      maxAttempts: value.PG_MODEL_MAX_ATTEMPTS, maxOutputTokens: value.PG_MODEL_MAX_OUTPUT_TOKENS, maxInputChars: value.PG_MODEL_MAX_INPUT_CHARS,
    },
    accounts: {
      githubRepository: value.PG_GITHUB_REPOSITORY, hubspotPortalId: value.PG_HUBSPOT_PORTAL_ID,
      slackTeamId: value.PG_SLACK_TEAM_ID, slackChannelId: value.PG_SLACK_CHANNEL_ID,
      slackApproverIds: value.PG_SLACK_APPROVER_IDS?.split(",") ?? [], gmailMailbox: value.PG_GMAIL_MAILBOX,
    },
    secrets: {
      openaiApiKey: value.OPENAI_API_KEY, githubToken: value.PG_GITHUB_TOKEN, githubReaderToken: value.PG_GITHUB_READER_TOKEN,
      hubspotAccessToken: value.PG_HUBSPOT_ACCESS_TOKEN, hubspotReaderToken: value.PG_HUBSPOT_READER_TOKEN,
      slackBotToken: value.PG_SLACK_BOT_TOKEN, slackReaderToken: value.PG_SLACK_READER_TOKEN,
      gmailClientId: value.PG_GMAIL_CLIENT_ID, gmailClientSecret: value.PG_GMAIL_CLIENT_SECRET,
      gmailRefreshToken: value.PG_GMAIL_REFRESH_TOKEN, gmailReaderRefreshToken: value.PG_GMAIL_READER_REFRESH_TOKEN,
    },
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

/** R01 can close over injected model/provider clients here; none are serialized. */
export interface ApplicationServices {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  webRoot?: string;
  createServices?: (config: AppConfig) => ApplicationServices | Promise<ApplicationServices>;
}

async function closeAfterFailure(app: FastifyInstance, error: unknown): Promise<never> {
  try { await app.close(); }
  catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Application startup and cleanup failed.", { cause: error });
  }
  throw error;
}

export async function createApp(options: BootstrapOptions = {}): Promise<FastifyInstance> {
  const config = loadConfig(options.env);
  const webRoot = options.webRoot ?? fileURLToPath(new URL("../../dist/web/", import.meta.url));
  try { await access(resolve(webRoot, "index.html")); }
  catch { throw new Error("Browser build is missing. Run npm run build:web before starting the application."); }
  const services = await options.createServices?.(config);
  const app = Fastify({ logger: false });
  app.addHook("onReady", async () => { await services?.start?.(); });
  app.addHook("preClose", async () => { await services?.stop?.(); });
  app.addHook("onClose", async () => {
    try { await services?.flush?.(); }
    finally { await services?.close?.(); }
  });
  app.get("/api/health", async () => ({
    status: "ok", scope: "bootstrap", modelMode: config.modelMode,
    adapterMode: config.adapterMode, fixtureId: config.fixtureId,
  }));
  try {
    await app.register(fastifyStatic, { root: resolve(webRoot), index: "index.html" });
    await app.ready();
    return app;
  } catch (error) {
    return closeAfterFailure(app, error);
  }
}

export async function startServer(options: BootstrapOptions = {}) {
  const config = loadConfig(options.env);
  const app = await createApp(options);
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  app.server.once("close", () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.listen({ port: config.port, host: config.host });
    return app;
  } catch (error) {
    return closeAfterFailure(app, error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(app => {
    process.stdout.write(`PromiseGuard application scaffold listening on ${app.listeningOrigin}\n`);
  }).catch(error => {
    // Configuration/build errors are curated above. Other failures may include secrets.
    const message = error instanceof Error && /^(Invalid server configuration:|Browser build is missing\.)/.test(error.message)
      ? error.message : "Application startup failed; check the local configuration and port availability.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
