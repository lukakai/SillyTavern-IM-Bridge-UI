import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const RELAY_STORAGE_KEY = "st-im-bridge.web-relay.enabled";
const DEFAULT_KEYCHAIN_SERVICE = "SillyTavern IM Bridge Basic Auth";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function expandHome(value) {
  const text = String(value ?? "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function loadConfig() {
  const requested = process.argv[2] || process.env.ST_RELAY_CONFIG || path.join(scriptDir, "config.json");
  const configPath = expandHome(requested);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取中继配置 ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = new URL(String(parsed.url ?? ""));
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("url 必须使用 http 或 https");
  return { ...parsed, url: url.href, configPath };
}

function readBasicAuthPassword(config) {
  if (process.env.ST_BASIC_AUTH_PASSWORD) return process.env.ST_BASIC_AUTH_PASSWORD;
  if (!config.basicAuthUsername) return null;
  const service = config.keychainService || DEFAULT_KEYCHAIN_SERVICE;
  try {
    return execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-a", String(config.basicAuthUsername),
      "-s", String(service),
      "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error([
      `无法从 macOS 钥匙串读取 Basic Auth 密码（账号：${config.basicAuthUsername}，服务：${service}）。`,
      "请先按 README 的 security add-generic-password 命令写入，或临时设置 ST_BASIC_AUTH_PASSWORD。",
    ].join("\n"));
  }
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}不存在：${filePath}`);
  return filePath;
}

async function waitForRelay(page) {
  await page.waitForFunction(async () => {
    try {
      const response = await fetch("/api/plugins/st-im-bridge/web-relay/status", { credentials: "same-origin" });
      if (!response.ok) return false;
      const status = await response.json();
      return status?.online === true;
    } catch {
      return false;
    }
  }, null, { timeout: 120_000, polling: 1_000 });
}

async function main() {
  const config = loadConfig();
  const executablePath = requireFile(expandHome(config.chromeExecutable), "Chrome 可执行文件");
  const profileDir = expandHome(config.profileDir || "~/Library/Application Support/SillyTavern-IM-Bridge");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(profileDir, 0o700); } catch { /* best effort */ }

  const password = readBasicAuthPassword(config);
  const httpCredentials = config.basicAuthUsername
    ? { username: String(config.basicAuthUsername), password: String(password ?? ""), send: "always" }
    : undefined;
  const headless = config.headless !== false;
  console.log(`[IM Bridge Relay] 启动 ${headless ? "无头" : "可见"} Chrome`);
  console.log(`[IM Bridge Relay] 酒馆地址：${config.url}`);
  console.log(`[IM Bridge Relay] Profile：${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    httpCredentials,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors === true,
    acceptDownloads: false,
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await context.addInitScript((storageKey) => {
    try { localStorage.setItem(storageKey, "true"); } catch { /* opaque origin */ }
  }, RELAY_STORAGE_KEY);

  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[SillyTavern] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.error(`[SillyTavern] 页面错误：${error.message}`));
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 120_000 });

  try {
    await waitForRelay(page);
  } catch {
    if (!headless) {
      throw new Error("网页中继未能上线。请确认 server plugin/UI 扩展已更新，并在可见窗口中完成 SillyTavern 登录。");
    }
    throw new Error("网页中继未能上线。可把 config.json 的 headless 改为 false 后重试，以查看登录或扩展错误。");
  }
  console.log("[IM Bridge Relay] 网页中继已在线，可以在 Telegram 使用 /prompt web");

  let stopping = false;
  const lifetime = new Promise((resolve, reject) => {
    const stop = () => { stopping = true; resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    page.once("crash", () => reject(new Error("Chrome 页面崩溃")));
    page.once("close", () => { if (!stopping) reject(new Error("Chrome 页面意外关闭")); });
    context.once("close", () => { if (!stopping) reject(new Error("Chrome 上下文意外关闭")); });
  });

  try {
    await lifetime;
  } finally {
    stopping = true;
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[IM Bridge Relay] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
