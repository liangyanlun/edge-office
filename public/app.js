import { hideSplash, isNativeApp, shareFile } from "./native-bridge.js";
import { createExperience, answerLabel, renderRichText, WRITING_TASKS } from "./experience.js?v=0.2.0-ui2";
import { createOfflineRuntime } from "./offline-runtime.js";

const TOOL_CATALOG = [
  { id: "summary", group: "阅读与总结", title: "总结材料", detail: "提取重点、结论与下一步", status: "ready", prompt: "请总结本地知识库中最相关的材料，按背景、核心要点、结论和下一步整理。", placeholder: "可补充材料范围或关注重点，直接发送则总结相关材料", hint: "系统会检索本地材料并附上引用依据" },
  { id: "compare", group: "阅读与总结", title: "对比材料", detail: "找出两份材料的差异与共识", status: "ready", prompt: "请对比本地知识库中最近的两份材料，列出共同点、差异和需要确认的内容。", placeholder: "可说明要对比的材料或关注维度", hint: "系统会从本地材料中提取共识、差异和待确认项" },
  { id: "quote", group: "阅读与总结", title: "定位原文", detail: "按问题返回可核对的引用", status: "ready", prompt: "请从本地材料中定位与这个问题最相关的原文，并保留引用依据：", placeholder: "输入要查找的问题，例如：项目的核心创新是什么？", hint: "系统会查找相关原文，并显示在“引用依据”中" },
  { id: "email", group: "写作与沟通", title: "撰写邮件", detail: "生成可编辑邮件草稿", status: "draft", prompt: "请创建一封邮件草稿。收件人、主题和正文信息不完整时先向我确认。", placeholder: "说明收件人、主题和想表达的内容", hint: "先生成本地草稿，不会直接发送" },
  { id: "polish", group: "写作与沟通", title: "优化表达", detail: "将已有内容改得更清晰专业", status: "ready", prompt: "请将下面内容改写得清晰、专业、简洁，并保持原意：", placeholder: "粘贴需要优化的文字", hint: "系统会保留原意并改善结构与表达" },
  { id: "outline", group: "写作与沟通", title: "生成汇报提纲", detail: "把材料整理为可讲述的结构", status: "ready", prompt: "请根据本地材料生成一个汇报提纲，包含标题、核心论点和每页建议内容。", placeholder: "可补充汇报对象、时长或重点", hint: "系统会结合本地材料生成可编辑提纲" },
  { id: "minutes", group: "任务与规划", title: "整理会议纪要", detail: "提炼结论、待办和负责人", status: "ready", prompt: "请将以下会议内容整理为会议纪要，分为结论、待办、负责人和时间节点：", placeholder: "粘贴会议记录或补充会议主题", hint: "系统会整理结论、待办、负责人和时间节点" },
  { id: "tasks", group: "任务与规划", title: "提取待办", detail: "从材料或文本识别可执行事项", status: "ready", prompt: "请从本地材料中提取待办事项，按事项、负责人、截止时间和依据列出。", placeholder: "可补充材料范围或直接发送", hint: "系统会提取事项、负责人、截止时间和依据" },
  { id: "import", group: "知识库", title: "导入本地材料", detail: "支持文档、表格、演示文稿与网页", status: "ready", prompt: "" },
  { id: "ppt", group: "演示文稿", title: "编辑 PPT", detail: "五类受限操作、预览确认与版本撤销", status: "ready", prompt: "" },
];

const TOOL_STATUS = { ready: "开始处理 →", draft: "仅生成草稿 →", experimental: "实验功能 · 建议 4B" };
const state = { conversationId: null, ragEnabled: true, controller: null, citations: [], profile: null, documents: [], conversations: [], onboardingStep: 0, activeToolId: null, modelDownload: null, modelDownloadTimer: null, modelCatalogTimer: null, models: [], mobile: null, offline: false, nativeInference: false, ppt: { presentations: [], current: null, versionId: null, slides: [], slideId: null, asset: null, patch: null, publishedVersionId: null, undoVersionId: null, mode: "before" } };
let offlineRuntime = null;
let offlineMode = false;
const selectedModelSources = Object.create(null);
function storedApiBase() {
  try { return String(globalThis.__EDGE_OFFICE_API_BASE__ || globalThis.localStorage?.getItem("edge_office_api_base") || "").trim().replace(/\/+$/, ""); } catch { return ""; }
}
function apiBase() {
  const stored = storedApiBase();
  if (stored) return stored;
  if (isNativeApp() && /^https?:$/.test(window.location.protocol) && !/localhost|127\.0\.0\.1/.test(window.location.hostname)) return window.location.origin;
  return "";
}
function apiPath(path) { return /^https?:\/\//i.test(path) ? path : `${apiBase()}${path}`; }
const elements = {
  splash: document.querySelector("#app-splash"), splashStatus: document.querySelector("#splash-status"), onboarding: document.querySelector("#onboarding-layer"), onboardingProgress: document.querySelector("#onboarding-progress"), onboardingForm: document.querySelector("#onboarding-profile-form"),
  nav: document.querySelectorAll(".nav-item"), views: document.querySelectorAll(".view"), viewTitle: document.querySelector("#view-title"), viewEyebrow: document.querySelector("#view-eyebrow"), profileLabel: document.querySelector("#profile-label"), sidebarStatus: document.querySelector("#sidebar-service-status"), runtimeBadge: document.querySelector("#runtime-badge span:last-child"), modelDownloadControl: document.querySelector("#model-download-control"), modelDownloadButton: document.querySelector("#model-download-button"), modelDownloadLocation: document.querySelector("#model-download-location"),
  dashboardGreeting: document.querySelector("#dashboard-greeting"), dashboardContext: document.querySelector("#dashboard-context"), workspaceStats: document.querySelector("#workspace-stats"), modelGrid: document.querySelector("#model-grid"), quickActions: document.querySelector("#quick-actions"), recommendations: document.querySelector("#recommendation-section"), recentConversations: document.querySelector("#recent-conversations"),
  messages: document.querySelector("#messages"), chatPanel: document.querySelector(".chat-panel"), contextActions: document.querySelector("#context-actions"), form: document.querySelector("#chat-form"), input: document.querySelector("#chat-input"), activeToolHint: document.querySelector("#active-tool-hint"), activeToolTitle: document.querySelector("#active-tool-title"), activeToolDetail: document.querySelector("#active-tool-detail"), clearActiveTool: document.querySelector("#clear-active-tool"), ragToggle: document.querySelector("#rag-toggle"), ragLabel: document.querySelector("#rag-label"), stop: document.querySelector("#stop-button"), send: document.querySelector("#send-button"), conversations: document.querySelector("#conversation-list"), newChat: document.querySelector("#new-chat-button"),
  evidence: document.querySelector("#evidence-list"), evidenceCount: document.querySelector("#evidence-count"), ttft: document.querySelector("#metric-ttft"), retrieval: document.querySelector("#metric-retrieval"), speed: document.querySelector("#metric-speed"), memory: document.querySelector("#metric-memory"),
  documentFile: document.querySelector("#document-file"), importButton: document.querySelector("#import-button"), importFeedback: document.querySelector("#import-feedback"), documentList: document.querySelector("#document-list"), knowledgeSummary: document.querySelector("#knowledge-summary"), tools: document.querySelector("#tool-groups"),
  pptFile: document.querySelector("#ppt-file"), pptImport: document.querySelector("#ppt-import-button"), pptSelect: document.querySelector("#ppt-presentation-select"), pptWarning: document.querySelector("#ppt-model-warning"), pptEmpty: document.querySelector("#ppt-empty"), pptWorkspace: document.querySelector("#ppt-workspace"), pptSlideCount: document.querySelector("#ppt-slide-count"), pptSlideList: document.querySelector("#ppt-slide-list"), pptVersionLabel: document.querySelector("#ppt-version-label"), pptBefore: document.querySelector("#ppt-before-image"), pptAfter: document.querySelector("#ppt-after-image"), pptPreviewStatus: document.querySelector("#ppt-preview-status"), pptStage: document.querySelector("#ppt-preview-stage"), pptInstruction: document.querySelector("#ppt-instruction"), pptImageFile: document.querySelector("#ppt-image-file"), pptImageButton: document.querySelector("#ppt-image-button"), pptAssetLabel: document.querySelector("#ppt-asset-label"), pptGenerate: document.querySelector("#ppt-generate-button"), pptPlanCard: document.querySelector("#ppt-plan-card"), pptPlanTitle: document.querySelector("#ppt-plan-title"), pptPlanStatus: document.querySelector("#ppt-plan-status"), pptPlanSlide: document.querySelector("#ppt-plan-slide"), pptPlanCount: document.querySelector("#ppt-plan-count"), pptPlanVersion: document.querySelector("#ppt-plan-version"), pptPlanHash: document.querySelector("#ppt-plan-hash"), pptOperations: document.querySelector("#ppt-operation-list"), pptVerification: document.querySelector("#ppt-verification-note"), pptConfirm: document.querySelector("#ppt-confirm-button"), pptCancel: document.querySelector("#ppt-cancel-button"), pptComplete: document.querySelector("#ppt-complete-card"), pptDownload: document.querySelector("#ppt-download-button"), pptOpen: document.querySelector("#ppt-open-button"), pptUndo: document.querySelector("#ppt-undo-button"), pptVersionList: document.querySelector("#ppt-version-list"), pptModes: document.querySelectorAll(".ppt-view-mode"),
  settingsLayer: document.querySelector("#settings-layer"), settingsForm: document.querySelector("#settings-form"), commandLayer: document.querySelector("#command-layer"), commandInput: document.querySelector("#command-input"), commandList: document.querySelector("#command-list"), insightTabs: document.querySelectorAll(".insight-tab"), insightContents: document.querySelectorAll(".insight-content"), contextTip: document.querySelector("#context-tip"), contextTipText: document.querySelector("#context-tip-text"), toast: document.querySelector("#toast"), mobileModeBadge: document.querySelector("#mobile-mode-badge"), mobilePairLayer: document.querySelector("#mobile-pair-layer"), mobilePairForm: document.querySelector("#mobile-pair-form"), mobileServerLayer: document.querySelector("#mobile-server-layer"), mobileServerForm: document.querySelector("#mobile-server-form"),
};

async function request(path, options = {}) {
  if (offlineMode && offlineRuntime) return offlineRuntime.request(path, options);
  const response = await fetch(apiPath(path), options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "请求失败，请稍后重试"); }
  return response.json();
}
async function activateOfflineRuntime() {
  if (!isNativeApp() || !globalThis.Capacitor?.Plugins?.OfflineRuntime) return false;
  offlineRuntime = createOfflineRuntime({plugin: globalThis.Capacitor.Plugins.OfflineRuntime});
  await offlineRuntime.start();
  offlineMode = true;
  state.offline = true;
  document.body.classList.add("offline-native");
  document.querySelector(".knowledge-header p:not(.section-kicker)").textContent = "在手机本机建立检索索引；无需模型即可定位原文，生成任务需要先安装模型。";
  document.querySelector(".metric:first-child > span").textContent = "回答耗时";
  document.querySelector(".metric:first-child").title = "非流式离线模型从提交问题到完整回答返回的时间，并非首 token 延迟";
  document.querySelector(".metric-footnote").textContent = "手机离线回答非流式；速度使用 llama.cpp 实际生成 token 数和生成阶段耗时。未启用模型时不显示 tokens/s。";
  elements.documentFile.accept += ",.json,application/json";
  return true;
}
async function ensureNativeServerAddress() {
  if (!isNativeApp() || apiBase()) return true;
  elements.mobileServerLayer.classList.remove("hidden");
  elements.mobileServerForm.elements.apiBase.focus();
  return new Promise((resolve) => {
    const submit = (event) => {
      event.preventDefault();
      const value = elements.mobileServerForm.elements.apiBase.value.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(value)) return showToast("服务地址必须以 http:// 或 https:// 开头");
      try { globalThis.localStorage?.setItem("edge_office_api_base", value); } catch { /* native storage can be unavailable in restricted mode */ }
      elements.mobileServerLayer.classList.add("hidden");
      elements.mobileServerForm.removeEventListener("submit", submit);
      resolve(true);
      window.setTimeout(() => window.location.reload(), 30);
    };
    elements.mobileServerForm.addEventListener("submit", submit);
  });
}
function showToast(message) { elements.toast.textContent = message; elements.toast.classList.remove("hidden"); window.clearTimeout(showToast.timeout); showToast.timeout = window.setTimeout(() => elements.toast.classList.add("hidden"), 2600); }
function firstName() { return state.profile?.displayName || "你"; }
function setSplashStatus(message) { elements.splashStatus.textContent = message; }
function completeSplash() { window.setTimeout(() => { document.body.classList.remove("booting"); elements.splash.classList.add("leaving"); window.setTimeout(() => elements.splash.remove(), 520); }, 360); }
async function refreshMobileBootstrap() {
  try {
    const payload = await request("/api/v1/mobile/bootstrap");
    state.mobile = payload;
    if (payload.mode !== "local" || payload.pairingRequired) {
      elements.mobileModeBadge.textContent = payload.paired ? `手机模式 · ${payload.mode}` : `手机配对 · ${payload.mode}`;
      elements.mobileModeBadge.classList.remove("hidden");
    }
    if (payload.model?.pptRecommended === false && payload.model?.pptWarning) {
      elements.pptWarning.textContent = payload.model.pptWarning;
    }
    return payload;
  } catch { /* Older local instances can continue without the mobile capability API. */ }
}
async function ensureMobilePairing(payload) {
  if (!payload?.pairingRequired || payload.paired) return true;
  elements.mobilePairLayer.classList.remove("hidden");
  elements.mobilePairForm.elements.code.focus();
  return new Promise((resolve) => {
    const submit = async (event) => {
      event.preventDefault();
      const button = elements.mobilePairForm.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await request("/api/v1/mobile/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: elements.mobilePairForm.elements.code.value.trim() }) });
        elements.mobilePairLayer.classList.add("hidden");
        elements.mobilePairForm.removeEventListener("submit", submit);
        await refreshMobileBootstrap();
        showToast("手机已安全配对");
        resolve(true);
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    };
    elements.mobilePairForm.addEventListener("submit", submit);
  });
}
function registerAppShell() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function populateProfileForm(form, profile) {
  if (!form || !profile) return;
  form.elements.displayName.value = profile.displayName || "";
  form.elements.role.value = profile.role || "科研学习";
  form.elements.writingTone.value = profile.writingTone || "professional";
  form.elements.ragEnabled.checked = profile.ragEnabled !== false;
}
function applyProfile(profile) {
  state.profile = profile; state.ragEnabled = profile.ragEnabled !== false;
  elements.ragToggle.checked = state.ragEnabled; elements.ragLabel.textContent = state.ragEnabled ? "已启用" : "已关闭";
  document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库";
  elements.profileLabel.textContent = profile.displayName ? `${profile.displayName}的工作区` : "本地工作区";
  elements.dashboardGreeting.textContent = profile.displayName ? `你好，${profile.displayName}` : "准备开始今天的工作";
  elements.dashboardContext.textContent = profile.role ? `当前以「${profile.role}」场景组织你的材料、对话和任务。` : "从一个问题、一份材料或一项待处理事务开始。";
  populateProfileForm(elements.settingsForm, profile); populateProfileForm(elements.onboardingForm, profile);
}
async function savePreferences(changes, options = {}) {
  const payload = await request("/api/v1/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
  applyProfile(payload.item); renderDashboard(); if (!options.quiet) showToast("个人设置已保存在本机"); return payload.item;
}
function showOnboardingStep(step) {
  const stepCount = Math.max(1, document.querySelectorAll(".onboarding-step").length);
  state.onboardingStep = Math.max(0, Math.min(stepCount - 1, Number(step) || 0));
  document.querySelectorAll(".onboarding-step").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.onboardingStep) === state.onboardingStep);
    if (Number(item.dataset.onboardingStep) === state.onboardingStep) item.scrollTop = 0;
  });
  elements.onboardingProgress.style.width = `${((state.onboardingStep + 1) / stepCount) * 100}%`;
  document.querySelector("#onboarding-step-label").textContent = stepCount === 1 ? "快速开始" : `第 ${state.onboardingStep + 1} / ${stepCount} 步`;
}
function openOnboarding(step = 0) { populateProfileForm(elements.onboardingForm, state.profile); showOnboardingStep(step); elements.onboarding.classList.remove("hidden"); }
function closeOnboarding() { elements.onboarding.classList.add("hidden"); }
function dismissOnboarding() {
  closeOnboarding();
  savePreferences({onboardingComplete: true}, {quiet: true}).catch(() => {});
}
async function finishOnboarding(firstTask = "home") {
  const form = elements.onboardingForm;
  const profile = await savePreferences({ displayName: form.elements.displayName.value.trim(), role: form.elements.role.value, writingTone: form.elements.writingTone.value, ragEnabled: form.elements.ragEnabled.checked, onboardingComplete: true, lastView: firstTask === "import" ? "knowledge" : (firstTask === "home" ? "home" : "chat") }, { quiet: true });
  applyProfile(profile); closeOnboarding();
  if (firstTask === "import") { switchView("knowledge", { persist: false }); window.setTimeout(() => elements.importButton.click(), 220); }
  else if (firstTask === "home") switchView("home", { persist: false });
  else { switchView("chat", { persist: false }); if (firstTask !== "chat") useTool(firstTask); else elements.input.focus(); }
}

function toolById(id) { return TOOL_CATALOG.find((tool) => tool.id === id); }
function offlineModelRequired(tool) { return offlineMode && !state.nativeInference && !["import", "quote", "ppt"].includes(tool.id); }
function toolPrompt(tool) {
  if (tool.id === "summary" && !state.documents.length) return "请先导入一份材料，再为你生成有依据的摘要。";
  if (tool.id === "compare" && state.documents.length < 2) return "请先导入至少两份材料，再进行对比。";
  return tool.prompt;
}
function clearActiveTool() {
  state.activeToolId = null;
  elements.activeToolHint.classList.add("hidden");
  elements.input.placeholder = "输入你的问题";
  experience.refreshScope();
  document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库";
}
function setActiveTool(tool) {
  state.activeToolId = tool.id;
  elements.activeToolTitle.textContent = tool.title;
  elements.activeToolDetail.textContent = tool.hint || tool.detail;
  elements.activeToolHint.classList.remove("hidden");
  elements.input.value = "";
  elements.input.placeholder = tool.placeholder || "补充你的具体要求";
  document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库";
  autoResizeComposer();
}
function composeToolRequest(tool, userInput) {
  if (!userInput) return tool.prompt;
  return tool.prompt.endsWith("：") ? `${tool.prompt}${userInput}` : `${tool.prompt}\n用户补充：${userInput}`;
}
function useTool(id) {
  const tool = toolById(id); if (!tool) return; closeCommand();
  if (tool.id === "import") { switchView("knowledge"); window.setTimeout(() => elements.importButton.click(), 180); return; }
  if (tool.id === "ppt") { switchView("ppt"); return; }
  if (offlineModelRequired(tool)) { openSettings(); document.querySelector("#model-settings").open = true; showToast("这项任务需要手机本机模型；可先下载或导入 GGUF，定位原文仍可直接使用"); return; }
  if ((tool.id === "summary" && !state.documents.length) || (tool.id === "compare" && state.documents.length < 2)) { switchView("knowledge"); showToast(toolPrompt(tool)); return; }
  if (state.controller) return showToast("请等当前结果返回后再开始新任务");
  switchView("chat"); setActiveTool(tool); elements.input.focus(); experience.prepareTool(tool);
}
function renderToolButton(tool, compact = false) {
  const button = document.createElement("button"); button.type = "button"; button.className = compact ? "quick-task" : "tool-card"; button.dataset.tool = tool.id;
  const title = document.createElement("strong"); title.textContent = tool.title; const detail = document.createElement("span"); detail.textContent = offlineModelRequired(tool) ? "需要手机本机 GGUF 模型" : tool.detail; const status = document.createElement("small"); status.textContent = offlineModelRequired(tool) ? "先安装模型 →" : TOOL_STATUS[tool.status]; button.append(title, detail, status); return button;
}
function renderTools() {
  const available = TOOL_CATALOG;
  elements.tools.replaceChildren(); [...new Set(available.map((tool) => tool.group))].forEach((group) => { const section = document.createElement("section"); section.className = "tool-group"; const heading = document.createElement("h3"); heading.textContent = group; const grid = document.createElement("div"); grid.className = "tool-grid"; available.filter((tool) => tool.group === group).forEach((tool) => grid.append(renderToolButton(tool))); section.append(heading, grid); elements.tools.append(section); });
}

function renderDashboard() {
  const documentCount = state.documents.length;
  const userDocuments = state.documents.filter((item) => !item.builtin).length;
  elements.workspaceStats.replaceChildren();
  [["知识库", `${documentCount} 份`, userDocuments ? `${userDocuments} 份由你导入` : "等待导入材料"], ["对话", `${state.conversations.length} 个`, state.conversations.length ? "可继续上次上下文" : "尚未开始对话"], ["默认模式", offlineMode && !state.nativeInference ? "原文检索" : state.ragEnabled ? "知识增强" : "直接推理", offlineMode && !state.nativeInference ? "安装模型后可生成摘要和草稿" : state.ragEnabled ? "回答将携带依据" : "本轮不检索材料"]].forEach(([label, value, note]) => {
    const item = document.createElement("article"); item.className = "workspace-stat"; item.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${note}</small>`; elements.workspaceStats.append(item);
  });
  elements.quickActions.replaceChildren(); (offlineMode && !state.nativeInference ? ["import", "quote"] : ["summary", "email", "tasks", "minutes"]).map(toolById).forEach((tool) => elements.quickActions.append(renderToolButton(tool, true)));
  elements.recommendations.replaceChildren();
  const recommendation = document.createElement("div"); recommendation.className = "recommendation";
  const copy = document.createElement("div"); const kicker = document.createElement("p"); kicker.className = "section-kicker"; kicker.textContent = "下一步建议"; const title = document.createElement("h2"); const text = document.createElement("p"); const action = document.createElement("button"); action.className = "primary-button"; action.type = "button";
  if (!userDocuments) { title.textContent = "先放入一份正在处理的材料"; text.textContent = offlineMode && !state.nativeInference ? "导入后可立即检索并核对原文；生成摘要或待办需要先安装模型。" : "导入后可以直接提问、总结、提取待办，回答会显示对应引用。"; action.textContent = "导入材料"; action.dataset.tool = "import"; }
  else if (offlineMode && !state.nativeInference) { title.textContent = "材料已就绪，可核对原文"; text.textContent = "不装模型也能本地检索并查看页码或工作表定位；生成摘要和草稿需先安装模型。"; action.textContent = "定位原文"; action.dataset.tool = "quote"; }
  else if (documentCount > 1) { title.textContent = "材料已就绪，可以开始提炼共识"; text.textContent = "尝试对比最近材料，识别差异、冲突和需要确认的问题。"; action.textContent = "对比材料"; action.dataset.tool = "compare"; }
  else { title.textContent = "把材料转为可执行结果"; text.textContent = "可先生成摘要，再从摘要延伸为汇报提纲、邮件草稿或待办。"; action.textContent = "总结材料"; action.dataset.tool = "summary"; }
  copy.append(kicker, title, text); recommendation.append(copy, action); elements.recommendations.append(recommendation);
  elements.recentConversations.replaceChildren();
  if (!state.conversations.length) { const empty = document.createElement("p"); empty.className = "empty-inline"; empty.textContent = "还没有对话记录。可以从一个材料问题或快捷任务开始。"; elements.recentConversations.append(empty); return; }
  state.conversations.slice(0, 4).forEach((conversation) => { const button = document.createElement("button"); button.type = "button"; button.className = "recent-item"; button.dataset.conversation = conversation.id; const title = document.createElement("strong"); title.textContent = conversation.title; const note = document.createElement("span"); note.textContent = `${conversation.messageCount || 0} 条消息`; button.append(title, note); elements.recentConversations.append(button); });
}

function stopModelCatalogPolling() {
  if (!state.modelCatalogTimer) return;
  window.clearInterval(state.modelCatalogTimer);
  state.modelCatalogTimer = null;
}

function modelStatusLabel(model) {
  if (model.active) return "当前全局使用";
  if (model.downloadState === "downloading") return "正在下载";
  if (model.downloadState === "failed") return "下载失败";
  if (model.installed) return model.verified ? "已下载 · 待启用" : "已下载 · 待校验";
  if (model.status === "preview") return "预发布 · 试用";
  if (model.status === "release-pending") return "发布资源待检查";
  if (model.status === "development") return "开发中";
  return "可下载";
}

function renderModelCatalog(models = []) {
  state.models = Array.isArray(models) ? models : [];
  document.querySelector("#model-import-button")?.classList.toggle("hidden", !state.offline);
  if (!elements.modelGrid) return;
  elements.modelGrid.replaceChildren();
  if (!state.models.length) {
    const empty = document.createElement("p"); empty.className = "empty-inline"; empty.textContent = "模型信息暂不可用"; elements.modelGrid.append(empty); stopModelCatalogPolling(); return;
  }
  let downloading = false;
  state.models.forEach((model) => {
    downloading ||= model.downloadState === "downloading";
    const card = document.createElement("article"); card.className = `model-card ${model.id === "qwen3.5-4b-office" ? "model-card-featured" : ""}`;
    const head = document.createElement("div"); head.className = "model-card-head";
    const copy = document.createElement("div"); const title = document.createElement("strong"); title.textContent = model.name; const subtitle = document.createElement("span"); subtitle.textContent = `${model.parameterBillions}B · ${model.quantization}`; copy.append(title, subtitle);
    const badge = document.createElement("span"); badge.className = `model-badge ${model.active ? "active" : model.status === "development" ? "planned" : ""}`; badge.textContent = modelStatusLabel(model); head.append(copy, badge);
    const message = document.createElement("p"); message.className = "model-card-message"; message.textContent = model.download?.error || model.message || "";
    badge.classList.toggle("planned", model.status === "release-pending");
    const meta = document.createElement("small"); meta.className = "model-card-meta"; meta.textContent = `Release ${model.releaseTag} · 保存到 ${model.modelDirectory || "本机应用数据目录"}`;
    const actions = document.createElement("div"); actions.className = "model-card-actions";
    const download = document.createElement("button"); download.type = "button"; download.className = "primary-button"; download.dataset.modelDownload = model.id;
    const anotherDownload = state.models.some((item) => item.id !== model.id && item.downloadState === "downloading");
    if (model.downloadState === "downloading") { const progress = Number.isFinite(Number(model.download?.progressPercent)) ? ` ${Math.floor(Number(model.download.progressPercent))}%` : ""; download.textContent = `正在下载${progress}`; download.disabled = true; }
    else if (model.downloadAvailable && !model.installed) download.textContent = model.id === "qwen3.5-4b-office" ? "下载 4B 模型" : "下载模型";
    else if (model.installed) { download.textContent = model.active ? "当前全局使用中" : "已下载，待启用"; download.disabled = true; }
    else { download.textContent = "模型开发中"; download.disabled = true; }
    if (model.downloadState !== "downloading") {
      if (model.installed && !model.active) { download.textContent = "切换到此模型"; download.disabled = false; download.dataset.modelActivate = model.id; delete download.dataset.modelDownload; }
      else if (!model.installed && model.downloadAvailable) { download.textContent = model.id === "qwen3.5-4b-office" ? (model.downloadState === "failed" ? "重试检查 4B" : "检查并下载 4B") : (model.downloadState === "failed" ? "重试下载 0.8B" : "下载 0.8B 模型"); download.disabled = anotherDownload; }
    }
    if (Array.isArray(model.sources) && model.sources.length > 1) {
      const sourceLabel = document.createElement("label"); sourceLabel.className = "model-source-control";
      const sourceCaption = document.createElement("span"); sourceCaption.textContent = "下载来源";
      const sourceSelect = document.createElement("select"); sourceSelect.dataset.modelSource = model.id; sourceSelect.disabled = model.downloadState === "downloading";
      for (const source of model.sources) {
        const option = document.createElement("option"); option.value = source.id;
        option.textContent = source.label + (source.available ? "" : " · 未就绪");
        option.disabled = !source.available;
        if (source.reason) option.title = source.reason;
        sourceSelect.append(option);
      }
      const choice = model.sources.find((item) => item.id === selectedModelSources[model.id] && item.available);
      const downloadSourceIsFinal = ["downloading", "completed", "failed"].includes(model.downloadState);
      sourceSelect.value = choice?.id || (downloadSourceIsFinal ? model.download?.sourceId : null) || model.defaultSourceId || "github";
      if (sourceSelect.selectedOptions[0]?.disabled) sourceSelect.value = "github";
      // Keep the visible selector and the actual POST payload in sync even when
      // the user clicks download without first changing the default selection.
      selectedModelSources[model.id] = sourceSelect.value;
      const mirror = model.sources.find((item) => item.id === "modelscope");
      const availability = document.createElement("small"); availability.className = "model-source-hint";
      availability.textContent = mirror?.available ? "国内镜像已配置；下载仍会验证固定 SHA-256。" : (mirror?.reason || "镜像尚未配置；可继续使用 GitHub。");
      sourceLabel.append(sourceCaption, sourceSelect, availability); card.append(sourceLabel);
    }
    actions.append(download);
    const mirror = model.sources?.find((item) => item.id === "modelscope" && item.available);
    if (mirror?.repository) {
      const mirrorLink = document.createElement("a"); mirrorLink.className = "ghost-button model-release-link"; mirrorLink.href = `https://modelscope.cn/models/${mirror.repository}`; mirrorLink.target = "_blank"; mirrorLink.rel = "noreferrer"; mirrorLink.textContent = "打开国内镜像"; actions.append(mirrorLink);
    }
    const release = document.createElement("a"); release.className = "ghost-button model-release-link"; release.href = model.releaseUrl; release.target = "_blank"; release.rel = "noreferrer"; release.textContent = model.status === "development" ? "查看开发说明" : "GitHub Release"; actions.append(release);
    card.append(head, message, meta, actions);
    if (window.pywebview?.api?.choose_model_directory) {
      const choose = document.createElement("button"); choose.type = "button";
      choose.className = "ghost-button model-directory-control";
      choose.dataset.modelDirectory = model.id; choose.textContent = "选择下载位置…";
      choose.disabled = model.installed || downloading || state.models.some(item => item.downloadState === "downloading");
      choose.title = model.installed ? "该模型已下载；下载位置需在下载前选择" : "选择本机文件夹，保存该模型的下载位置";
      card.append(choose);
    }
    elements.modelGrid.append(card);
  });
  if (downloading && !state.modelCatalogTimer) state.modelCatalogTimer = window.setInterval(() => refreshRuntime().catch(() => {}), 900);
  if (!downloading) stopModelCatalogPolling();
}

async function startModelProfileDownload(modelId) {
  const model = state.models.find((item) => item.id === modelId);
  if (!model) return;
  if (!model.downloadAvailable) { showToast(model.message || "该模型暂未开放下载"); return; }
  const sourceId = selectedModelSources[modelId] || model.defaultSourceId || "github";
  const source = model.sources?.find((item) => item.id === sourceId);
  if (source && !source.available) { showToast(source.reason || "所选来源尚未就绪"); return; }
  try {
    if (offlineMode) {
      await request("/api/v1/models/" + encodeURIComponent(modelId) + "/download", { method: "POST", body: JSON.stringify({sourceId}) });
      showToast("正在从" + (source?.label || "GitHub Releases") + "下载并校验模型");
      await refreshRuntime();
      return;
    }
    const payload = await request(`/api/v1/models/${encodeURIComponent(modelId)}/download`, { method: "POST", body: JSON.stringify({sourceId}) });
    showToast(`正在从${source?.label || "GitHub Releases"}下载 ${model.name}，将保存到本机模型目录`);
    renderModelCatalog(state.models.map((item) => item.id === modelId ? { ...item, downloadState: payload.item.state, download: payload.item } : item));
  } catch (error) { showToast(error.message); }
}

async function activateModelProfile(modelId) {
  const model = state.models.find((item) => item.id === modelId);
  if (!model) return;
  try {
    const result = await request("/api/v1/models/" + encodeURIComponent(modelId) + "/activate", { method: "POST" });
    await refreshRuntime();
    showToast(result.item?.restartRequired ? "已选择 " + model.name + "；重启 Windows 应用后生效" : "已切换到 " + model.name);
  } catch (error) { showToast(error.message); }
}

function renderWelcome() {
  elements.messages.replaceChildren(); const wrap = document.createElement("div"); wrap.className = "welcome-card";
  const extractiveOnly = offlineMode && !state.nativeInference;
  const label = document.createElement("p"); label.className = "section-kicker"; label.textContent = state.documents.length ? "本地知识增强已准备" : "从一个任务开始";
  const title = document.createElement("h2"); title.textContent = extractiveOnly ? (state.documents.length ? "查看材料原文与依据" : "先导入一份本地材料") : state.documents.length ? "问材料、写内容、整理下一步" : "先导入材料，或直接开始一项工作";
  const text = document.createElement("p"); text.textContent = extractiveOnly ? "无需模型即可离线检索原文；摘要、对比和写作需要先安装本机模型。" : state.documents.length ? "回答会优先使用本机知识库，并在“引用依据”中显示可核对的来源。" : "你可以先撰写邮件草稿、整理会议纪要，或导入一份资料建立知识库。";
  const actions = document.createElement("div"); actions.className = "suggestion-grid"; (extractiveOnly ? (state.documents.length ? ["quote", "import"] : ["import"]) : state.documents.length ? ["summary", "tasks", "outline"] : ["import", "email", "minutes"]).map(toolById).forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.className = "suggestion"; button.dataset.tool = tool.id; button.textContent = tool.title; actions.append(button); });
  wrap.append(label, title, text, actions); elements.messages.append(wrap);
}
function renderContextActions() { elements.contextActions.replaceChildren(); (offlineMode && !state.nativeInference ? (state.documents.length ? ["quote", "import"] : ["import"]) : state.documents.length ? ["summary", "tasks", "quote"] : ["import", "email", "minutes"]).map(toolById).forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.dataset.tool = tool.id; button.textContent = tool.title; elements.contextActions.append(button); }); }
function renderTextWithCitations(container, text) { renderRichText(container, text, index => { const citations = container.closest(".message")?.citations; if (citations) updateEvidence(citations); focusEvidence(index); }); }
function addMessage(role, content = "", options = {}) {
  document.querySelector(".welcome-card")?.remove(); const item = document.createElement("article"); item.className = `message ${role}`; const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = role === "assistant" ? "微" : firstName().slice(0, 1); const card = document.createElement("div"); card.className = "message-card"; const body = document.createElement("div"); body.className = "message-content"; if (role === "assistant") renderTextWithCitations(body, content); else body.textContent = content; const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = options.meta || (role === "assistant" ? "本地 Agent" : "刚刚"); card.append(body, meta); item.append(avatar, card); elements.messages.append(item); elements.messages.scrollTop = elements.messages.scrollHeight; return { item, body, meta };
}
function addPlanCard(plan, onCompleted) {
  if (plan.riskClass !== "high_risk" && plan.status !== "AWAITING_CONFIRMATION") return;
  const card = document.createElement("section"); card.className = `plan-card ${plan.riskClass || "read_only"}`; const title = document.createElement("strong"); title.textContent = `行动计划 · ${plan.label || plan.tool}`; const status = document.createElement("span"); status.className = "plan-status"; status.textContent = plan.status === "AWAITING_CONFIRMATION" ? "等待你的确认" : "已验证"; const argumentsList = document.createElement("dl"); Object.entries(plan.arguments || {}).forEach(([key, value]) => { const row = document.createElement("div"); const term = document.createElement("dt"); term.textContent = key; const detail = document.createElement("dd"); detail.textContent = Array.isArray(value) ? value.join("、") : String(value); row.append(term, detail); argumentsList.append(row); }); const note = document.createElement("p"); note.className = "plan-note"; note.textContent = plan.riskClass === "high_risk" ? "外部或不可逆操作必须先确认。" : "该计划已经本地策略校验。"; card.append(title, status, argumentsList, note);
  if (plan.status === "AWAITING_CONFIRMATION") { const actions = document.createElement("div"); actions.className = "plan-actions"; const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "ghost-button"; cancel.textContent = "取消"; const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "primary-button"; confirm.textContent = "确认执行"; cancel.addEventListener("click", async () => { try { await request(`/api/v1/plans/${encodeURIComponent(plan.planId)}/cancel`, { method: "POST" }); status.textContent = "已取消"; actions.remove(); } catch (error) { showToast(error.message); } }); confirm.addEventListener("click", async () => { confirm.disabled = cancel.disabled = true; status.textContent = "正在执行"; try { const result = await request(`/api/v1/plans/${encodeURIComponent(plan.planId)}/confirm`, { method: "POST" }); status.textContent = result.plan?.status === "SUCCEEDED" ? "已完成" : (result.plan?.status || "已提交"); actions.remove(); onCompleted?.(result); } catch (error) { status.textContent = "确认未通过"; showToast(error.message); } }); actions.append(cancel, confirm); card.append(actions); }
  elements.messages.append(card); elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateEvidence(items) {
  state.citations = items; elements.evidenceCount.textContent = String(items.length); elements.evidence.replaceChildren();
  if (!items.length) { elements.evidence.className = "evidence-list empty-state"; elements.evidence.innerHTML = "<p>本轮没有检索到可引用证据。</p>"; return; }
  elements.evidence.className = "evidence-list";
  items.forEach((item, index) => { const card = document.createElement("article"); card.className = "evidence-card"; card.dataset.evidenceIndex = String(index); const header = document.createElement("header"); const title = document.createElement("span"); title.textContent = `${index + 1}. ${item.fileName}`; const score = document.createElement("span"); score.className = "score"; score.textContent = `${Math.round(item.score * 100)}% 匹配`; const quote = document.createElement("p"); quote.textContent = item.quote; const locator = document.createElement("small"); locator.textContent = item.locator; header.append(title, score); card.append(header, quote, locator); elements.evidence.append(card); });
}
function focusEvidence(index) { switchInsight("evidence"); const card = elements.evidence.querySelector(`[data-evidence-index="${index}"]`); if (!card) return; card.scrollIntoView({ behavior: "smooth", block: "center" }); card.animate([{ outline: "2px solid rgba(42,98,221,.42)" }, { outline: "0 solid rgba(42,98,221,0)" }], { duration: 650 }); }
function formatDuration(value) { const milliseconds = Number(value); if (!Number.isFinite(milliseconds)) return "—"; return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`; }
function updateMetrics(metrics) { elements.ttft.textContent = formatDuration(metrics.responseLatencyMs ?? metrics.ttftMs); elements.retrieval.textContent = metrics.retrievalMs == null ? (metrics.ragEnabled === false ? "未启用" : "—") : formatDuration(metrics.retrievalMs); elements.speed.textContent = Number(metrics.generatedTokens) > 0 && Number(metrics.modelGenerationMs) > 0 && Number.isFinite(Number(metrics.tokensPerSecond)) ? `${Number(metrics.tokensPerSecond).toFixed(1)} tok/s` : "—"; elements.memory.textContent = metrics.peakRssMb != null && Number.isFinite(Number(metrics.peakRssMb)) ? `${Number(metrics.peakRssMb).toFixed(1)} MB` : "—"; }
function resetMetrics() { [elements.ttft, elements.retrieval, elements.speed, elements.memory].forEach((item) => { item.textContent = "—"; }); }
function setGenerating(isGenerating) { elements.send.disabled = isGenerating; elements.input.disabled = isGenerating; elements.stop.classList.toggle("hidden", !isGenerating); elements.chatPanel.classList.toggle("is-generating", isGenerating); elements.chatPanel.setAttribute("aria-busy", String(isGenerating)); }
function autoResizeComposer() { elements.input.style.height = "auto"; elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`; }
function switchInsight(name) { elements.insightTabs.forEach((button) => button.classList.toggle("active", button.dataset.insight === name)); elements.insightContents.forEach((content) => content.classList.toggle("active", content.dataset.insightContent === name)); }

function stopModelDownloadPolling() {
  if (!state.modelDownloadTimer) return;
  window.clearInterval(state.modelDownloadTimer);
  state.modelDownloadTimer = null;
}
function renderModelDownload(download, model) {
  state.modelDownload = download || null;
  if (state.offline || !download?.enabled) { elements.modelDownloadControl.classList.add("hidden"); stopModelDownloadPolling(); return; }
  const downloading = download.state === "downloading";
  const modelUnavailable = model?.status === "llama-cpp-unavailable";
  const shouldShow = downloading || !download.modelInstalled || modelUnavailable || download.state === "failed";
  elements.modelDownloadControl.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) { stopModelDownloadPolling(); return; }
  const location = download.modelDirectory || "本机应用数据目录";
  elements.modelDownloadLocation.textContent = `保存到：${location}`;
  elements.modelDownloadLocation.title = location;
  elements.modelDownloadButton.disabled = downloading;
  if (downloading) {
    const progress = Number.isFinite(Number(download.progressPercent)) ? ` ${Math.floor(Number(download.progressPercent))}%` : "";
    elements.modelDownloadButton.textContent = `${download.phase || "正在下载模型"}${progress}`;
  } else if (download.state === "failed") {
    elements.modelDownloadButton.textContent = "重试下载模型";
  } else {
    elements.modelDownloadButton.textContent = state.offline ? "导入 GGUF 模型" : "下载本地模型";
  }
  elements.modelDownloadButton.title = download.error || (state.offline ? `从手机文件中导入 GGUF 模型，保存到：${location}` : `下载并校验本地 GGUF 模型，保存到：${location}`);
  if (downloading && !state.modelDownloadTimer) {
    state.modelDownloadTimer = window.setInterval(() => refreshRuntime().catch(() => {}), 900);
  }
  if (!downloading) stopModelDownloadPolling();
}
async function refreshRuntime() {
  const [health, runtime] = await Promise.all([request("/api/v1/health"), request("/api/v1/runtime/status")]);
  const mode = state.mobile?.mode || (state.offline ? "offline" : "local");
  const location = mode === "local" || mode === "offline" ? "本机离线处理" : mode === "lan" ? "连接电脑处理" : "连接服务处理";
  elements.sidebarStatus.textContent = health.status === "ok" ? location : "服务异常";
  const chatModel = runtime.chatModel || runtime.model;
  state.nativeInference = Boolean(chatModel.nativeInference || (!offlineMode && ["llama-cpp-ready", "llama-cpp-available"].includes(chatModel.status)));
  const ready = state.nativeInference;
  const modelLoaded = chatModel.status === "llama-cpp-ready" || Boolean(chatModel.loaded);
  elements.runtimeBadge.textContent = modelLoaded ? "模型运行中" : ready ? "模型已安装 · 首次使用会加载" : offlineMode ? "可检索原文 · 模型未就绪" : "模型需要设置";
  elements.runtimeBadge.title = [chatModel.name, runtime.modelRoutingNotice].filter(Boolean).join(" · ");
  document.querySelector("#runtime-badge").classList.toggle("needs-attention", !ready);
  document.querySelector(".privacy-label").textContent = location;
  document.querySelector(".panel-footnote").textContent = mode === "local" || mode === "offline" ? "材料与对话保存在本机，结果可以复制或导出。" : "材料会发送到已连接的服务；请保持电脑或服务在线。";
  renderModelDownload(runtime.modelDownload, runtime.model);
  renderModelCatalog(runtime.models || []);
  if (runtime.modelRoutingNotice) {
    const notice = document.createElement("p"); notice.className = "model-card-message"; notice.textContent = runtime.modelRoutingNotice; elements.modelGrid.prepend(notice);
  }
  if (offlineMode) { renderTools(); renderDashboard(); renderContextActions(); if (!state.conversationId && !state.controller) renderWelcome(); }
}
async function startModelDownload() {
  if (offlineMode) {
    try {
      const model = await offlineRuntime.pickModel();
      await refreshRuntime();
      showToast(model.installed ? "模型已导入手机本地存储" : "未导入模型");
    } catch (error) {
      if (!String(error.message || "").includes("取消")) showToast(error.message);
    }
    return;
  }
  try {
    const payload = await request("/api/v1/model/download", { method: "POST" });
    renderModelDownload(payload.item, null);
    showToast(`已开始下载模型，将保存到：${payload.item.modelDirectory || "本机应用数据目录"}`);
  } catch (error) {
    showToast(error.message);
  }
}
async function refreshConversations() {
  const payload = await request("/api/v1/conversations"); state.conversations = payload.items; elements.conversations.replaceChildren();
  if (!payload.items.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "还没有保存的对话"; elements.conversations.append(empty); }
  else payload.items.forEach((conversation) => { const button = document.createElement("button"); button.className = `conversation-item ${conversation.id === state.conversationId ? "active" : ""}`; button.type = "button"; button.textContent = conversation.title; button.addEventListener("click", () => loadConversation(conversation.id)); elements.conversations.append(button); });
  renderDashboard();
}
async function loadConversation(id) {
  if (state.controller) return showToast("请先等待当前结果，或停止接收");
  const payload = await request(`/api/v1/conversations/${encodeURIComponent(id)}`);
  state.conversationId = payload.item.id; elements.messages.replaceChildren();
  payload.item.messages.forEach(message => {
    const item = addMessage(message.role, message.content, {meta: message.role === "assistant" ? answerLabel(message.metrics?.answerKind, message.metrics) : "历史提问"});
    item.item.citations = message.citations || [];
    if (message.role === "assistant") experience.resultActions(item, message.content, message.citations || [], message.metrics?.answerKind);
  });
  const lastAssistant = [...payload.item.messages].reverse().find(item => item.role === "assistant");
  state.documentIds = lastAssistant?.metrics?.documentIds || null; clearActiveTool(); experience.refreshScope();
  updateEvidence(lastAssistant?.citations || []); if (lastAssistant?.metrics) updateMetrics(lastAssistant.metrics); else resetMetrics();
  switchView("chat"); document.querySelector("#chat-view").classList.remove("show-history"); refreshConversations();
}
function newChat() { if (state.controller) return showToast("请先等待当前结果，或停止接收"); state.conversationId = null; state.citations = []; state.documentIds = null; clearActiveTool(); renderWelcome(); renderContextActions(); updateEvidence([]); resetMetrics(); refreshConversations(); elements.input.focus(); }
function parseSseChunk(buffer, onEvent) {
  const blocks = buffer.split("\n\n"); const remainder = blocks.pop();
  for (const block of blocks) { const event = block.match(/^event:\s*(.+)$/m)?.[1] || "message"; const raw = block.match(/^data:\s*(.+)$/m)?.[1]; if (!raw) continue; let data; try { data = JSON.parse(raw); } catch { continue; } onEvent(event, data); }
  return remainder;
}
async function sendMessage(question, requestMessage = question, task = null) {
  if (offlineMode) return sendOfflineMessage(question, requestMessage, task);
  addMessage("user", question); const assistant = addMessage("assistant", "", { meta: "准备中" }); assistant.body.classList.add("typing"); assistant.body.textContent = "正在规划本地任务"; updateEvidence([]); resetMetrics(); setGenerating(true); state.controller = new AbortController(); let answer = "";
  try {
    let answerKind = null; let answerMetrics = {}; let finished = false;
    const sourceIds = WRITING_TASKS.has(task) ? null : state.documentIds;
    const response = await fetch(apiPath("/api/v1/chat/stream"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: state.conversationId, message: requestMessage, displayMessage: question, ragEnabled: state.ragEnabled, documentIds: sourceIds, task }), signal: state.controller.signal });
    if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.error?.message || "暂时无法处理，请稍后重试"); }
    if (!response.body) throw new Error("无法建立回答连接");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
    const handleEvent = (event, data) => {
      if (event === "meta") { state.conversationId = data.conversationId; assistant.meta.textContent = data.ragEnabled ? `${data.model} · 知识增强` : `${data.model} · 直接推理`; }
      if (event === "stage") { assistant.body.classList.add("typing"); assistant.body.textContent = data.label; assistant.meta.textContent = "处理中"; }
      if (event === "plan") addPlanCard(data, (result) => { if (result.citations?.length) updateEvidence(result.citations); assistant.body.classList.remove("typing"); assistant.body.textContent = result.answer || "本地沙箱操作已完成。"; assistant.meta.textContent = "本地 Agent · 已完成"; });
      if (event === "citations") { assistant.item.citations = data.items || []; updateEvidence(data.items || []); }
      if (event === "token") { if (!answer) { assistant.body.classList.remove("typing"); assistant.body.textContent = ""; } answer += data.text; renderTextWithCitations(assistant.body, answer); assistant.body.classList.add("streaming"); assistant.meta.textContent = "本地 Agent · 流式输出"; elements.messages.scrollTop = elements.messages.scrollHeight; }
      if (event === "metrics") { updateMetrics(data); answerKind = data.answerKind; answerMetrics = data; }
      if (event === "done") { finished = true; assistant.body.classList.remove("streaming"); assistant.meta.textContent = answerLabel(answerKind, answerMetrics); experience.resultActions(assistant, answer, assistant.item.citations || [], answerKind); }
      if (event === "error") throw new Error(data.message || "生成失败");
    };
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer = parseSseChunk(buffer + value, handleEvent); }
    if (buffer.trim()) parseSseChunk(`${buffer}\n\n`, handleEvent);
    if (!finished) throw new Error("连接已中断，结果可能不完整，请重试");
    await Promise.allSettled([refreshConversations(), refreshRuntime()]);
  } catch (error) {
    assistant.body.classList.remove("typing", "streaming");
    if (error.name === "AbortError") { if (!answer) assistant.body.textContent = "已停止接收。服务端可能仍在处理，可以稍后查看历史对话。"; assistant.meta.textContent = "接收已停止"; }
    else { assistant.body.textContent = `发生错误：${error.message}`; assistant.meta.textContent = "生成失败"; showToast(error.message); }
  } finally { setGenerating(false); state.controller = null; experience.refreshScope(); }
}

async function sendOfflineMessage(question, requestMessage = question, task = null) {
  addMessage("user", question);
  const assistant = addMessage("assistant", "", {meta: "手机本地检索"});
  assistant.body.classList.add("typing");
  assistant.body.textContent = "正在检索手机本地材料";
  updateEvidence([]);
  resetMetrics();
  setGenerating(true);
  try {
    const result = await offlineRuntime.answer(requestMessage, {conversationId: state.conversationId, ragEnabled: state.ragEnabled, documentIds: WRITING_TASKS.has(task) ? null : state.documentIds, task});
    state.conversationId = result.conversationId;
    assistant.body.classList.remove("typing");
    assistant.item.citations = result.citations || [];
    renderTextWithCitations(assistant.body, result.answer);
    assistant.meta.textContent = answerLabel(result.metrics?.answerKind, result.metrics);
    updateEvidence(result.citations || []);
    updateMetrics(result.metrics || {});
    experience.resultActions(assistant, result.answer, result.citations || [], result.metrics?.answerKind);
    await Promise.all([refreshConversations(), refreshDocuments()]);
  } catch (error) {
    assistant.body.classList.remove("typing");
    assistant.body.textContent = "发生错误：" + error.message;
    assistant.meta.textContent = "离线处理失败";
    showToast(error.message);
  } finally {
    setGenerating(false);
    experience.refreshScope();
  }
}

async function refreshDocuments() {
  const payload = await request("/api/v1/documents"); state.documents = payload.items; const imported = payload.items.filter((item) => !item.builtin).length;
  elements.knowledgeSummary.replaceChildren(); [`${payload.items.length} 份材料`, `${imported} 份用户导入`, "导入后即时参与检索"].forEach((text) => { const tag = document.createElement("span"); tag.className = "summary-chip"; tag.textContent = text; elements.knowledgeSummary.append(tag); });
  elements.documentList.replaceChildren();
  payload.items.forEach((item) => {
    const card = document.createElement("article"); card.className = "document-card"; const main = document.createElement("div"); main.className = "document-main"; const icon = document.createElement("div"); icon.className = "document-icon"; icon.textContent = item.builtin ? "内" : (item.name.split(".").pop() || "文").slice(0, 4).toUpperCase(); const info = document.createElement("div"); const title = document.createElement("strong"); title.textContent = item.name; const detail = document.createElement("span"); const quality = item.extractionQuality === "ocr-reviewed" ? "OCR 已识别" : item.extractionQuality === "ocr-low-confidence" ? "OCR 待复核" : item.extractionQuality === "partial-text" ? "部分页面未提取" : item.extractionQuality === "native-structure" ? "结构化提取" : "原生文本"; detail.textContent = `${item.source} · ${item.characters} 字符 · ${item.locator} · ${quality}`; info.append(title, detail); if (item.importWarning) { const warning = document.createElement("small"); warning.className = "document-warning"; warning.textContent = item.importWarning; info.append(warning); } main.append(icon, info);
    const actions = document.createElement("div"); actions.className = "document-actions"; const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = item.builtin ? "内置" : (["ocr-low-confidence", "partial-text"].includes(item.extractionQuality) ? "部分可读" : "已导入"); actions.append(tag);
    experience.documentActions(item, actions);
    if (!item.builtin) { const remove = document.createElement("button"); remove.className = "delete-button"; remove.type = "button"; remove.textContent = "移除"; remove.addEventListener("click", async () => { if (!await experience.confirmRemoval(item.name)) return; remove.disabled = true; try { await request(`/api/v1/documents/${encodeURIComponent(item.id)}`, { method: "DELETE" }); await Promise.all([refreshDocuments(), refreshRuntime()]); showToast("材料已移除，本地索引已更新"); } catch(error) { showToast(error.message); remove.disabled = false; } }); actions.append(remove); }
    card.append(main, actions); elements.documentList.append(card);
  });
  if (!payload.items.length) { const empty = document.createElement("div"); empty.className = "knowledge-empty"; empty.innerHTML = "<span aria-hidden='true'>＋</span><h3>从一份正在处理的材料开始</h3><p>导入后，可以直接总结、提问或与另一份文件对比。</p><p>支持 TXT、Markdown、PDF、Word、Excel、CSV、PPTX 和 HTML</p>"; elements.documentList.append(empty); }
  renderDashboard(); if (!state.conversationId && !state.controller) renderWelcome(); renderContextActions(); experience.refreshScope();
}

function pptPreviewUrl(presentationId, versionId, slideId) {
  if (offlineMode) return state.ppt.slides.find(s=>s.slideId===slideId)?.previewUrl || "";
  return apiPath(`/api/v1/presentations/${encodeURIComponent(presentationId)}/versions/${encodeURIComponent(versionId)}/slides/${encodeURIComponent(slideId)}/preview`);
}
function renderPptCapability(capability) {
  const warning = capability?.warning;
  elements.pptWarning.classList.toggle("hidden", !warning);
  elements.pptWarning.textContent = warning || "";
}
async function refreshPresentations(preferredId = null) {
  const payload = await request("/api/v1/presentations");
  state.ppt.presentations = payload.items || [];
  renderPptCapability(payload.runtime?.capability);
  elements.pptSelect.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = state.ppt.presentations.length ? "选择演示文稿" : "尚未导入 PPTX"; elements.pptSelect.append(placeholder);
  state.ppt.presentations.forEach((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.name} · ${item.versionCount} 个版本`; elements.pptSelect.append(option); });
  const target = preferredId || state.ppt.current?.id || state.ppt.presentations[0]?.id;
  if (target && state.ppt.presentations.some((item) => item.id === target)) { elements.pptSelect.value = target; await loadPptPresentation(target); }
  else { state.ppt.current = null; elements.pptEmpty.classList.remove("hidden"); elements.pptWorkspace.classList.add("hidden"); }
}
async function loadPptPresentation(id) {
  const selectedSlide = state.ppt.current?.id === id ? state.ppt.slideId : null;
  if(state.ppt.current?.id !== id) {state.ppt.undoVersionId=null;state.ppt.asset=null;elements.pptAssetLabel.textContent="未选择图片";}
  const [detail, slides] = await Promise.all([request(`/api/v1/presentations/${encodeURIComponent(id)}`), request(`/api/v1/presentations/${encodeURIComponent(id)}/slides`)]);
  state.ppt.current = detail.item; state.ppt.versionId = slides.versionId; state.ppt.slides = slides.items || []; state.ppt.slideId = state.ppt.slides.find(s => s.slideId === selectedSlide)?.slideId || state.ppt.slides[0]?.slideId || null; state.ppt.patch = null; state.ppt.publishedVersionId = null;
  state.ppt.render = slides.render || detail.item.render;
  if (slides.slideSize) elements.pptStage.style.setProperty("--ppt-ratio", `${slides.slideSize.width} / ${slides.slideSize.height}`);
  renderPptCapability(detail.item.modelCapability); elements.pptEmpty.classList.add("hidden"); elements.pptWorkspace.classList.remove("hidden"); elements.pptVersionLabel.textContent = shortId(state.ppt.versionId); elements.pptSlideCount.textContent = String(state.ppt.slides.length); elements.pptPlanCard.classList.add("hidden"); elements.pptComplete.classList.add("hidden");
  elements.pptComplete.classList.remove("hidden"); elements.pptUndo.disabled = !(state.ppt.current?.versions?.length > 1);
  renderPptSlides(); renderPptVersions(); if (state.ppt.slideId) selectPptSlide(state.ppt.slideId);
}
function renderPptSlides() {
  elements.pptSlideList.replaceChildren();
  state.ppt.slides.forEach((slide) => { const button = document.createElement("button"); button.type = "button"; button.className = `ppt-slide-thumb ${slide.slideId === state.ppt.slideId ? "active" : ""}`; button.dataset.slideId = slide.slideId; const image = document.createElement("img"); image.alt = `第 ${slide.slideNumber} 页`; image.src = pptPreviewUrl(state.ppt.current.id, state.ppt.versionId, slide.slideId); const label = document.createElement("span"); label.textContent = `${slide.slideNumber}`; button.append(image, label); button.addEventListener("click", () => selectPptSlide(slide.slideId)); elements.pptSlideList.append(button); });
}
function selectPptSlide(slideId) {
  if (state.ppt.patch?.status === "PREVIEW_READY" && slideId !== state.ppt.patch.slideId) return showToast("请先应用或取消当前预览，再切换页面");
  if (state.ppt.patch?.status === "PREVIEW_READY") return;
  state.ppt.slideId = slideId; state.ppt.mode = "before"; elements.pptSlideList.querySelectorAll(".ppt-slide-thumb").forEach((button) => button.classList.toggle("active", button.dataset.slideId === slideId)); elements.pptBefore.src = pptPreviewUrl(state.ppt.current.id, state.ppt.versionId, slideId); elements.pptAfter.removeAttribute("src"); elements.pptPreviewStatus.textContent = `${slideId.replace("slide-", "第 ")} 页 · ${state.ppt.render?.approximate ? "结构预览（非原版渲染）" : "原版预览"}`; elements.pptPreviewStatus.title = state.ppt.render?.warning || ""; setPptMode("before");
}
function setPptMode(mode) {
  if (mode !== "before" && !elements.pptAfter.getAttribute("src")) return showToast("先生成一次修改预览");
  state.ppt.mode = mode; elements.pptModes.forEach((button) => button.classList.toggle("active", button.dataset.pptMode === mode)); elements.pptStage.classList.toggle("compare", mode === "compare"); elements.pptStage.querySelector(".before").classList.toggle("hidden", mode === "after"); elements.pptStage.querySelector(".after").classList.toggle("hidden", mode === "before");
}
function renderPptVersions() {
  elements.pptVersionList.replaceChildren();
  (state.ppt.current?.versions || []).forEach((version) => { const row = document.createElement("div"); row.className = `ppt-version-item ${version.id === state.ppt.current.currentVersionId ? "current" : ""}`; const copy = document.createElement("span"); const label=document.createElement("strong"); label.textContent=version.id === state.ppt.current.currentVersionId ? "当前工作副本" : version.sourceKind === "import" ? "原始文件" : "自动保存记录"; const time=document.createElement("small");time.textContent=version.createdAt?new Date(version.createdAt).toLocaleString():shortId(version.id);copy.append(label,time); const link = document.createElement("button");link.className="text-button";link.type="button";link.textContent="导出";link.addEventListener("click",()=>downloadCurrentPpt(version.id)); row.append(copy, link); elements.pptVersionList.append(row); });
}
async function uploadPptAsset(file) {
  if(offlineMode) {const item=await offlineRuntime.ppt.uploadAsset(state.ppt.current.id,file);state.ppt.asset=item;elements.pptAssetLabel.textContent=item.name;return item;}
  const form = new FormData(); form.append("file", file, file.name); const response = await fetch(apiPath(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/assets`), { method: "POST", body: form }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "图片上传失败"); } const payload = await response.json(); state.ppt.asset = payload.item; elements.pptAssetLabel.textContent = `${payload.item.name} · 已隔离为 ${payload.item.uri}`; return payload.item;
}
async function generatePptPatch() {
  if (!state.ppt.current || !state.ppt.slideId) return showToast("请先导入并选择一页 PPT");
  const instruction = elements.pptInstruction.value.trim(); if (!instruction) return showToast("请输入修改要求");
  elements.pptGenerate.disabled = true; elements.pptGenerate.textContent = "正在生成并验证预览"; elements.pptComplete.classList.add("hidden");
  try {
    if (state.ppt.patch?.status === "PREVIEW_READY") {await request(`/api/v1/ppt-patches/${encodeURIComponent(state.ppt.patch.id)}/cancel`, {method:"POST"});state.ppt.patch=null;elements.pptPlanCard.classList.add("hidden");}
    const created = await request(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/patches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: state.ppt.versionId, slideId: state.ppt.slideId, instruction }) });
    const simulated = await request(`/api/v1/ppt-patches/${encodeURIComponent(created.item.id)}/simulate`, { method: "POST" }); state.ppt.patch = simulated.item; renderPptPatch(simulated.item); elements.pptAfter.src = simulated.item.previewUrl || apiPath(`/api/v1/ppt-patches/${encodeURIComponent(simulated.item.id)}/slides/${encodeURIComponent(state.ppt.slideId)}/preview?t=${Date.now()}`); setPptMode("compare"); showToast("预览已就绪，核对后应用即可继续编辑");
  } catch (error) { showToast(error.message); }
  finally { elements.pptGenerate.disabled = false; elements.pptGenerate.textContent = "生成修改计划与预览";elements.pptComplete.classList.remove("hidden"); }
}
function renderPptPatch(patch) {
  elements.pptPlanCard.classList.remove("hidden"); elements.pptPlanTitle.textContent = patch.model || "PPT 专用计划器"; elements.pptPlanStatus.textContent = patch.status === "PREVIEW_READY" ? "已验证" : patch.status; elements.pptPlanSlide.textContent = patch.slideId; elements.pptPlanCount.textContent = `${patch.operations.length} 项`; elements.pptPlanVersion.textContent = shortId(patch.baseVersion); elements.pptPlanHash.textContent = patch.patchHash.slice(0, 12); elements.pptOperations.replaceChildren(); patch.operations.forEach((operation) => { const item = document.createElement("li"); item.textContent = describePptOperation(operation); elements.pptOperations.append(item); }); const verification = patch.verification || {}; elements.pptVerification.textContent = verification.ok ? `已重新打开文件并验证；${verification.nonTargetSlidesVerified || 0} 张非目标页未改变。预览方式：${verification.render?.mode || "本地渲染"}${verification.render?.approximate ? "（近似布局）" : ""}。` : "尚未完成验证"; elements.pptConfirm.disabled = !patch.previewReady;
}
function describePptOperation(item) { const labels = { replace_paragraph: "替换段落", clone_paragraph: "克隆段落", del_paragraph: "删除段落", replace_image: "替换图片", del_image: "删除图片" }; const target = item.div_id != null ? `文本框 ${item.div_id} / 段落 ${item.paragraph_id}` : `图片 ${item.image_id}`; return `${labels[item.operation] || item.operation} · ${target}`; }
async function confirmPptPatch() {
  if (!state.ppt.patch) return; elements.pptConfirm.disabled = true;
  try { const previousVersion = state.ppt.patch.baseVersion; const presentationId = state.ppt.current.id; const result = await request(`/api/v1/ppt-patches/${encodeURIComponent(state.ppt.patch.id)}/confirm`, { method: "POST" }); await refreshPresentations(presentationId); state.ppt.publishedVersionId = result.version.id; state.ppt.undoVersionId = previousVersion; state.ppt.patch = null; elements.pptInstruction.value = ""; elements.pptPlanCard.classList.add("hidden"); elements.pptComplete.classList.remove("hidden"); elements.pptInstruction.focus({preventScroll:true}); showToast("已自动保存，可以继续修改当前页"); } catch (error) { showToast(error.message); } finally { elements.pptConfirm.disabled = false; }
}
async function cancelPptPatch() { if (!state.ppt.patch) return; try { await request(`/api/v1/ppt-patches/${encodeURIComponent(state.ppt.patch.id)}/cancel`, { method: "POST" }); state.ppt.patch = null; elements.pptPlanCard.classList.add("hidden"); setPptMode("before"); showToast("修改计划已取消"); } catch (error) { showToast(error.message); } }
function currentPptDownloadUrl(versionId = state.ppt.publishedVersionId || state.ppt.versionId) { return apiPath(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/versions/${encodeURIComponent(versionId)}/download`); }
async function downloadCurrentPpt(versionId = state.ppt.versionId) {
  if(typeof versionId !== "string") versionId = state.ppt.versionId;
  if (offlineMode) {
    try { const file = await offlineRuntime.ppt.download(state.ppt.current.id, versionId);
      const blob = new Blob([file.bytes], {type:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
      const Filesystem = globalThis.Capacitor?.Plugins?.Filesystem, Share = globalThis.Capacitor?.Plugins?.Share;
      if (Filesystem?.writeFile && Share?.share) { let data=""; for(let i=0;i<file.bytes.length;i+=8192)data+=String.fromCharCode(...file.bytes.subarray(i,i+8192));
        const saved=await Filesystem.writeFile({path:`edge-office-${Date.now()}.pptx`, data:btoa(data), directory:"CACHE"});
        await Share.share({title:file.name, files:[saved.uri], dialogTitle:"保存或打开 PPT"}); return;
      }
      const url=URL.createObjectURL(blob), link=document.createElement("a");link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    } catch(error){showToast(error.message);} return;
  }
  const url = currentPptDownloadUrl(versionId);
  if (isNativeApp()) {
    try { if (await shareFile(url, "微知 Edge Office PPT")) return; } catch (error) { showToast(error.message || "系统分享不可用"); }
  }
  const link = document.createElement("a"); link.href = url; link.click();
}
function openCurrentPpt() { if(offlineMode)return downloadCurrentPpt(); const url = currentPptDownloadUrl(); const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).href; window.location.href = `ms-powerpoint:ofe|u|${absolute}`; window.setTimeout(() => showToast("若 PowerPoint 未打开，请使用“下载”后双击文件"), 800); }
async function undoPptVersion() { const baseVersion = state.ppt.undoVersionId || state.ppt.patch?.baseVersion || state.ppt.current?.versions?.[1]?.id; if (!baseVersion) return showToast("没有可恢复的上一版本"); try { await request(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/versions/${encodeURIComponent(baseVersion)}/restore`, { method: "POST" }); await refreshPresentations(state.ppt.current.id); state.ppt.undoVersionId = null; elements.pptComplete.classList.remove("hidden"); showToast("已撤销并自动保存，可以继续修改"); } catch (error) { showToast(error.message); } }
function shortId(value) { const text = String(value || "—"); return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text; }
function switchView(viewName, options = {}) {
  const metadata = { home: ["工作台", "PERSONAL WORKSPACE"], chat: ["智能对话", "LOCAL AGENT"], knowledge: ["知识库", "LOCAL KNOWLEDGE BASE"], ppt: ["PPT 编辑", "VERSIONED POWERPOINT EDITOR"], tools: ["全部工具", "TASK LIBRARY"] };
  if (!metadata[viewName]) return;
  elements.nav.forEach((button) => button.classList.toggle("active", button.dataset.view === viewName)); elements.views.forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`)); [elements.viewTitle.textContent, elements.viewEyebrow.textContent] = metadata[viewName];
  if (viewName === "knowledge") refreshDocuments(); if (viewName === "ppt") refreshPresentations(); if (viewName === "home") renderDashboard(); if (viewName === "tools") renderTools();
  if (options.persist !== false && state.profile?.lastView !== viewName) savePreferences({ lastView: viewName }, { quiet: true }).catch(() => {});
}
function openSettings() { populateProfileForm(elements.settingsForm, state.profile); elements.settingsLayer.classList.remove("hidden"); }
function closeSettings() { elements.settingsLayer.classList.add("hidden"); }
function renderCommandList(query = "") {
  const normalized = query.trim().toLowerCase(); const items = TOOL_CATALOG.filter((tool) => (!normalized || `${tool.title} ${tool.detail} ${tool.group}`.toLowerCase().includes(normalized))); elements.commandList.replaceChildren();
  if (!items.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "没有匹配的任务"; elements.commandList.append(empty); return; }
  items.forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.dataset.tool = tool.id; const content = document.createElement("span"); const title = document.createElement("strong"); title.textContent = tool.title; const detail = document.createElement("small"); detail.textContent = `${tool.group} · ${tool.detail}`; content.append(title, detail); const status = document.createElement("em"); status.textContent = offlineModelRequired(tool) ? "需要模型" : TOOL_STATUS[tool.status]; button.append(content, status); elements.commandList.append(button); });
}
function openCommand() { renderCommandList(); elements.commandLayer.classList.remove("hidden"); window.setTimeout(() => elements.commandInput.focus(), 0); }
function closeCommand() { elements.commandLayer.classList.add("hidden"); elements.commandInput.value = ""; }
async function showContextTip(id, message) {
  if (state.profile?.seenTips?.includes(id)) return;
  elements.contextTipText.textContent = message; elements.contextTip.classList.remove("hidden");
  try { await savePreferences({ seenTips: [...(state.profile.seenTips || []), id] }, { quiet: true }); } catch { /* Non-critical UI hint. */ }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-onboarding-next]").forEach((button) => button.addEventListener("click", () => showOnboardingStep(state.onboardingStep + 1)));
document.querySelectorAll("[data-onboarding-back]").forEach((button) => button.addEventListener("click", () => showOnboardingStep(state.onboardingStep - 1)));
document.querySelectorAll("[data-first-task]").forEach((button) => button.addEventListener("click", () => finishOnboarding(button.dataset.firstTask)));
document.querySelector("#onboarding-skip").addEventListener("click", () => finishOnboarding("home"));
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#close-settings").addEventListener("click", closeSettings);
document.querySelector("#restart-onboarding").addEventListener("click", () => { closeSettings(); openOnboarding(0); });
document.querySelector("#open-command").addEventListener("click", openCommand);
document.querySelector("#close-command").addEventListener("click", closeCommand);
document.querySelector("#close-context-tip").addEventListener("click", () => elements.contextTip.classList.add("hidden"));
elements.clearActiveTool.addEventListener("click", clearActiveTool);
elements.modelDownloadButton.addEventListener("click", startModelDownload);
document.querySelector("#model-import-button")?.addEventListener("click", startModelDownload);
elements.modelGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-model-download], [data-model-activate], [data-model-directory]");
  if (!button || button.disabled) return;
  if (button.dataset.modelDirectory) chooseModelDirectory(button.dataset.modelDirectory);
  else if (button.dataset.modelActivate) activateModelProfile(button.dataset.modelActivate);
  else if (button.dataset.modelDownload) startModelProfileDownload(button.dataset.modelDownload);
});
async function chooseModelDirectory(modelId) {
  try {
    const result = await window.pywebview.api.choose_model_directory(modelId);
    if (result.error) throw new Error(result.error);
    if (result.cancelled) return;
    await refreshRuntime();
    showToast("下载位置已保存：" + result.modelDirectory);
  } catch (error) { showToast(error.message); }
}
window.addEventListener("pywebviewready", () => refreshRuntime().catch(() => {}));
elements.modelGrid?.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-model-source]");
  if (select) selectedModelSources[select.dataset.modelSource] = select.value;
});
elements.newChat.addEventListener("click", newChat);
elements.insightTabs.forEach((button) => button.addEventListener("click", () => switchInsight(button.dataset.insight)));
elements.ragToggle.addEventListener("change", () => { state.ragEnabled = elements.ragToggle.checked; elements.ragLabel.textContent = state.ragEnabled ? "已启用" : "已关闭"; document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库"; savePreferences({ ragEnabled: state.ragEnabled }, { quiet: true }).catch(() => {}); renderDashboard(); });
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const userInput = elements.input.value.trim();
  const tool = toolById(state.activeToolId);
  if ((!userInput && !tool) || state.controller) return;
  if (tool?.id === "compare" && state.documentIds?.length !== 2) return experience.chooseSources(true);
  if (!userInput && ["email", "polish", "minutes", "quote"].includes(tool?.id)) { elements.input.focus(); return showToast("请先输入要处理的内容或问题"); }
  const displayMessage = userInput || tool.title;
  const requestMessage = tool ? composeToolRequest(tool, userInput) : userInput;
  elements.input.value = "";
  autoResizeComposer();
  sendMessage(displayMessage, requestMessage, tool?.id || null);
});
elements.input.addEventListener("input", autoResizeComposer);
elements.input.addEventListener("keydown", (event) => { if (event.isComposing || event.keyCode === 229) return; if (event.key === "/" && !elements.input.value) { event.preventDefault(); openCommand(); } if (event.key === "Enter" && !event.shiftKey && !matchMedia("(pointer: coarse)").matches) { event.preventDefault(); elements.form.requestSubmit(); } });
elements.stop.addEventListener("click", () => state.controller?.abort());
elements.importButton.addEventListener("click", () => elements.documentFile.click());
elements.pptImport.addEventListener("click", () => elements.pptFile.click());
elements.pptSelect.addEventListener("change", () => { if (elements.pptSelect.value) loadPptPresentation(elements.pptSelect.value).catch((error) => showToast(error.message)); });
elements.pptFile.addEventListener("change", async () => {
  const [file] = elements.pptFile.files; if (!file) return; elements.pptImport.disabled = true;
  try {
    let item;
    if (offlineMode) item=await offlineRuntime.ppt.importFile(file);
    else { const form=new FormData();form.append("file",file,file.name);const response=await fetch(apiPath("/api/v1/presentations/import"),{method:"POST",body:form});
      const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||"PPTX 导入失败");item=payload.item; }
    await refreshPresentations(item.id);showToast("PPT 已就绪，原件保留；确认修改后自动保存");
  }catch(error){showToast(error.message);}finally{elements.pptImport.disabled=false;elements.pptFile.value="";}
});
elements.pptImageButton.addEventListener("click", () => { if (!state.ppt.current) return showToast("请先导入 PPTX"); elements.pptImageFile.click(); });
elements.pptImageFile.addEventListener("change", async () => { const [file] = elements.pptImageFile.files; if (!file) return; try { await uploadPptAsset(file); showToast("替换图片已安全上传"); } catch (error) { showToast(error.message); } finally { elements.pptImageFile.value = ""; } });
elements.pptGenerate.addEventListener("click", generatePptPatch);
elements.pptConfirm.addEventListener("click", confirmPptPatch);
elements.pptCancel.addEventListener("click", cancelPptPatch);
elements.pptDownload.addEventListener("click", downloadCurrentPpt);
elements.pptOpen.addEventListener("click", openCurrentPpt);
elements.pptUndo.addEventListener("click", undoPptVersion);
elements.pptModes.forEach((button) => button.addEventListener("click", () => setPptMode(button.dataset.pptMode)));
elements.documentFile.addEventListener("change", async () => {
  const files = Array.from(elements.documentFile.files || []); if (!files.length) return;
  if (files.length > 10) { showToast("一次最多导入 10 份材料，请分批选择"); elements.documentFile.value = ""; return; }
  elements.importButton.disabled = true;
  elements.importFeedback.replaceChildren(); elements.importFeedback.classList.add("hidden");
  const outcomes = []; let importedCount = 0; let duplicateCount = 0; let partialCount = 0;
  try {
    for (const [index, file] of files.entries()) {
      elements.importButton.textContent = "解析中 " + (index + 1) + "/" + files.length;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      try {
        if (offlineMode) {
          const imported = await offlineRuntime.importFile(file);
          if (imported.alreadyImported) { duplicateCount++; outcomes.push({name: file.name, detail: "内容已存在，未重复写入", kind: "duplicate"}); }
          else { importedCount++; if (imported.importWarning) partialCount++; outcomes.push({name: file.name, detail: imported.importWarning || "已建立本地索引", kind: imported.importWarning ? "warning" : "success"}); }
        } else {
          const form = new FormData(); form.append("file", file, file.name);
          const response = await fetch(apiPath("/api/v1/documents/import"), { method: "POST", body: form });
          if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "导入失败，请稍后重试"); }
          importedCount++; outcomes.push({name: file.name, detail: "已建立本地索引", kind: "success"});
        }
      } catch (error) { outcomes.push({name: file.name, detail: error.message, kind: "error"}); }
    }
    await Promise.all([refreshDocuments(), refreshRuntime()]);
    const heading = document.createElement("strong"); heading.textContent = "本次导入结果";
    const list = document.createElement("ul");
    outcomes.forEach(({name, detail, kind}) => { const row = document.createElement("li"); row.className = "import-outcome " + kind; const filename = document.createElement("b"); filename.textContent = name; const message = document.createElement("span"); message.textContent = detail; row.append(filename, message); list.append(row); });
    elements.importFeedback.replaceChildren(heading, list); elements.importFeedback.classList.remove("hidden");
    const status = "已导入 " + importedCount + " 份" + (duplicateCount ? "，跳过重复 " + duplicateCount + " 份" : "") + (partialCount ? "，部分页面需 OCR " + partialCount + " 份" : "");
    const failed = outcomes.filter((entry) => entry.kind === "error").length;
    showToast(failed ? status + "；失败 " + failed + " 份，详见下方结果" : status + "，本地索引已更新");
    if (importedCount) showContextTip("imported-material", "材料已可用于对话。可以尝试“总结材料”或“提取待办”。");
  } catch (error) { showToast(error.message); } finally { elements.documentFile.value = ""; elements.importButton.disabled = false; elements.importButton.textContent = "导入本地材料"; }
});
elements.settingsForm.addEventListener("submit", async (event) => { event.preventDefault(); const form = elements.settingsForm; try { await savePreferences({ displayName: form.elements.displayName.value.trim(), role: form.elements.role.value, writingTone: form.elements.writingTone.value, ragEnabled: form.elements.ragEnabled.checked }); closeSettings(); } catch (error) { showToast(error.message); } });
elements.mobilePairForm.addEventListener("submit", (event) => event.preventDefault());
elements.mobileServerForm.addEventListener("submit", (event) => event.preventDefault());
elements.commandInput.addEventListener("input", () => renderCommandList(elements.commandInput.value));
elements.commandInput.addEventListener("keydown", (event) => { if (event.key === "Escape") closeCommand(); if (event.key === "Enter") elements.commandList.querySelector("button")?.click(); });
document.addEventListener("click", (event) => { const toolButton = event.target.closest("[data-tool]"); if (toolButton) useTool(toolButton.dataset.tool); const conversationButton = event.target.closest("[data-conversation]"); if (conversationButton) loadConversation(conversationButton.dataset.conversation); });
document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); openCommand(); } if (event.key === "Escape") { closeCommand(); closeSettings(); } });
window.addEventListener("beforeunload", stopModelDownloadPolling);

async function initialize() {
  try {
    setSplashStatus("正在检查本地服务");
    registerAppShell();
    const offlineReady = await activateOfflineRuntime().catch(() => false);
    if (!offlineReady) await ensureNativeServerAddress();
    const mobile = await refreshMobileBootstrap();
    await ensureMobilePairing(mobile);
    // Establish the long-lived local profile cookie before concurrent API requests.
    const preferences = await request("/api/v1/preferences");
    await Promise.all([refreshRuntime(), refreshConversations(), refreshDocuments(), refreshMobileBootstrap()]);
    applyProfile(preferences.item); renderTools(); renderDashboard(); renderWelcome(); renderContextActions(); setSplashStatus("本地工作区已准备完成"); completeSplash(); await hideSplash();
    if (!preferences.item.onboardingComplete) openOnboarding(); else switchView(preferences.item.lastView || "home", { persist: false });
  } catch (error) { elements.sidebarStatus.textContent = "离线工作区未就绪"; elements.runtimeBadge.textContent = state.offline ? "离线模式错误" : (isNativeApp() ? "请配置服务地址" : "本地服务不可用"); setSplashStatus(state.offline ? "手机离线模式暂不可用" : (isNativeApp() ? "请设置服务地址" : "本地服务暂不可用")); completeSplash(); await hideSplash(); showToast(error.message); }
}
const experience = createExperience({state, elements, request, showToast, useTool, switchView, openSettings, dismissOnboarding, updateEvidence, focusEvidence});
initialize();
