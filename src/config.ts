import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function requireJsonEnv(name: string): string {
  const value = requireEnv(name);
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  return value;
}

const LLM_PROVIDERS = ["claude", "gemini", "ollama"] as const;
const rawLlmProvider = process.env.LLM_PROVIDER ?? "claude";
if (!(LLM_PROVIDERS as readonly string[]).includes(rawLlmProvider)) {
  throw new Error(`Invalid LLM_PROVIDER "${rawLlmProvider}" — expected one of: ${LLM_PROVIDERS.join(", ")}`);
}
const llmProvider = rawLlmProvider as (typeof LLM_PROVIDERS)[number];

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function parseLogLevel(value: string | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value ?? "") ? (value as LogLevel) : "info";
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  ownerTelegramId: requireEnv("OWNER_TELEGRAM_ID"),
  // Cada credencial de LLM solo es obligatoria cuando ese proveedor está
  // activo — con Ollama/Gemini el bot no debe depender de la otra.
  anthropicApiKey: llmProvider === "claude" ? requireEnv("ANTHROPIC_API_KEY") : "",
  geminiApiKey: llmProvider === "gemini" ? requireEnv("GEMINI_API_KEY") : "",
  googleServiceAccountKey: requireJsonEnv("GOOGLE_SERVICE_ACCOUNT_KEY"),
  spreadsheetId: requireEnv("SPREADSHEET_ID"),
  llmProvider,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
  port: Number(process.env.PORT ?? 8080),
  webhookSecretToken: process.env.WEBHOOK_SECRET_TOKEN ?? "",
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
};
