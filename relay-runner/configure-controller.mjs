import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.argv[2] || path.join(scriptDir, "config.json"));

try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const existing = config.controller && typeof config.controller === "object" && !Array.isArray(config.controller)
    ? config.controller
    : {};
  config.controller = {
    host: "0.0.0.0",
    port: 38712,
    launchdLabel: "com.lukakai.sillytavern-im-bridge-relay",
    runnerPlistPath: "~/Library/LaunchAgents/com.lukakai.sillytavern-im-bridge-relay.plist",
    keychainService: "SillyTavern IM Bridge Relay Control",
    keychainAccount: "relay-control",
    ...existing,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`已写入控制器配置：${configPath}`);
} catch (error) {
  console.error(`[IM Bridge Relay Controller] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
