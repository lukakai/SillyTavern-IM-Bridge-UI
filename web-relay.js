import { getContext } from "../../../extensions.js";
import { getPresetManager } from "../../../preset-manager.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { worldInfoCache } from "../../../world-info.js";

const PLUGIN_BASE = "/api/plugins/st-im-bridge";
const ENABLED_KEY = "st-im-bridge.web-relay.enabled";
const WORKER_KEY = "st-im-bridge.web-relay.worker-id";
const SETTINGS_BACKUP_KEY = "st-im-bridge.global-settings.backup.v1";
const PRESET_PANEL_ROOT_ID = "th-orb-prism-v2";
const RELAY_VERSION = "1.2.2";
const POLL_WAIT_MS = 25_000;
const RETRY_DELAY_MS = 3_000;
const GENERATION_IDLE_WAIT_MS = 300_000;

let csrfTokenCache = null;
let loopController = null;
let loopPromise = null;
let activeJobId = null;
let presetPanelLayoutCache = null;
const listeners = new Set();

const state = {
  enabled: localStorage.getItem(ENABLED_KEY) === "true",
  phase: "disabled",
  activeJobId: null,
  lastError: null,
  lastSeenAt: null,
};

function createWorkerId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  return `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function workerId() {
  let id = sessionStorage.getItem(WORKER_KEY);
  if (!id) {
    id = createWorkerId();
    sessionStorage.setItem(WORKER_KEY, id);
  }
  return id;
}

function pageUrl() {
  return `${location.pathname}${location.search}`.slice(0, 500);
}

function notify(patch = {}) {
  Object.assign(state, patch);
  const snapshot = { ...state };
  for (const listener of listeners) {
    try { listener(snapshot); } catch (error) { console.warn("[IM Bridge Relay] status listener failed", error); }
  }
}

function abortError(error) {
  return error?.name === "AbortError" || /abort/i.test(String(error?.message ?? ""));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function getCsrfToken(signal) {
  if (csrfTokenCache) return csrfTokenCache;
  const response = await fetch("/csrf-token", { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`csrf-token failed: ${response.status}`);
  const json = await response.json();
  csrfTokenCache = json.token;
  return csrfTokenCache;
}

async function relayApi(path, body, signal) {
  const buildInit = async () => ({
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": await getCsrfToken(signal),
    },
    body: JSON.stringify(body),
    signal,
  });
  let response = await fetch(PLUGIN_BASE + path, await buildInit());
  if (response.status === 403) {
    const text = await response.clone().text();
    if (/csrf/i.test(text)) {
      csrfTokenCache = null;
      response = await fetch(PLUGIN_BASE + path, await buildInit());
    }
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text || response.statusText;
    try { message = JSON.parse(text)?.error?.message || message; } catch { /* plain response */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function identity(extra = {}) {
  return {
    workerId: workerId(),
    relayVersion: RELAY_VERSION,
    pageUrl: pageUrl(),
    ...extra,
  };
}

function normalizeChatId(value) {
  return String(value ?? "").replace(/\.jsonl$/i, "");
}

function currentTarget(context) {
  const character = context.characters?.[Number(context.characterId)];
  return {
    avatar: character?.avatar ?? null,
    chatId: context.chatId ?? null,
  };
}

function generationBusy() {
  const context = getContext();
  if (context.streamingProcessor) return true;
  const stopButton = document.querySelector("#mes_stop");
  if (!stopButton) return false;
  const style = getComputedStyle(stopButton);
  return style.display !== "none" && style.visibility !== "hidden";
}

function slashCommand(name) {
  const command = SlashCommandParser.commands?.[name];
  if (!command || typeof command.callback !== "function") {
    throw new Error(`酒馆前端命令 /${name} 尚未就绪`);
  }
  return command;
}

async function runSlashCommand(name, args = {}, value = "") {
  return slashCommand(name).callback(args, value);
}

function parseStringList(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map(item => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function readSettingsBackup() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_BACKUP_KEY) || "null");
    if (!parsed || parsed.version !== 1 || !parsed.state || typeof parsed.state !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readPromptStates(identifiers) {
  if (identifiers.length === 0) return new Map();
  const result = await runSlashCommand("getpromptentry", { identifier: identifiers, return: "dict" });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("酒馆前端未能读取当前预设选项状态");
  }
  return new Map(Object.entries(result).filter(([, enabled]) => typeof enabled === "boolean"));
}

function presetPanelRoot() {
  return document.getElementById(PRESET_PANEL_ROOT_ID);
}

function presetPanelProfiles(root = presetPanelRoot()) {
  if (!root) return [];
  return Array.from(root.querySelectorAll('.pv2-seg button[data-model]')).flatMap((button) => {
    const id = String(button.dataset.model ?? "").trim();
    const label = String(button.textContent ?? "").trim();
    if (!id || !label) return [];
    return [{ id, label, active: button.getAttribute("aria-pressed") === "true" }];
  });
}

async function ensurePresetPanelLoaded(root) {
  const panel = root?.querySelector(".pv2-panel");
  const orb = root?.querySelector(".pv2-orb");
  if (!panel || !orb) return null;
  const wasOpen = panel.classList.contains("pv2-open");
  if (!panel.querySelector("[data-nav] .pv2-gcard[data-g]")) {
    for (let attempt = 0; attempt < 3 && !panel.classList.contains("pv2-open"); attempt += 1) {
      orb.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      await delay(80);
    }
    try {
      await waitUntil(
        () => Boolean(panel.querySelector("[data-nav] .pv2-gcard[data-g]")),
        15_000,
        "预设悬浮窗未能加载分类",
      );
    } catch (error) {
      console.warn("[IM Bridge Relay] preset panel categories unavailable", error);
    }
  }
  return { panel, wasOpen };
}

function presetPanelZone(card) {
  for (let node = card?.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList?.contains("pv2-zh")) return String(node.textContent ?? "").trim() || "预设选项";
  }
  return "预设选项";
}

async function readPresetPanelExtras(prompts, currentPreset) {
  const root = presetPanelRoot();
  if (!root || presetPanelProfiles(root).length === 0) {
    presetPanelLayoutCache = null;
    return { presetProfiles: [], promptLayout: [] };
  }
  const identifiersKey = prompts.map(prompt => prompt.identifier).join("\n");
  if (presetPanelLayoutCache
    && presetPanelLayoutCache.currentPreset === currentPreset
    && presetPanelLayoutCache.identifiersKey === identifiersKey
    && Date.now() - presetPanelLayoutCache.savedAt < 30_000) {
    return { presetProfiles: presetPanelProfiles(root), promptLayout: presetPanelLayoutCache.promptLayout };
  }
  const ready = await ensurePresetPanelLoaded(root);
  const presetProfiles = presetPanelProfiles(root);
  if (!ready) return { presetProfiles, promptLayout: [] };
  const { panel, wasOpen } = ready;
  const nav = panel.querySelector("[data-nav]");
  const validIdentifiers = new Set(prompts.map(prompt => prompt.identifier));
  const categoryMetadata = Array.from(nav?.querySelectorAll(".pv2-gcard[data-g]") ?? []).map(card => ({
    index: Number(card.dataset.g),
    name: String(card.querySelector(".pv2-gnm")?.textContent ?? "").trim(),
    zone: presetPanelZone(card),
  })).filter(category => Number.isInteger(category.index) && category.name);
  const categories = [];

  for (const category of categoryMetadata) {
    const button = nav?.querySelector(`.pv2-gcard[data-g="${category.index}"]`);
    if (!button) continue;
    if (button.getAttribute("aria-expanded") !== "true") {
      button.click();
      await delay(0);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const closedSubgroup = nav?.querySelector('[data-expand] .pv2-subhead[aria-expanded="false"]');
      if (!closedSubgroup) break;
      closedSubgroup.click();
      await delay(0);
    }
    const identifiers = [...new Set(Array.from(nav?.querySelectorAll("[data-expand] [data-rk]") ?? [])
      .map(element => String(element.dataset.rk ?? "").trim())
      .filter(identifier => identifier && validIdentifiers.has(identifier)))];
    if (identifiers.length > 0) categories.push({ ...category, identifiers });
  }

  if (!wasOpen && panel.classList.contains("pv2-open")) {
    panel.querySelector("[data-close]")?.click();
  }
  const sections = [];
  for (const category of categories) {
    let section = sections.find(item => item.name === category.zone);
    if (!section) {
      section = { name: category.zone, groups: [] };
      sections.push(section);
    }
    section.groups.push({ name: category.name, identifiers: category.identifiers });
  }
  presetPanelLayoutCache = {
    currentPreset,
    identifiersKey,
    promptLayout: sections,
    savedAt: Date.now(),
  };
  return { presetProfiles: presetPanelProfiles(root), promptLayout: sections };
}

async function applyPresetPanelProfile(name) {
  const root = presetPanelRoot();
  const profile = presetPanelProfiles(root).find(item => item.id === name);
  const button = Array.from(root?.querySelectorAll('.pv2-seg button[data-model]') ?? [])
    .find(item => String(item.dataset.model ?? "").trim() === name);
  const status = root?.querySelector("[data-sync]");
  if (!profile || !button || !status) throw new Error(`当前预设不支持模型方案：${name}`);
  button.click();
  await waitUntil(() => {
    const current = presetPanelProfiles(root).find(item => item.active);
    return current?.id === name && String(status.textContent ?? "").trim() !== "正在切换";
  }, 60_000, `预设内模型方案切换超时：${profile.label}`);
  if (String(status.textContent ?? "").trim() !== "已同步") {
    throw new Error(`预设内模型方案未完全同步：${profile.label}`);
  }
  presetPanelLayoutCache = null;
}

async function settingsSnapshot() {
  await ensureAppReady();
  const context = getContext();
  const presetManager = getPresetManager();
  if (!presetManager) throw new Error("酒馆聊天预设管理器尚未就绪");

  const profiles = parseStringList(await runSlashCommand("profile-list"));
  const currentProfileValue = String(await runSlashCommand("profile") ?? "").trim();
  const currentProfile = currentProfileValue && currentProfileValue !== "<None>" ? currentProfileValue : null;
  const presets = presetManager.getAllPresets().map(String).map(name => name.trim()).filter(Boolean);
  const currentPreset = String(await runSlashCommand("preset") ?? "").trim() || null;
  const currentModel = String(await runSlashCommand("model", { quiet: "true" }) ?? "").trim() || null;
  const settings = context.chatCompletionSettings ?? {};
  const promptsById = new Map(
    (Array.isArray(settings.prompts) ? settings.prompts : [])
      .map(prompt => [String(prompt?.identifier ?? "").trim(), prompt])
      .filter(([identifier]) => Boolean(identifier)),
  );
  const orderedIds = [];
  const seenIds = new Set();
  for (const container of Array.isArray(settings.prompt_order) ? settings.prompt_order : []) {
    for (const entry of Array.isArray(container?.order) ? container.order : []) {
      const identifier = String(entry?.identifier ?? "").trim();
      if (identifier && !seenIds.has(identifier)) {
        seenIds.add(identifier);
        orderedIds.push(identifier);
      }
    }
  }
  for (const identifier of promptsById.keys()) {
    if (!seenIds.has(identifier)) {
      seenIds.add(identifier);
      orderedIds.push(identifier);
    }
  }
  const states = await readPromptStates(orderedIds);
  const prompts = orderedIds.flatMap(identifier => {
    const prompt = promptsById.get(identifier);
    const name = String(prompt?.name ?? "").trim();
    const enabled = states.get(identifier);
    if (!prompt || !name || typeof enabled !== "boolean") return [];
    const empty = !String(prompt.content ?? "").trim();
    return [{
      identifier,
      name,
      enabled,
      toggleable: prompt.marker !== true && !empty,
      empty,
    }];
  });
  const presetPanel = await readPresetPanelExtras(prompts, currentPreset);
  const backup = readSettingsBackup();
  return {
    currentProfile,
    profiles,
    currentPreset,
    presets,
    currentModel,
    prompts,
    presetProfiles: presetPanel.presetProfiles,
    promptLayout: presetPanel.promptLayout,
    undoAvailable: Boolean(backup),
    undoSavedAt: backup?.savedAt ?? null,
  };
}

function restorableState(snapshot) {
  return {
    currentProfile: snapshot.currentProfile,
    currentPreset: snapshot.currentPreset,
    currentModel: snapshot.currentModel,
    currentPresetProfile: snapshot.presetProfiles.find(profile => profile.active)?.id ?? null,
    promptStates: Object.fromEntries(snapshot.prompts.map(prompt => [prompt.identifier, prompt.enabled])),
  };
}

function saveSettingsBackup(snapshot) {
  const backup = {
    version: 1,
    savedAt: new Date().toISOString(),
    state: restorableState(snapshot),
  };
  localStorage.setItem(SETTINGS_BACKUP_KEY, JSON.stringify(backup));
  return backup;
}

async function mutateSettings(action) {
  const before = await settingsSnapshot();
  let checkpointed = false;
  const checkpoint = () => {
    if (checkpointed) return;
    saveSettingsBackup(before);
    checkpointed = true;
  };
  await action(before, checkpoint);
  if (!checkpointed) throw new Error("全局设置操作没有建立撤销快照，已拒绝完成");
  await delay(800);
  return settingsSnapshot();
}

async function selectGlobalProfile(name) {
  return mutateSettings(async (before, checkpoint) => {
    if (!before.profiles.includes(name)) throw new Error(`连接配置不存在：${name}`);
    if (!before.currentProfile) {
      throw new Error("当前连接设置未绑定保存配置。为确保可以完整撤销，请先在酒馆 Connection Manager 中保存并选中当前配置");
    }
    checkpoint();
    const applied = String(await runSlashCommand("profile", { await: "true", timeout: "15000" }, name) ?? "").trim();
    if (applied !== name) throw new Error(`连接配置切换失败：${name}`);
  });
}

async function selectGlobalPreset(name) {
  return mutateSettings(async (before, checkpoint) => {
    if (!before.presets.includes(name)) throw new Error(`聊天预设不存在：${name}`);
    checkpoint();
    const applied = String(await runSlashCommand("preset", {}, name) ?? "").trim();
    if (applied !== name) throw new Error(`聊天预设切换失败：${name}`);
    presetPanelLayoutCache = null;
  });
}

async function selectGlobalPresetProfile(name) {
  return mutateSettings(async (before, checkpoint) => {
    if (!before.presetProfiles.some(profile => profile.id === name)) {
      throw new Error(`当前预设不支持模型方案：${name}`);
    }
    checkpoint();
    await applyPresetPanelProfile(name);
  });
}

async function selectGlobalModel(name) {
  return mutateSettings(async (_before, checkpoint) => {
    if (!name) throw new Error("模型名称不能为空");
    checkpoint();
    const applied = String(await runSlashCommand("model", { quiet: "true" }, name) ?? "").trim();
    if (!applied || applied.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
      throw new Error(`模型切换失败或当前 API 不支持该模型：${name}`);
    }
  });
}

async function setGlobalPromptEntries(identifiers, enabled) {
  const result = await mutateSettings(async (before, checkpoint) => {
    const requested = [...new Set((Array.isArray(identifiers) ? identifiers : []).map(String).map(value => value.trim()).filter(Boolean))];
    const allowed = new Set(before.prompts.filter(prompt => prompt.toggleable).map(prompt => prompt.identifier));
    if (requested.length === 0 || requested.length > 500 || requested.some(identifier => !allowed.has(identifier))) {
      throw new Error("预设选项已经变化，请重新打开 /preset 后再试");
    }
    checkpoint();
    await runSlashCommand("setpromptentry", { identifier: requested }, enabled ? "on" : "off");
  });
  const states = new Map(result.prompts.map(prompt => [prompt.identifier, prompt.enabled]));
  const requested = [...new Set((Array.isArray(identifiers) ? identifiers : []).map(String).map(value => value.trim()).filter(Boolean))];
  if (requested.some(identifier => states.get(identifier) !== enabled)) {
    throw new Error("部分预设选项未成功保存，可使用 /settingsundo 恢复修改前状态");
  }
  return result;
}

async function restoreSettingsBackup() {
  const backup = readSettingsBackup();
  if (!backup) throw new Error("当前没有可撤销的全局设置修改");
  const current = await settingsSnapshot();
  const state = backup.state;

  if (state.currentProfile !== current.currentProfile) {
    if (state.currentProfile) {
      const profiles = parseStringList(await runSlashCommand("profile-list"));
      if (!profiles.includes(state.currentProfile)) throw new Error(`备份中的连接配置已不存在：${state.currentProfile}`);
      const applied = String(await runSlashCommand("profile", { await: "true", timeout: "15000" }, state.currentProfile) ?? "").trim();
      if (applied !== state.currentProfile) throw new Error(`无法恢复备份连接配置：${state.currentProfile}`);
    } else {
      const applied = String(await runSlashCommand("profile", { await: "true", timeout: "15000" }, "<None>") ?? "").trim();
      if (applied !== "<None>") throw new Error("无法恢复未选择连接配置的状态");
    }
  }

  const afterProfile = await settingsSnapshot();
  if (state.currentPreset && state.currentPreset !== afterProfile.currentPreset) {
    if (!afterProfile.presets.includes(state.currentPreset)) throw new Error(`备份中的聊天预设已不存在：${state.currentPreset}`);
    const applied = String(await runSlashCommand("preset", {}, state.currentPreset) ?? "").trim();
    if (applied !== state.currentPreset) throw new Error(`无法恢复备份聊天预设：${state.currentPreset}`);
  }
  const afterPreset = await settingsSnapshot();
  if (state.currentPresetProfile
    && state.currentPresetProfile !== afterPreset.presetProfiles.find(profile => profile.active)?.id) {
    if (!afterPreset.presetProfiles.some(profile => profile.id === state.currentPresetProfile)) {
      throw new Error(`备份中的预设内模型方案已不存在：${state.currentPresetProfile}`);
    }
    await applyPresetPanelProfile(state.currentPresetProfile);
  }
  const afterPresetProfile = await settingsSnapshot();
  if (state.currentModel && state.currentModel.toLocaleLowerCase() !== afterPresetProfile.currentModel?.toLocaleLowerCase()) {
    const applied = String(await runSlashCommand("model", { quiet: "true" }, state.currentModel) ?? "").trim();
    if (applied.toLocaleLowerCase() !== state.currentModel.toLocaleLowerCase()) throw new Error(`无法恢复备份模型：${state.currentModel}`);
  }

  const available = new Set(afterPresetProfile.prompts.map(prompt => prompt.identifier));
  const entries = Object.entries(state.promptStates ?? {}).filter(([identifier, value]) => available.has(identifier) && typeof value === "boolean");
  const enabledIds = entries.filter(([, value]) => value).map(([identifier]) => identifier);
  const disabledIds = entries.filter(([, value]) => !value).map(([identifier]) => identifier);
  if (enabledIds.length > 0) await runSlashCommand("setpromptentry", { identifier: enabledIds }, "on");
  if (disabledIds.length > 0) await runSlashCommand("setpromptentry", { identifier: disabledIds }, "off");
  await delay(800);

  const restored = await settingsSnapshot();
  if (restored.currentProfile !== (state.currentProfile ?? null)
    || (state.currentPreset && restored.currentPreset !== state.currentPreset)
    || (state.currentPresetProfile
      && restored.presetProfiles.find(profile => profile.active)?.id !== state.currentPresetProfile)
    || (state.currentModel && restored.currentModel?.toLocaleLowerCase() !== state.currentModel.toLocaleLowerCase())) {
    throw new Error("全局设置未能完整恢复，撤销快照已保留，可修正酒馆配置后重试");
  }
  const restoredStates = new Map(restored.prompts.map(prompt => [prompt.identifier, prompt.enabled]));
  if (entries.some(([identifier, enabled]) => restoredStates.get(identifier) !== enabled)) {
    throw new Error("部分预设选项未能恢复，撤销快照已保留，可修正预设后重试");
  }
  saveSettingsBackup(current);
  return settingsSnapshot();
}

async function executeSettingsJob(job) {
  if (generationBusy()) throw new Error("酒馆网页正在生成，请结束后再打开或修改全局设置");
  const payload = job.controlPayload ?? {};
  switch (job.operation) {
    case "settings_snapshot":
      return settingsSnapshot();
    case "settings_select_profile":
      return selectGlobalProfile(String(payload.name ?? "").trim());
    case "settings_select_preset":
      return selectGlobalPreset(String(payload.name ?? "").trim());
    case "settings_select_preset_profile":
      return selectGlobalPresetProfile(String(payload.name ?? "").trim());
    case "settings_select_model":
      return selectGlobalModel(String(payload.name ?? "").trim());
    case "settings_set_prompt_entries":
      return setGlobalPromptEntries(payload.identifiers, payload.enabled === true);
    case "settings_undo":
      return restoreSettingsBackup();
    default:
      throw new Error(`不支持的酒馆全局设置操作：${job.operation}`);
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(message);
}

async function ensureAppReady() {
  await waitUntil(() => {
    const context = getContext();
    return Array.isArray(context.characters) && context.characters.length > 0;
  }, 60_000, "SillyTavern 尚未完成角色列表初始化");
}

async function ensureGenerationIdle() {
  await waitUntil(() => !generationBusy(), GENERATION_IDLE_WAIT_MS, "酒馆页面已有生成任务，等待空闲超时");
}

async function ensureTarget(job) {
  await ensureAppReady();
  await ensureGenerationIdle();
  let context = getContext();
  const characterIndex = context.characters.findIndex((character) => character?.avatar === job.avatar);
  if (characterIndex < 0) throw new Error(`酒馆网页未找到角色：${job.characterName} (${job.avatar})`);

  if (String(context.characterId) !== String(characterIndex)) {
    await context.selectCharacterById(characterIndex, { switchMenu: false });
  }

  context = getContext();
  if (normalizeChatId(context.chatId) !== normalizeChatId(job.chatFile)) {
    await context.openCharacterChat(job.chatFile);
  }

  // The server plugin can edit this chat while the relay tab is idle (TG edit,
  // swipe selection, compact/enhanced generation). Always refresh the in-memory
  // page state before running the native prompt pipeline.
  context = getContext();
  await context.reloadCurrentChat();

  await waitUntil(() => {
    const current = currentTarget(getContext());
    return current.avatar === job.avatar && normalizeChatId(current.chatId) === normalizeChatId(job.chatFile);
  }, 30_000, "酒馆网页切换到目标角色/会话超时");

  context = getContext();
  if (context.onlineStatus === "no_connection") throw new Error("酒馆网页的模型 API 当前未连接");
  return context;
}

function applyTemporaryModelOverride(context, requestedModel) {
  if (!requestedModel) return () => {};
  const currentModel = context.getChatCompletionModel?.();
  if (currentModel === requestedModel) return () => {};
  if (context.mainApi !== "openai" || !context.chatCompletionSettings || !context.getChatCompletionModel) {
    throw new Error(`网页完整模式无法临时切换当前 API 的模型；TG 选择的是 ${requestedModel}`);
  }

  const settings = context.chatCompletionSettings;
  const candidateKeys = Object.keys(settings).filter((key) => key === "model" || key.endsWith("_model"));
  const key = candidateKeys.find((candidateKey) => {
    try {
      return context.getChatCompletionModel({ ...settings, [candidateKey]: requestedModel }) === requestedModel;
    } catch {
      return false;
    }
  });
  if (!key) {
    throw new Error(`无法把酒馆网页临时切换到 TG 选择的模型：${requestedModel}`);
  }

  const previous = settings[key];
  settings[key] = requestedModel;
  return () => { settings[key] = previous; };
}

function latestAssistant(context) {
  for (let index = context.chat.length - 1; index >= 0; index -= 1) {
    const message = context.chat[index];
    if (!message?.is_system && !message?.is_user && typeof message?.mes === "string" && message.mes.trim()) {
      return { index, message };
    }
  }
  return null;
}

async function executeJob(job) {
  let heartbeatTimer = null;
  activeJobId = job.id;
  const generationJob = job.operation === "send" || job.operation === "regenerate";
  notify({ phase: generationJob ? "generating" : "configuring", activeJobId: job.id, lastError: null });
  const sendHeartbeat = () => relayApi("/web-relay/heartbeat", identity({ activeJobId: job.id }))
    .catch((error) => console.warn("[IM Bridge Relay] heartbeat during generation failed", error));
  heartbeatTimer = setInterval(sendHeartbeat, 10_000);

  try {
    if (!generationJob) {
      const result = await executeSettingsJob(job);
      await relayApi(`/web-relay/jobs/${encodeURIComponent(job.id)}/complete`, {
        ...identity(),
        result,
      });
      notify({ phase: "online", lastSeenAt: new Date().toISOString(), lastError: null });
      return;
    }
    const context = await ensureTarget(job);
    // World books can be edited from Telegram while this dedicated tab is
    // idle. Force the native prompt pipeline to fetch the latest saved data.
    worldInfoCache.clear();
    const restoreModel = applyTemporaryModelOverride(context, job.modelOverride);
    try {
      if (job.operation === "send") {
        const textarea = document.querySelector("#send_textarea");
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("酒馆网页未找到消息输入框");
        if (textarea.value.trim()) throw new Error("专用中继页面存在未发送的草稿，请先清空输入框");
        textarea.value = String(job.text ?? "");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await context.generate("normal");
      } else if (job.operation === "regenerate") {
        const before = latestAssistant(context);
        if (!before) throw new Error("当前会话没有可重新生成的角色回复");
        await context.generate("regenerate");
      } else {
        throw new Error(`不支持的网页中继操作：${job.operation}`);
      }

      // Auto-continue may start immediately after Generate() resolves.
      await delay(150);
      await ensureGenerationIdle();
    } finally {
      restoreModel();
    }

    const resultContext = getContext();
    const target = currentTarget(resultContext);
    if (target.avatar !== job.avatar || normalizeChatId(target.chatId) !== normalizeChatId(job.chatFile)) {
      throw new Error("生成过程中酒馆页面的角色或会话发生变化");
    }
    const assistant = latestAssistant(resultContext);
    if (!assistant) throw new Error("生成结束后没有找到角色回复");
    await relayApi(`/web-relay/jobs/${encodeURIComponent(job.id)}/complete`, {
      ...identity(),
      messageIndex: assistant.index,
      chatId: target.chatId,
      characterAvatar: target.avatar,
    });
    notify({ phase: "online", lastSeenAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await relayApi(`/web-relay/jobs/${encodeURIComponent(job.id)}/fail`, {
        ...identity(),
        message,
      });
    } catch (reportError) {
      console.error("[IM Bridge Relay] failed to report job error", reportError);
    }
    notify({ phase: "error", lastError: message });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    activeJobId = null;
    notify({ activeJobId: null });
  }
}

async function runWorker(signal) {
  notify({ phase: "connecting", lastError: null });
  while (!signal.aborted && localStorage.getItem(ENABLED_KEY) === "true") {
    try {
      const heartbeat = await relayApi("/web-relay/heartbeat", identity({ activeJobId }), signal);
      notify({ phase: "online", lastSeenAt: heartbeat?.lastSeenAt ?? new Date().toISOString(), lastError: null });
      const result = await relayApi("/web-relay/poll", identity({ waitMs: POLL_WAIT_MS }), signal);
      if (result?.job) await executeJob(result.job);
    } catch (error) {
      if (signal.aborted || abortError(error)) break;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[IM Bridge Relay] worker loop failed", error);
      notify({ phase: "error", lastError: message });
      await delay(RETRY_DELAY_MS, signal).catch(() => {});
    }
  }
}

async function runWithLeaderLock(signal) {
  if (!navigator.locks?.request) {
    await runWorker(signal);
    return;
  }
  notify({ phase: "waiting", lastError: null });
  await navigator.locks.request("st-im-bridge-web-relay", { mode: "exclusive", signal }, async () => {
    if (!signal.aborted) await runWorker(signal);
  });
}

function startLoop() {
  if (loopPromise || !state.enabled) return;
  loopController = new AbortController();
  loopPromise = runWithLeaderLock(loopController.signal)
    .catch((error) => {
      if (!abortError(error)) {
        console.error("[IM Bridge Relay] stopped unexpectedly", error);
        notify({ phase: "error", lastError: error instanceof Error ? error.message : String(error) });
      }
    })
    .finally(() => {
      loopController = null;
      loopPromise = null;
      if (!state.enabled) notify({ phase: "disabled", activeJobId: null });
    });
}

export function getWebRelayState() {
  return { ...state };
}

export function subscribeWebRelay(listener) {
  listeners.add(listener);
  listener(getWebRelayState());
  return () => listeners.delete(listener);
}

export function enableWebRelay() {
  localStorage.setItem(ENABLED_KEY, "true");
  notify({ enabled: true, phase: "connecting", lastError: null });
  startLoop();
}

export function disableWebRelay() {
  localStorage.removeItem(ENABLED_KEY);
  notify({ enabled: false, phase: activeJobId ? "generating" : "disabled" });
  loopController?.abort();
}

window.addEventListener("storage", (event) => {
  if (event.key !== ENABLED_KEY) return;
  const enabled = event.newValue === "true";
  notify({ enabled, phase: enabled ? "connecting" : activeJobId ? "generating" : "disabled" });
  if (enabled) startLoop();
  else loopController?.abort();
});

if (state.enabled) {
  startLoop();
}
