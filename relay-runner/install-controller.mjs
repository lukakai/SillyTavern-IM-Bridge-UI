import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const label = "com.lukakai.sillytavern-im-bridge-relay-controller";
const configPath = path.resolve(process.argv[2] || path.join(scriptDir, "config.json"));
const controllerPath = path.join(scriptDir, "controller.mjs");
const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(agentsDir, `${label}.plist`);
const logsDir = path.join(os.homedir(), "Library", "Logs");

function launchctl(args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    execFile("/bin/launchctl", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve();
    });
  });
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function main() {
  if (!fs.existsSync(configPath)) throw new Error(`中继配置不存在：${configPath}`);
  if (!fs.existsSync(controllerPath)) throw new Error(`控制器脚本不存在：${controllerPath}`);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(controllerPath)}</string><string>${xml(configPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logsDir, `${label}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, `${label}.error.log`))}</string>
</dict></plist>\n`;
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  await launchctl(["bootout", `gui/${process.getuid()}/${label}`], true);
  await launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath]);
  console.log(`已安装并启动 ${label}`);
}

main().catch((error) => {
  console.error(`[IM Bridge Relay Controller] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
