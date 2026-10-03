import { readFile } from "node:fs/promises";
import { runBot } from "./telegram/bot.ts";
import type { TopTrendingConfig } from "./top-trending.ts";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateConfig(config: any): TopTrendingConfig {
  const value = config?.top_trending;
  if (!value || value.enabled !== true) throw new Error("Set top_trending.enabled to true in config.json");

  const numericFields = [
    "min_market_cap_usd",
    "min_token_age_hours",
    "max_token_age_days",
    "min_holders",
    "min_tvl_usd",
    "min_organic_score",
  ];
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100) {
    throw new Error("top_trending.limit must be an integer from 1 to 100");
  }
  for (const field of numericFields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) {
      throw new Error(`top_trending.${field} must be a non-negative number`);
    }
  }
  if (value.min_organic_score > 100) throw new Error("top_trending.min_organic_score cannot exceed 100");
  if (value.max_token_age_days * 24 < value.min_token_age_hours) {
    throw new Error("top_trending.max_token_age_days must not be less than the minimum token age");
  }
  if (!Number.isInteger(value.min_holders)) throw new Error("top_trending.min_holders must be an integer");
  return value as TopTrendingConfig;
}

const configPath = process.env.CONFIG_PATH || "./config.json";
let rawConfig: string;
try {
  rawConfig = await readFile(configPath, "utf8");
} catch {
  throw new Error(`Cannot read ${configPath}. Copy config.example.json to config.json first.`);
}

const config = JSON.parse(rawConfig);
const topTrending = validateConfig(config);
const meteoraBaseUrl = config.candles?.providers?.meteora?.base_url;
const jupiterTokensBaseUrl = config.jupiter?.tokens_base_url;
if (typeof meteoraBaseUrl !== "string" || typeof jupiterTokensBaseUrl !== "string") {
  throw new Error("config.json must define candles.providers.meteora.base_url and jupiter.tokens_base_url");
}

await runBot({
  token: requiredEnv("TELEGRAM_BOT_TOKEN"),
  chatId: requiredEnv("TELEGRAM_CHAT_ID"),
  jupiterApiKey: requiredEnv("JUPITER_API_KEY"),
  gmgnApiKey: process.env.GMGN_API_KEY?.trim(),
  config: topTrending,
  meteoraBaseUrl,
  jupiterTokensBaseUrl,
});
