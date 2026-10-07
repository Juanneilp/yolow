import { chmod, lstat, readFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import { YolowAgent } from "./agent.ts";
import { parseConfig } from "./config/config.ts";
import { loadSigner } from "./execution/executor.ts";
import { getMeta, openDatabase } from "./storage/db.ts";
import { runBot } from "./telegram/bot.ts";
import { createCommandHandler } from "./telegram/commands.ts";
import { telegramApiBase } from "./security.ts";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function securePrivateFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await lstat(path);
  if (file.isSymbolicLink() || !file.isFile()) throw new Error("Sensitive configuration must be stored in regular files");
  if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
    throw new Error("Sensitive configuration must be owned by the user running Yolow");
  }
  if ((file.mode & 0o077) !== 0) await chmod(path, 0o600);
}

// Files created by SQLite, backups and exports can contain private trading data.
process.umask(0o077);
await securePrivateFile(".env");

const configPath = process.env.CONFIG_PATH || "./config.json";
let configText: string;
try {
  await securePrivateFile(configPath);
  configText = await readFile(configPath, "utf8");
}
catch { throw new Error("Cannot read configuration file; check CONFIG_PATH and file permissions."); }
const config = parseConfig(configText);
const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
telegramApiBase(telegramToken);
const chatId = requiredEnv("TELEGRAM_CHAT_ID");
if (!/^-?\d+$/.test(chatId)) throw new Error("TELEGRAM_CHAT_ID must be numeric");
const telegramUserId = process.env.TELEGRAM_USER_ID?.trim();
if (telegramUserId && !/^\d+$/.test(telegramUserId)) throw new Error("TELEGRAM_USER_ID must be numeric");
const heliusKey = requiredEnv("HELIUS_API_KEY");
const wallet = new PublicKey(requiredEnv("AGENT_WALLET_PUBKEY"));
const jupiterApiKey = process.env.JUPITER_API_KEY?.trim();
if ((config.swap.enabled || config.top_trending.enabled) && !jupiterApiKey) {
  throw new Error("JUPITER_API_KEY is required when swaps or Top Trending are enabled");
}

function addApiKey(endpoint: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("api-key", heliusKey);
  return url.toString();
}

const connection = new Connection(addApiKey(config.rpc.http_base), {
  wsEndpoint: addApiKey(config.rpc.ws_base), commitment: "confirmed",
});
const db = openDatabase(process.env.DB_PATH || "./data/yolow.db");
const keypairPath = process.env.AGENT_KEYPAIR_PATH?.trim();
const agent = new YolowAgent({
  connection, wallet, db, config, telegramToken, chatId, jupiterApiKey, keypairPath,
});

const storedDryRun = getMeta(db, "dry_run");
const startupDryRun = storedDryRun === undefined ? config.mode.dry_run : storedDryRun !== "false";
if (!startupDryRun) {
  if (!keypairPath) throw new Error("AGENT_KEYPAIR_PATH is required when mode.dry_run is false");
  agent.executor.setSigner(await loadSigner(keypairPath, wallet));
}

const shutdown = new AbortController();
let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping Yolow after ${signal}...`);
  shutdown.abort();
  await agent.stop();
}
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await agent.start();
const commandHandler = createCommandHandler({
  agent, db, connection, wallet, telegramToken, chatId, keypairPath, config, configPath, jupiterApiKey,
});
await runBot({
  token: telegramToken, chatId, userId: telegramUserId || chatId,
  config: config.top_trending, trendingEnabled: () => config.top_trending.enabled,
  jupiterApiKey: jupiterApiKey ?? "", gmgnApiKey: process.env.GMGN_API_KEY?.trim(),
  meteoraBaseUrl: config.candles.providers.meteora?.base_url,
  jupiterTokensBaseUrl: config.jupiter.tokens_base_url,
  onCommand: commandHandler.onCommand,
  onCallback: commandHandler.onCallback,
  onText: commandHandler.onText,
  signal: shutdown.signal,
});
