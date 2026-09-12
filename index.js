// SillyTavern-IM-Bridge UI extension
// Loaded by SillyTavern's extension system; uses /api/plugins/st-im-bridge/* endpoints.

import {
  disableWebRelay,
  enableWebRelay,
  getWebRelayState,
  subscribeWebRelay,
} from "./web-relay.js";

const PLUGIN_BASE = "/api/plugins/st-im-bridge";
let csrfTokenCache = null;

async function getCsrfToken() {
  if (csrfTokenCache) return csrfTokenCache;
  const r = await fetch("/csrf-token", { credentials: "same-origin" });
  if (!r.ok) throw new Error(`csrf-token failed: ${r.status}`);
  const json = await r.json();
  csrfTokenCache = json.token;
  return csrfTokenCache;
}

async function api(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") {
    init.headers["x-csrf-token"] = await getCsrfToken();
  }
  if (body !== undefined) init.body = JSON.stringify(body);
  let r = await fetch(PLUGIN_BASE + path, init);
  if (r.status === 403) {
    const text = await r.clone().text();
    if (/csrf/i.test(text)) {
      csrfTokenCache = null;
      init.headers["x-csrf-token"] = await getCsrfToken();
      r = await fetch(PLUGIN_BASE + path, init);
    }
  }
  if (!r.ok) {
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { error: { code: "HTTP_" + r.status, message: text || r.statusText } }; }
    const err = new Error(parsed?.error?.message || r.statusText);
    err.code = parsed?.error?.code;
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return null;
  return r.json();
}

async function probe() {
  try {
    const r = await fetch(PLUGIN_BASE + "/probe", { credentials: "same-origin" });
    return r.status === 204;
  } catch (_e) {
    return false;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "onclick") node.onclick = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function showToast(level, msg) {
  if (window.toastr && typeof window.toastr[level] === "function") {
    window.toastr[level](msg);
  } else {
    console[level === "error" ? "error" : "log"]("[IM Bridge]", msg);
  }
}

function renderInstallHint(container) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "imb-install-hint" },
    el("h3", {}, "IM Bridge 服务端插件未安装"),
    el("p", {}, "请按以下步骤安装："),
    el("pre", {}, [
      "1. 在 SillyTavern config.yaml 设置 enableServerPlugins: true",
      "2. 在 plugins/ 目录执行：",
      "   git clone https://github.com/rinmashiro0529/SillyTavern-IM-Bridge.git st-im-bridge",
      "   （仓库已包含 dist/，无需 npm install）",
      "3. 重启 SillyTavern",
    ].join("\n")),
  ));
}

function renderStatusChip(status) {
  const cls = status === "running" ? "running" : status === "error" ? "error" : "stopped";
  return el("span", { class: `imb-status ${cls}` }, status || "stopped");
}

function buildPersonalTab(account, onMutate) {
  const root = el("div", { class: "imb-section" });
  const tokenInput = el("input", { type: "password", placeholder: "Telegram Bot Token (xxxxx:yyyyy)" });
  const statusBox = el("div", {}, "状态：", renderStatusChip(account.botStatus));
  const usernameBox = el("div", {}, account.botUsername ? `Username: @${account.botUsername}` : "");
  const lastErrorBox = el("div", { class: "imb-error" }, account.lastError || "");

  const saveTokenBtn = el("button", { class: "menu_button", onclick: async () => {
    try {
      if (!tokenInput.value.trim()) { showToast("warning", "Token 不能为空"); return; }
      await api("PUT", `/admin/accounts/${account.handle}/bot-token`, { token: tokenInput.value.trim() });
      showToast("success", "已保存 Bot Token");
      tokenInput.value = "";
      onMutate?.();
    } catch (e) { showToast("error", e.message); }
  } }, "保存 Token");

  const clearTokenBtn = el("button", { class: "menu_button", onclick: async () => {
    try {
      await api("DELETE", `/admin/accounts/${account.handle}/bot-token`);
      showToast("success", "已清除 Bot Token");
      onMutate?.();
    } catch (e) { showToast("error", e.message); }
  } }, "清除 Token");

  const startBtn = el("button", { class: "menu_button", onclick: async () => {
    try {
      await api("POST", `/admin/accounts/${account.handle}/bot/start`);
      showToast("success", "已启动 Bot");
      onMutate?.();
    } catch (e) { showToast("error", e.message); }
  } }, "启动");

  const stopBtn = el("button", { class: "menu_button", onclick: async () => {
    try {
      await api("POST", `/admin/accounts/${account.handle}/bot/stop`);
      showToast("success", "已停止 Bot");
      onMutate?.();
    } catch (e) { showToast("error", e.message); }
  } }, "停止");

  root.appendChild(el("h3", {}, `Telegram Bot - ${account.handle} (${account.role})`));
  root.appendChild(el("div", { class: "imb-row" }, el("label", {}, "当前 Token"), document.createTextNode(account.tokenPreview || "（未设置）")));
  root.appendChild(el("div", { class: "imb-row" }, el("label", {}, "新 Token"), tokenInput, saveTokenBtn, clearTokenBtn));
  root.appendChild(el("div", { class: "imb-row" }, el("label", {}, "运行状态"), statusBox, startBtn, stopBtn));
  root.appendChild(usernameBox);
  root.appendChild(buildBindSection(account, onMutate));
  root.appendChild(buildWebRelaySection());
  root.appendChild(lastErrorBox);
  return root;
}

function buildWebRelaySection() {
  const wrap = el("div", { class: "imb-section" });
  const status = el("span", { class: "imb-status stopped" }, "未启用");
  const detail = el("div", { class: "imb-bind-hint" }, "");
  const toggle = el("button", { class: "menu_button" }, "在此浏览器启用网页中继");

  const render = (relay) => {
    const labelByPhase = {
      disabled: "未启用",
      waiting: "等待其他标签页",
      connecting: "连接中",
      online: "在线",
      generating: "正在生成",
      configuring: "正在切换全局设置",
      error: "连接异常",
    };
    status.textContent = labelByPhase[relay.phase] || relay.phase;
    status.className = `imb-status ${["online", "generating", "configuring"].includes(relay.phase) ? "running" : relay.phase === "error" ? "error" : "stopped"}`;
    toggle.textContent = relay.enabled ? "停用此浏览器的网页中继" : "在此浏览器启用网页中继";
    detail.textContent = relay.lastError
      ? `最近错误：${relay.lastError}`
      : relay.enabled
        ? "请把这个酒馆页面作为专用中继页面保持打开；Telegram 可用 /prompt web 切换。"
        : "仅在专用的 Chromium 配置中启用，避免正常浏览酒馆时被中继自动切换角色/会话。";
  };

  toggle.onclick = () => {
    const relay = getWebRelayState();
    if (relay.enabled) {
      disableWebRelay();
      showToast("info", "已停用此浏览器的网页中继");
    } else {
      enableWebRelay();
      showToast("success", "正在连接网页中继");
    }
  };
  const unsubscribe = subscribeWebRelay(render);
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      unsubscribe();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  wrap.appendChild(el("h3", {}, "网页完整模式中继"));
  wrap.appendChild(el("div", { class: "imb-row" }, el("label", {}, "此浏览器"), status, toggle));
  wrap.appendChild(detail);
  return wrap;
}

function buildBindSection(account, onMutate) {
  const wrap = el("div", { class: "imb-section" });
  wrap.appendChild(el("h3", {}, "TG 绑定"));
  wrap.appendChild(el("div", { class: "imb-bind-hint" },
    "在 Telegram 私聊该 bot 发送 ",
    el("code", {}, "/bind <验证码>"),
    "，验证码 5 分钟内有效；绑定成功后该号可直接使用所有命令。"));

  const codeBox = el("div", { class: "imb-row" });
  const codeDisplay = el("span", { class: "imb-bind-empty" }, "暂无活跃验证码");
  codeBox.appendChild(codeDisplay);

  let countdownTimer = null;
  function setCode(payload) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (!payload) {
      codeDisplay.className = "imb-bind-empty";
      codeDisplay.textContent = "暂无活跃验证码";
      return;
    }
    const expiresMs = new Date(payload.expiresAt).getTime();
    const tick = () => {
      const remain = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      if (remain <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        codeDisplay.className = "imb-bind-empty";
        codeDisplay.textContent = "验证码已过期";
        return;
      }
      codeDisplay.className = "";
      codeDisplay.innerHTML = "";
      codeDisplay.appendChild(el("span", { class: "imb-bind-code" }, payload.code));
      codeDisplay.appendChild(document.createTextNode(`  剩余 ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`));
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  const generateBtn = el("button", { class: "menu_button", onclick: async () => {
    try {
      const result = await api("POST", `/admin/accounts/${account.handle}/bind-code`);
      setCode(result);
      showToast("success", "已生成绑定验证码");
    } catch (e) { showToast("error", e.message); }
  } }, "生成绑定码");

  codeBox.appendChild(generateBtn);
  wrap.appendChild(codeBox);

  // Try fetching active code on render (404 == no active)
  api("GET", `/admin/accounts/${account.handle}/bind-code`)
    .then(setCode)
    .catch((e) => { if (e.status !== 404) console.warn("[IM Bridge] active code lookup failed:", e); });

  wrap.appendChild(el("h3", { style: "margin-top:12px;" }, "已绑定的 TG 用户"));
  const list = el("div");
  if (!account.allowedUserIds || account.allowedUserIds.length === 0) {
    list.appendChild(el("div", { class: "imb-bind-empty" }, "尚无绑定用户"));
  } else {
    for (const id of account.allowedUserIds) {
      const item = el("div", { class: "imb-list-item" },
        el("span", { class: "grow" }, String(id)),
        el("button", { class: "menu_button", onclick: async () => {
          try {
            await api("DELETE", `/admin/accounts/${account.handle}/allowed-users/${encodeURIComponent(id)}`);
            showToast("success", `已解绑 ${id}`);
            onMutate?.();
          } catch (e) { showToast("error", e.message); }
        } }, "解绑"));
      list.appendChild(item);
    }
  }
  wrap.appendChild(list);
  return wrap;
}

function buildCompressTab(account, onMutate) {
  const root = el("div", { class: "imb-section" });
  const cfg = account.compress || { keepRecent: 15, batchSize: 5, timeoutMs: 60000, retryCount: 3, retryDelayMs: 1500 };
  const inputs = {};
  const fields = [
    ["keepRecent", "保留最近条数"],
    ["batchSize", "每批并发"],
    ["timeoutMs", "单条超时(ms)"],
    ["retryCount", "重试次数"],
    ["retryDelayMs", "重试间隔(ms)"],
  ];
  for (const [key, label] of fields) {
    const input = el("input", { type: "number", value: String(cfg[key]) });
    inputs[key] = input;
    root.appendChild(el("div", { class: "imb-row" }, el("label", {}, label), input));
  }
  root.appendChild(el("div", { class: "imb-row" }, el("button", {
    class: "menu_button",
    onclick: async () => {
      try {
        const compress = {};
        for (const [key] of fields) compress[key] = Number(inputs[key].value);
        await api("PUT", `/admin/accounts/${account.handle}/compress-config`, { compress });
        showToast("success", "压缩配置已保存");
        onMutate?.();
      } catch (e) { showToast("error", e.message); }
    },
  }, "保存压缩配置")));
  return root;
}

async function buildAdminTab(me) {
  const root = el("div", { class: "imb-section" });
  root.appendChild(el("h3", {}, "管理员视图：所有账号"));
  try {
    const data = await api("GET", "/admin/accounts");
    if (!data.items.length) {
      root.appendChild(el("div", {}, "暂无账号"));
      return root;
    }
    for (const acc of data.items) {
      const item = el("div", { class: "imb-list-item" },
        el("span", { class: "grow" }, `${acc.handle} (${acc.role}) - ${acc.botStatus} - ${acc.tokenPreview || "无 Token"}`),
        el("button", {
          class: "menu_button",
          onclick: async () => {
            try {
              await api("POST", `/admin/accounts/${acc.handle}/bot/start`);
              showToast("success", `${acc.handle} 已启动`);
            } catch (e) { showToast("error", e.message); }
          },
        }, "启动"),
        el("button", {
          class: "menu_button",
          onclick: async () => {
            try {
              await api("POST", `/admin/accounts/${acc.handle}/bot/stop`);
              showToast("success", `${acc.handle} 已停止`);
            } catch (e) { showToast("error", e.message); }
          },
        }, "停止"),
      );
      root.appendChild(item);
    }
  } catch (e) {
    root.appendChild(el("div", { class: "imb-error" }, e.message));
  }
  return root;
}

async function renderPanel(container) {
  container.innerHTML = "";
  const ok = await probe();
  if (!ok) {
    renderInstallHint(container);
    return;
  }
  let me;
  try {
    me = await api("GET", "/me");
  } catch (e) {
    container.appendChild(el("div", { class: "imb-error" }, "无法获取账号信息：" + e.message));
    return;
  }
  let myAccount;
  try {
    myAccount = await api("GET", `/admin/accounts/${me.handle}`);
  } catch (e) {
    container.appendChild(el("div", { class: "imb-error" }, e.message));
    return;
  }

  const tabBar = el("div", { class: "imb-tab-bar" });
  const tabContent = el("div");

  const tabs = [
    { key: "personal", label: "个人 Bot", build: () => buildPersonalTab(myAccount, () => renderPanel(container)) },
    { key: "compress", label: "压缩配置", build: () => buildCompressTab(myAccount, () => renderPanel(container)) },
  ];
  if (me.admin) {
    tabs.push({ key: "admin", label: "管理员", build: () => buildAdminTab(me) });
  }

  let activeKey = tabs[0].key;
  function activate(key) {
    activeKey = key;
    for (const btn of tabBar.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.tab === key);
    }
    const tab = tabs.find((t) => t.key === key);
    Promise.resolve(tab.build()).then((node) => {
      tabContent.innerHTML = "";
      tabContent.appendChild(node);
    });
  }

  for (const tab of tabs) {
    const btn = el("button", { class: "menu_button" }, tab.label);
    btn.dataset.tab = tab.key;
    btn.onclick = () => activate(tab.key);
    tabBar.appendChild(btn);
  }
  container.appendChild(tabBar);
  container.appendChild(tabContent);
  activate(activeKey);
}

(function bootstrap() {
  // ST loads UI extensions after DOM ready; mount into the extensions panel.
  const settingsHost = document.getElementById("extensions_settings2") || document.getElementById("extensions_settings");
  if (!settingsHost) return;

  const wrapper = el("div", { class: "imb-panel inline-drawer" });
  const headerRow = el("div", { class: "inline-drawer-toggle inline-drawer-header" },
    el("b", {}, "IM Bridge"),
    el("div", { class: "inline-drawer-icon fa-solid fa-circle-chevron-down down" }),
  );
  const drawerContent = el("div", { class: "inline-drawer-content" });
  wrapper.appendChild(headerRow);
  wrapper.appendChild(drawerContent);
  settingsHost.appendChild(wrapper);

  let loaded = false;
  headerRow.addEventListener("click", () => {
    if (!loaded) {
      loaded = true;
      renderPanel(drawerContent);
    }
  });
})();
