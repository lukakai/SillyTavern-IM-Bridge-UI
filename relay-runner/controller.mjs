import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEYCHAIN_SERVICE = "SillyTavern IM Bridge Relay Control";
const DEFAULT_KEYCHAIN_ACCOUNT = "relay-control";
const DEFAULT_LABEL = "com.lukakai.sillytavern-im-bridge-relay";
const MAX_BODY_BYTES = 1024;
const ACTIONS = new Set(["start", "stop", "restart", "refresh"]);

function expandHome(value) {
  const text = String(value ?? "").trim();
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function loadConfig() {
  const requested = process.argv[2] || process.env.ST_RELAY_CONFIG || path.join(scriptDir, "config.json");
  const configPath = expandHome(requested);
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (error) {
    throw new Error(`无法读取中继配置 ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const control = config.controller;
  if (!control || typeof control !== "object" || Array.isArray(control)) {
    throw new Error("config.json 缺少 controller 配置");
  }
  const port = Number(control.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("controller.port 必须是 1–65535 的端口号");
  const host = String(control.host ?? "").trim();
  if (!host) throw new Error("controller.host 不能为空");
  const label = String(control.launchdLabel ?? DEFAULT_LABEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("controller.launchdLabel 格式无效");
  const runnerPlistPath = expandHome(control.runnerPlistPath ?? `~/Library/LaunchAgents/${label}.plist`);
  if (!fs.existsSync(runnerPlistPath)) throw new Error(`无头浏览器 launchd 配置不存在：${runnerPlistPath}`);
  return {
    host,
    port,
    label,
    runnerPlistPath,
    keychainService: String(control.keychainService ?? DEFAULT_KEYCHAIN_SERVICE),
    keychainAccount: String(control.keychainAccount ?? DEFAULT_KEYCHAIN_ACCOUNT),
  };
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error });
    });
  });
}

async function readToken(config) {
  const result = await run("/usr/bin/security", [
    "find-generic-password", "-a", config.keychainAccount, "-s", config.keychainService, "-w",
  ]);
  const token = result.ok ? result.stdout.trim() : "";
  if (token.length < 24) throw new Error("控制器 Token 未写入 macOS 钥匙串，或长度不足 24 位");
  return token;
}

function target(config) {
  return `gui/${process.getuid()}/${config.label}`;
}

async function status(config) {
  const result = await run("/bin/launchctl", ["print", target(config)]);
  const output = `${result.stdout}\n${result.stderr}`;
  const pid = Number(output.match(/\bpid = (\d+)/)?.[1] ?? 0) || null;
  return {
    reachable: true,
    state: result.ok && /\bstate = running\b/.test(output) ? "running" : result.ok ? "stopped" : "stopped",
    label: config.label,
    pid,
    message: result.ok ? null : "无头浏览器服务未加载或已停止",
  };
}

async function execute(config, action) {
  const serviceTarget = target(config);
  let result;
  if (action === "stop") {
    // bootout removes the job from launchd, so a KeepAlive runner cannot
    // silently start again after Telegram reports it stopped.
    result = await run("/bin/launchctl", ["bootout", serviceTarget]);
  } else {
    const current = await status(config);
    result = current.state === "running"
      ? await run("/bin/launchctl", ["kickstart", "-k", serviceTarget])
      : await run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, config.runnerPlistPath]);
  }
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "launchctl failed").trim().slice(0, 500);
    throw new Error(detail);
  }
  const updated = await status(config);
  return action === "stop" ? { ...updated, state: "stopped", pid: null } : updated;
}

function reply(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("请求不是有效 JSON")); }
    });
    req.on("error", reject);
  });
}

async function main() {
  const config = loadConfig();
  const token = await readToken(config);
  const server = createServer(async (req, res) => {
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${token}`) {
      reply(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/v1/status") {
        reply(res, 200, await status(config));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/relay") {
        const body = await readJson(req);
        const action = String(body?.action ?? "");
        if (!ACTIONS.has(action)) {
          reply(res, 400, { error: "unsupported_action" });
          return;
        }
        reply(res, 200, await execute(config, action));
        return;
      }
      reply(res, 404, { error: "not_found" });
    } catch (error) {
      console.error("[IM Bridge Relay Controller] request failed", error);
      reply(res, 502, { error: error instanceof Error ? error.message.slice(0, 500) : "controller_failed" });
    }
  });
  server.listen(config.port, config.host, () => {
    console.log(`[IM Bridge Relay Controller] listening on http://${config.host}:${config.port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`[IM Bridge Relay Controller] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
