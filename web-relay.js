import { getContext } from "../../../extensions.js";

const PLUGIN_BASE = "/api/plugins/st-im-bridge";
const ENABLED_KEY = "st-im-bridge.web-relay.enabled";
const WORKER_KEY = "st-im-bridge.web-relay.worker-id";
const RELAY_VERSION = "1.0.0";
const POLL_WAIT_MS = 25_000;
const RETRY_DELAY_MS = 3_000;
const GENERATION_IDLE_WAIT_MS = 300_000;

let csrfTokenCache = null;
let loopController = null;
let loopPromise = null;
let activeJobId = null;
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
  notify({ phase: "generating", activeJobId: job.id, lastError: null });
  const sendHeartbeat = () => relayApi("/web-relay/heartbeat", identity({ activeJobId: job.id }))
    .catch((error) => console.warn("[IM Bridge Relay] heartbeat during generation failed", error));
  heartbeatTimer = setInterval(sendHeartbeat, 10_000);

  try {
    const context = await ensureTarget(job);
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
