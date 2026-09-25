import { hideSplash, isNativeApp, shareFile } from "./native-bridge.js";

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

const TOOL_STATUS = { ready: "可直接使用", draft: "草稿后确认" };
const state = { conversationId: null, ragEnabled: true, controller: null, citations: [], profile: null, documents: [], conversations: [], onboardingStep: 0, activeToolId: null, modelDownload: null, modelDownloadTimer: null, modelCatalogTimer: null, models: [], mobile: null, ppt: { presentations: [], current: null, versionId: null, slides: [], slideId: null, asset: null, patch: null, publishedVersionId: null, undoVersionId: null, mode: "before" } };
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
  documentFile: document.querySelector("#document-file"), importButton: document.querySelector("#import-button"), documentList: document.querySelector("#document-list"), knowledgeSummary: document.querySelector("#knowledge-summary"), tools: document.querySelector("#tool-groups"),
  pptFile: document.querySelector("#ppt-file"), pptImport: document.querySelector("#ppt-import-button"), pptSelect: document.querySelector("#ppt-presentation-select"), pptWarning: document.querySelector("#ppt-model-warning"), pptEmpty: document.querySelector("#ppt-empty"), pptWorkspace: document.querySelector("#ppt-workspace"), pptSlideCount: document.querySelector("#ppt-slide-count"), pptSlideList: document.querySelector("#ppt-slide-list"), pptVersionLabel: document.querySelector("#ppt-version-label"), pptBefore: document.querySelector("#ppt-before-image"), pptAfter: document.querySelector("#ppt-after-image"), pptPreviewStatus: document.querySelector("#ppt-preview-status"), pptStage: document.querySelector("#ppt-preview-stage"), pptInstruction: document.querySelector("#ppt-instruction"), pptImageFile: document.querySelector("#ppt-image-file"), pptImageButton: document.querySelector("#ppt-image-button"), pptAssetLabel: document.querySelector("#ppt-asset-label"), pptGenerate: document.querySelector("#ppt-generate-button"), pptPlanCard: document.querySelector("#ppt-plan-card"), pptPlanTitle: document.querySelector("#ppt-plan-title"), pptPlanStatus: document.querySelector("#ppt-plan-status"), pptPlanSlide: document.querySelector("#ppt-plan-slide"), pptPlanCount: document.querySelector("#ppt-plan-count"), pptPlanVersion: document.querySelector("#ppt-plan-version"), pptPlanHash: document.querySelector("#ppt-plan-hash"), pptOperations: document.querySelector("#ppt-operation-list"), pptVerification: document.querySelector("#ppt-verification-note"), pptConfirm: document.querySelector("#ppt-confirm-button"), pptCancel: document.querySelector("#ppt-cancel-button"), pptComplete: document.querySelector("#ppt-complete-card"), pptDownload: document.querySelector("#ppt-download-button"), pptOpen: document.querySelector("#ppt-open-button"), pptUndo: document.querySelector("#ppt-undo-button"), pptVersionList: document.querySelector("#ppt-version-list"), pptModes: document.querySelectorAll(".ppt-view-mode"),
  settingsLayer: document.querySelector("#settings-layer"), settingsForm: document.querySelector("#settings-form"), commandLayer: document.querySelector("#command-layer"), commandInput: document.querySelector("#command-input"), commandList: document.querySelector("#command-list"), insightTabs: document.querySelectorAll(".insight-tab"), insightContents: document.querySelectorAll(".insight-content"), contextTip: document.querySelector("#context-tip"), contextTipText: document.querySelector("#context-tip-text"), toast: document.querySelector("#toast"), mobileModeBadge: document.querySelector("#mobile-mode-badge"), mobilePairLayer: document.querySelector("#mobile-pair-layer"), mobilePairForm: document.querySelector("#mobile-pair-form"), mobileServerLayer: document.querySelector("#mobile-server-layer"), mobileServerForm: document.querySelector("#mobile-server-form"),
};

async function request(path, options = {}) {
  const response = await fetch(apiPath(path), options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "请求失败，请稍后重试"); }
  return response.json();
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
  state.onboardingStep = Math.max(0, Math.min(3, step));
  document.querySelectorAll(".onboarding-step").forEach((item) => item.classList.toggle("active", Number(item.dataset.onboardingStep) === state.onboardingStep));
  elements.onboardingProgress.style.width = `${(state.onboardingStep + 1) * 25}%`;
  document.querySelector("#onboarding-step-label").textContent = `第 ${state.onboardingStep + 1} / 4 步`;
}
function openOnboarding(step = 0) { populateProfileForm(elements.onboardingForm, state.profile); showOnboardingStep(step); elements.onboarding.classList.remove("hidden"); }
function closeOnboarding() { elements.onboarding.classList.add("hidden"); }
async function finishOnboarding(firstTask = "home") {
  const form = elements.onboardingForm;
  const profile = await savePreferences({ displayName: form.elements.displayName.value.trim(), role: form.elements.role.value, writingTone: form.elements.writingTone.value, ragEnabled: form.elements.ragEnabled.checked, onboardingComplete: true, lastView: firstTask === "import" ? "knowledge" : (firstTask === "home" ? "home" : "chat") }, { quiet: true });
  applyProfile(profile); closeOnboarding();
  if (firstTask === "import") { switchView("knowledge", { persist: false }); window.setTimeout(() => elements.importButton.click(), 220); }
  else if (firstTask === "home") switchView("home", { persist: false });
  else { switchView("chat", { persist: false }); if (firstTask !== "chat") useTool(firstTask); else elements.input.focus(); }
}

function toolById(id) { return TOOL_CATALOG.find((tool) => tool.id === id); }
function toolPrompt(tool) {
  if (tool.id === "summary" && !state.documents.length) return "请先导入一份材料，再为你生成有依据的摘要。";
  if (tool.id === "compare" && state.documents.length < 2) return "请先导入至少两份材料，再进行对比。";
  return tool.prompt;
}
function clearActiveTool() {
  state.activeToolId = null;
  elements.activeToolHint.classList.add("hidden");
  elements.input.placeholder = "输入你的问题";
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
  if ((tool.id === "summary" && !state.documents.length) || (tool.id === "compare" && state.documents.length < 2)) { switchView("knowledge"); showToast(toolPrompt(tool)); return; }
  switchView("chat"); setActiveTool(tool); elements.input.focus();
}
function renderToolButton(tool, compact = false) {
  const button = document.createElement("button"); button.type = "button"; button.className = compact ? "quick-task" : "tool-card"; button.dataset.tool = tool.id;
  const title = document.createElement("strong"); title.textContent = tool.title; const detail = document.createElement("span"); detail.textContent = tool.detail; const status = document.createElement("small"); status.textContent = TOOL_STATUS[tool.status]; button.append(title, detail, status); return button;
}
function renderTools() {
  elements.tools.replaceChildren(); [...new Set(TOOL_CATALOG.map((tool) => tool.group))].forEach((group) => { const section = document.createElement("section"); section.className = "tool-group"; const heading = document.createElement("h3"); heading.textContent = group; const grid = document.createElement("div"); grid.className = "tool-grid"; TOOL_CATALOG.filter((tool) => tool.group === group).forEach((tool) => grid.append(renderToolButton(tool))); section.append(heading, grid); elements.tools.append(section); });
}

function renderDashboard() {
  const documentCount = state.documents.length;
  const userDocuments = state.documents.filter((item) => !item.builtin).length;
  elements.workspaceStats.replaceChildren();
  [["知识库", `${documentCount} 份`, userDocuments ? `${userDocuments} 份由你导入` : "等待导入材料"], ["对话", `${state.conversations.length} 个`, state.conversations.length ? "可继续上次上下文" : "尚未开始对话"], ["默认模式", state.ragEnabled ? "知识增强" : "直接推理", state.ragEnabled ? "回答将携带依据" : "本轮不检索材料"]].forEach(([label, value, note]) => {
    const item = document.createElement("article"); item.className = "workspace-stat"; item.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${note}</small>`; elements.workspaceStats.append(item);
  });
  elements.quickActions.replaceChildren(); ["summary", "email", "tasks", "minutes"].map(toolById).forEach((tool) => elements.quickActions.append(renderToolButton(tool, true)));
  elements.recommendations.replaceChildren();
  const recommendation = document.createElement("div"); recommendation.className = "recommendation";
  const copy = document.createElement("div"); const kicker = document.createElement("p"); kicker.className = "section-kicker"; kicker.textContent = "下一步建议"; const title = document.createElement("h2"); const text = document.createElement("p"); const action = document.createElement("button"); action.className = "primary-button"; action.type = "button";
  if (!userDocuments) { title.textContent = "先放入一份正在处理的材料"; text.textContent = "导入后可以直接提问、总结、提取待办，回答会显示对应引用。"; action.textContent = "导入材料"; action.dataset.tool = "import"; }
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
  if (model.active) return "当前使用";
  if (model.downloadState === "downloading") return "正在下载";
  if (model.installed) return model.verified ? "已下载 · 待启用" : "已下载 · 待校验";
  if (model.status === "development") return "开发中";
  return "可下载";
}

function renderModelCatalog(models = []) {
  state.models = Array.isArray(models) ? models : [];
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
    const message = document.createElement("p"); message.className = "model-card-message"; message.textContent = model.message || "";
    const meta = document.createElement("small"); meta.className = "model-card-meta"; meta.textContent = `Release ${model.releaseTag} · 保存到 ${model.modelDirectory || "本机应用数据目录"}`;
    const actions = document.createElement("div"); actions.className = "model-card-actions";
    const download = document.createElement("button"); download.type = "button"; download.className = "primary-button"; download.dataset.modelDownload = model.id;
    if (model.downloadState === "downloading") { const progress = Number.isFinite(Number(model.download?.progressPercent)) ? ` ${Math.floor(Number(model.download.progressPercent))}%` : ""; download.textContent = `正在下载${progress}`; download.disabled = true; }
    else if (model.downloadAvailable && !model.installed) download.textContent = model.id === "qwen3.5-4b-office" ? "下载 4B 模型" : "下载模型";
    else if (model.installed) { download.textContent = model.active ? "当前使用中" : "已下载，待启用"; download.disabled = true; }
    else { download.textContent = "模型开发中"; download.disabled = true; }
    actions.append(download);
    const release = document.createElement("a"); release.className = "ghost-button model-release-link"; release.href = model.releaseUrl; release.target = "_blank"; release.rel = "noreferrer"; release.textContent = model.status === "development" ? "查看开发说明" : "查看 Release"; actions.append(release);
    card.append(head, message, meta, actions); elements.modelGrid.append(card);
  });
  if (downloading && !state.modelCatalogTimer) state.modelCatalogTimer = window.setInterval(() => refreshRuntime().catch(() => {}), 900);
  if (!downloading) stopModelCatalogPolling();
}

async function startModelProfileDownload(modelId) {
  const model = state.models.find((item) => item.id === modelId);
  if (!model) return;
  if (!model.downloadAvailable) { showToast(model.message || "该模型暂未开放下载"); return; }
  try {
    const payload = await request(`/api/v1/models/${encodeURIComponent(modelId)}/download`, { method: "POST" });
    showToast(`已开始下载 ${model.name}，将保存到本机模型目录`);
    renderModelCatalog(state.models.map((item) => item.id === modelId ? { ...item, downloadState: payload.item.state, download: payload.item } : item));
  } catch (error) { showToast(error.message); }
}

function renderWelcome() {
  elements.messages.replaceChildren(); const wrap = document.createElement("div"); wrap.className = "welcome-card";
  const label = document.createElement("p"); label.className = "section-kicker"; label.textContent = state.documents.length ? "本地知识增强已准备" : "从一个任务开始";
  const title = document.createElement("h2"); title.textContent = state.documents.length ? "问材料、写内容、整理下一步" : "先导入材料，或直接开始一项工作";
  const text = document.createElement("p"); text.textContent = state.documents.length ? "回答会优先使用本机知识库，并在“引用依据”中显示可核对的来源。" : "你可以先撰写邮件草稿、整理会议纪要，或导入一份资料建立知识库。";
  const actions = document.createElement("div"); actions.className = "suggestion-grid"; (state.documents.length ? ["summary", "tasks", "outline"] : ["import", "email", "minutes"]).map(toolById).forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.className = "suggestion"; button.dataset.tool = tool.id; button.textContent = tool.title; actions.append(button); });
  wrap.append(label, title, text, actions); elements.messages.append(wrap);
}
function renderContextActions() { elements.contextActions.replaceChildren(); (state.documents.length ? ["summary", "tasks", "quote"] : ["import", "email", "minutes"]).map(toolById).forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.dataset.tool = tool.id; button.textContent = tool.title; elements.contextActions.append(button); }); }
function renderTextWithCitations(container, text) { container.replaceChildren(); String(text ?? "").split(/(【\d+】)/g).forEach((part) => { const match = part.match(/^【(\d+)】$/); if (match) { const button = document.createElement("button"); button.className = "citation-link"; button.type = "button"; button.textContent = part; button.addEventListener("click", () => focusEvidence(Number(match[1]) - 1)); container.append(button); } else container.append(document.createTextNode(part)); }); }
function addMessage(role, content = "", options = {}) {
  document.querySelector(".welcome-card")?.remove(); const item = document.createElement("article"); item.className = `message ${role}`; const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = role === "assistant" ? "微" : firstName().slice(0, 1); const card = document.createElement("div"); card.className = "message-card"; const body = document.createElement("div"); body.className = "message-content"; if (role === "assistant") renderTextWithCitations(body, content); else body.textContent = content; const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = options.meta || (role === "assistant" ? "本地 Agent" : "刚刚"); card.append(body, meta); item.append(avatar, card); elements.messages.append(item); elements.messages.scrollTop = elements.messages.scrollHeight; return { item, body, meta };
}
function addPlanCard(plan, onCompleted) {
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
function updateMetrics(metrics) { elements.ttft.textContent = formatDuration(metrics.responseLatencyMs ?? metrics.ttftMs); elements.retrieval.textContent = metrics.retrievalMs == null ? (metrics.ragEnabled === false ? "未启用" : "—") : formatDuration(metrics.retrievalMs); elements.speed.textContent = Number.isFinite(Number(metrics.tokensPerSecond)) ? `${Number(metrics.tokensPerSecond).toFixed(1)} tok/s` : "—"; elements.memory.textContent = Number.isFinite(Number(metrics.peakRssMb)) ? `${Number(metrics.peakRssMb).toFixed(1)} MB` : "—"; }
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
  if (!download?.enabled) { elements.modelDownloadControl.classList.add("hidden"); stopModelDownloadPolling(); return; }
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
    elements.modelDownloadButton.textContent = "下载本地模型";
  }
  elements.modelDownloadButton.title = download.error || `下载并校验本地 GGUF 模型，保存到：${location}`;
  if (downloading && !state.modelDownloadTimer) {
    state.modelDownloadTimer = window.setInterval(() => refreshRuntime().catch(() => {}), 900);
  }
  if (!downloading) stopModelDownloadPolling();
}
async function refreshRuntime() {
  const [health, runtime] = await Promise.all([request("/api/v1/health"), request("/api/v1/runtime/status")]);
  elements.sidebarStatus.textContent = health.status === "ok" ? "服务正常 · 本机运行" : "服务异常";
  elements.runtimeBadge.textContent = `${runtime.model.name} · ${runtime.resources.rssMb} MB`;
  renderModelDownload(runtime.modelDownload, runtime.model);
  renderModelCatalog(runtime.models || []);
}
async function startModelDownload() {
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
  const payload = await request(`/api/v1/conversations/${encodeURIComponent(id)}`); state.conversationId = payload.item.id; elements.messages.replaceChildren(); payload.item.messages.forEach((message) => addMessage(message.role, message.content, { meta: message.role === "assistant" ? "历史回答" : "历史提问" })); const lastAssistant = [...payload.item.messages].reverse().find((item) => item.role === "assistant"); updateEvidence(lastAssistant?.citations || []); if (lastAssistant?.metrics) updateMetrics(lastAssistant.metrics); else resetMetrics(); switchView("chat"); refreshConversations();
}
function newChat() { state.conversationId = null; state.citations = []; clearActiveTool(); renderWelcome(); renderContextActions(); updateEvidence([]); resetMetrics(); refreshConversations(); elements.input.focus(); }
function parseSseChunk(buffer, onEvent) {
  const blocks = buffer.split("\n\n"); const remainder = blocks.pop();
  for (const block of blocks) { const event = block.match(/^event:\s*(.+)$/m)?.[1] || "message"; const raw = block.match(/^data:\s*(.+)$/m)?.[1]; if (!raw) continue; try { onEvent(event, JSON.parse(raw)); } catch { /* Ignore incomplete protocol chunks. */ } }
  return remainder;
}
async function sendMessage(question, requestMessage = question) {
  addMessage("user", question); const assistant = addMessage("assistant", "", { meta: "准备中" }); assistant.body.classList.add("typing"); assistant.body.textContent = "正在规划本地任务"; updateEvidence([]); resetMetrics(); setGenerating(true); state.controller = new AbortController(); let answer = "";
  try {
    const response = await fetch(apiPath("/api/v1/chat/stream"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: state.conversationId, message: requestMessage, displayMessage: question, ragEnabled: state.ragEnabled }), signal: state.controller.signal });
    if (!response.ok || !response.body) throw new Error("无法建立流式回答连接");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let buffer = "";
    const handleEvent = (event, data) => {
      if (event === "meta") { state.conversationId = data.conversationId; assistant.meta.textContent = data.ragEnabled ? `${data.model} · 知识增强` : `${data.model} · 直接推理`; }
      if (event === "stage") { assistant.body.classList.add("typing"); assistant.body.textContent = data.label; assistant.meta.textContent = "处理中"; }
      if (event === "plan") addPlanCard(data, (result) => { if (result.citations?.length) updateEvidence(result.citations); assistant.body.classList.remove("typing"); assistant.body.textContent = result.answer || "本地沙箱操作已完成。"; assistant.meta.textContent = "本地 Agent · 已完成"; });
      if (event === "citations") updateEvidence(data.items || []);
      if (event === "token") { if (!answer) { assistant.body.classList.remove("typing"); assistant.body.textContent = ""; } answer += data.text; renderTextWithCitations(assistant.body, answer); assistant.body.classList.add("streaming"); assistant.meta.textContent = "本地 Agent · 流式输出"; elements.messages.scrollTop = elements.messages.scrollHeight; }
      if (event === "metrics") updateMetrics(data);
      if (event === "done") { assistant.body.classList.remove("streaming"); assistant.meta.textContent = "本地 Agent · 已完成"; }
      if (event === "error") throw new Error(data.message || "生成失败");
    };
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer = parseSseChunk(buffer + value, handleEvent); }
    if (buffer.trim()) parseSseChunk(`${buffer}\n\n`, handleEvent);
    await Promise.all([refreshConversations(), refreshRuntime()]);
  } catch (error) {
    assistant.body.classList.remove("typing", "streaming");
    if (error.name === "AbortError") { if (!answer) assistant.body.textContent = "已停止生成。"; assistant.meta.textContent = "已停止"; }
    else { assistant.body.textContent = `发生错误：${error.message}`; assistant.meta.textContent = "生成失败"; showToast(error.message); }
  } finally { setGenerating(false); state.controller = null; }
}

async function refreshDocuments() {
  const payload = await request("/api/v1/documents"); state.documents = payload.items; const imported = payload.items.filter((item) => !item.builtin).length;
  elements.knowledgeSummary.replaceChildren(); [`${payload.items.length} 份材料`, `${imported} 份用户导入`, "导入后即时参与检索"].forEach((text) => { const tag = document.createElement("span"); tag.className = "summary-chip"; tag.textContent = text; elements.knowledgeSummary.append(tag); });
  elements.documentList.replaceChildren();
  payload.items.forEach((item) => {
    const card = document.createElement("article"); card.className = "document-card"; const main = document.createElement("div"); main.className = "document-main"; const icon = document.createElement("div"); icon.className = "document-icon"; icon.textContent = item.builtin ? "内" : (item.name.split(".").pop() || "文").slice(0, 4).toUpperCase(); const info = document.createElement("div"); const title = document.createElement("strong"); title.textContent = item.name; const detail = document.createElement("span"); const quality = item.extractionQuality === "ocr-reviewed" ? "OCR 已识别" : item.extractionQuality === "ocr-low-confidence" ? "OCR 待复核" : "原生文本"; detail.textContent = `${item.source} · ${item.characters} 字符 · ${item.locator} · ${quality}`; info.append(title, detail); main.append(icon, info);
    const actions = document.createElement("div"); actions.className = "document-actions"; const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = item.builtin ? "内置" : (item.extractionQuality === "ocr-low-confidence" ? "需复核" : "已导入"); actions.append(tag);
    if (!item.builtin) { const remove = document.createElement("button"); remove.className = "delete-button"; remove.type = "button"; remove.textContent = "移除"; remove.addEventListener("click", async () => { await request(`/api/v1/documents/${encodeURIComponent(item.id)}`, { method: "DELETE" }); await Promise.all([refreshDocuments(), refreshRuntime()]); showToast("材料已移除，本地索引已更新"); }); actions.append(remove); }
    card.append(main, actions); elements.documentList.append(card);
  });
  renderDashboard(); renderWelcome(); renderContextActions();
}

function pptPreviewUrl(presentationId, versionId, slideId) {
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
  const [detail, slides] = await Promise.all([request(`/api/v1/presentations/${encodeURIComponent(id)}`), request(`/api/v1/presentations/${encodeURIComponent(id)}/slides`)]);
  state.ppt.current = detail.item; state.ppt.versionId = slides.versionId; state.ppt.slides = slides.items || []; state.ppt.slideId = state.ppt.slides[0]?.slideId || null; state.ppt.patch = null; state.ppt.publishedVersionId = null;
  renderPptCapability(detail.item.modelCapability); elements.pptEmpty.classList.add("hidden"); elements.pptWorkspace.classList.remove("hidden"); elements.pptVersionLabel.textContent = shortId(state.ppt.versionId); elements.pptSlideCount.textContent = String(state.ppt.slides.length); elements.pptPlanCard.classList.add("hidden"); elements.pptComplete.classList.add("hidden");
  renderPptSlides(); renderPptVersions(); if (state.ppt.slideId) selectPptSlide(state.ppt.slideId);
}
function renderPptSlides() {
  elements.pptSlideList.replaceChildren();
  state.ppt.slides.forEach((slide) => { const button = document.createElement("button"); button.type = "button"; button.className = `ppt-slide-thumb ${slide.slideId === state.ppt.slideId ? "active" : ""}`; button.dataset.slideId = slide.slideId; const image = document.createElement("img"); image.alt = `第 ${slide.slideNumber} 页`; image.src = pptPreviewUrl(state.ppt.current.id, state.ppt.versionId, slide.slideId); const label = document.createElement("span"); label.textContent = `${slide.slideNumber}`; button.append(image, label); button.addEventListener("click", () => selectPptSlide(slide.slideId)); elements.pptSlideList.append(button); });
}
function selectPptSlide(slideId) {
  state.ppt.slideId = slideId; state.ppt.mode = "before"; elements.pptSlideList.querySelectorAll(".ppt-slide-thumb").forEach((button) => button.classList.toggle("active", button.dataset.slideId === slideId)); elements.pptBefore.src = pptPreviewUrl(state.ppt.current.id, state.ppt.versionId, slideId); elements.pptAfter.removeAttribute("src"); elements.pptPreviewStatus.textContent = `${slideId.replace("slide-", "第 ")} 页 · ${shortId(state.ppt.versionId)}`; setPptMode("before");
}
function setPptMode(mode) {
  state.ppt.mode = mode; elements.pptModes.forEach((button) => button.classList.toggle("active", button.dataset.pptMode === mode)); elements.pptStage.classList.toggle("compare", mode === "compare"); elements.pptStage.querySelector(".before").classList.toggle("hidden", mode === "after"); elements.pptStage.querySelector(".after").classList.toggle("hidden", mode === "before");
}
function renderPptVersions() {
  elements.pptVersionList.replaceChildren();
  (state.ppt.current?.versions || []).forEach((version) => { const row = document.createElement("div"); row.className = `ppt-version-item ${version.id === state.ppt.current.currentVersionId ? "current" : ""}`; const copy = document.createElement("span"); copy.innerHTML = `<strong>${version.sourceKind === "import" ? "原始导入" : version.sourceKind === "restore" ? "恢复版本" : "编辑版本"}</strong><small>${shortId(version.id)}</small>`; const link = document.createElement("a"); link.href = apiPath(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/versions/${encodeURIComponent(version.id)}/download`); link.textContent = "下载"; row.append(copy, link); elements.pptVersionList.append(row); });
}
async function uploadPptAsset(file) {
  const form = new FormData(); form.append("file", file, file.name); const response = await fetch(apiPath(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/assets`), { method: "POST", body: form }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "图片上传失败"); } const payload = await response.json(); state.ppt.asset = payload.item; elements.pptAssetLabel.textContent = `${payload.item.name} · 已隔离为 ${payload.item.uri}`; return payload.item;
}
async function generatePptPatch() {
  if (!state.ppt.current || !state.ppt.slideId) return showToast("请先导入并选择一页 PPT");
  const instruction = elements.pptInstruction.value.trim(); if (!instruction) return showToast("请输入修改要求");
  elements.pptGenerate.disabled = true; elements.pptGenerate.textContent = "正在生成并验证预览"; elements.pptComplete.classList.add("hidden");
  try {
    const created = await request(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/patches`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: state.ppt.versionId, slideId: state.ppt.slideId, instruction }) });
    const simulated = await request(`/api/v1/ppt-patches/${encodeURIComponent(created.item.id)}/simulate`, { method: "POST" }); state.ppt.patch = simulated.item; renderPptPatch(simulated.item); elements.pptAfter.src = apiPath(`/api/v1/ppt-patches/${encodeURIComponent(simulated.item.id)}/slides/${encodeURIComponent(state.ppt.slideId)}/preview?t=${Date.now()}`); setPptMode("compare"); showToast("修改预览已生成，请核对后确认");
  } catch (error) { showToast(error.message); }
  finally { elements.pptGenerate.disabled = false; elements.pptGenerate.textContent = "生成修改计划与预览"; }
}
function renderPptPatch(patch) {
  elements.pptPlanCard.classList.remove("hidden"); elements.pptPlanTitle.textContent = patch.model || "PPT 专用计划器"; elements.pptPlanStatus.textContent = patch.status === "PREVIEW_READY" ? "已验证" : patch.status; elements.pptPlanSlide.textContent = patch.slideId; elements.pptPlanCount.textContent = `${patch.operations.length} 项`; elements.pptPlanVersion.textContent = shortId(patch.baseVersion); elements.pptPlanHash.textContent = patch.patchHash.slice(0, 12); elements.pptOperations.replaceChildren(); patch.operations.forEach((operation) => { const item = document.createElement("li"); item.textContent = describePptOperation(operation); elements.pptOperations.append(item); }); const verification = patch.verification || {}; elements.pptVerification.textContent = verification.ok ? `已重新打开文件并验证；${verification.nonTargetSlidesVerified || 0} 张非目标页未改变。预览方式：${verification.render?.mode || "本地渲染"}${verification.render?.approximate ? "（近似布局）" : ""}。` : "尚未完成验证"; elements.pptConfirm.disabled = !patch.previewReady;
}
function describePptOperation(item) { const labels = { replace_paragraph: "替换段落", clone_paragraph: "克隆段落", del_paragraph: "删除段落", replace_image: "替换图片", del_image: "删除图片" }; const target = item.div_id != null ? `文本框 ${item.div_id} / 段落 ${item.paragraph_id}` : `图片 ${item.image_id}`; return `${labels[item.operation] || item.operation} · ${target}`; }
async function confirmPptPatch() {
  if (!state.ppt.patch) return; elements.pptConfirm.disabled = true;
  try { const previousVersion = state.ppt.patch.baseVersion; const presentationId = state.ppt.current.id; const result = await request(`/api/v1/ppt-patches/${encodeURIComponent(state.ppt.patch.id)}/confirm`, { method: "POST" }); await refreshPresentations(presentationId); state.ppt.publishedVersionId = result.version.id; state.ppt.undoVersionId = previousVersion; state.ppt.patch = result.patch; elements.pptPlanCard.classList.add("hidden"); elements.pptComplete.classList.remove("hidden"); showToast("已发布为新版本，原文件未被覆盖"); } catch (error) { showToast(error.message); } finally { elements.pptConfirm.disabled = false; }
}
async function cancelPptPatch() { if (!state.ppt.patch) return; try { await request(`/api/v1/ppt-patches/${encodeURIComponent(state.ppt.patch.id)}/cancel`, { method: "POST" }); state.ppt.patch = null; elements.pptPlanCard.classList.add("hidden"); setPptMode("before"); showToast("修改计划已取消"); } catch (error) { showToast(error.message); } }
function currentPptDownloadUrl(versionId = state.ppt.publishedVersionId || state.ppt.versionId) { return apiPath(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/versions/${encodeURIComponent(versionId)}/download`); }
async function downloadCurrentPpt() {
  const url = currentPptDownloadUrl();
  if (isNativeApp()) {
    try { if (await shareFile(url, "微知 Edge Office PPT")) return; } catch (error) { showToast(error.message || "系统分享不可用"); }
  }
  const link = document.createElement("a"); link.href = url; link.click();
}
function openCurrentPpt() { const url = currentPptDownloadUrl(); const absolute = /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).href; window.location.href = `ms-powerpoint:ofe|u|${absolute}`; window.setTimeout(() => showToast("若 PowerPoint 未打开，请使用“下载”后双击文件"), 800); }
async function undoPptVersion() { const baseVersion = state.ppt.undoVersionId || state.ppt.patch?.baseVersion || state.ppt.current?.versions?.[1]?.id; if (!baseVersion) return showToast("没有可恢复的上一版本"); try { await request(`/api/v1/presentations/${encodeURIComponent(state.ppt.current.id)}/versions/${encodeURIComponent(baseVersion)}/restore`, { method: "POST" }); await refreshPresentations(state.ppt.current.id); state.ppt.undoVersionId = null; elements.pptComplete.classList.add("hidden"); showToast("已将旧版本复制为新的当前版本"); } catch (error) { showToast(error.message); } }
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
  const normalized = query.trim().toLowerCase(); const items = TOOL_CATALOG.filter((tool) => !normalized || `${tool.title} ${tool.detail} ${tool.group}`.toLowerCase().includes(normalized)); elements.commandList.replaceChildren();
  if (!items.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "没有匹配的任务"; elements.commandList.append(empty); return; }
  items.forEach((tool) => { const button = document.createElement("button"); button.type = "button"; button.dataset.tool = tool.id; const content = document.createElement("span"); const title = document.createElement("strong"); title.textContent = tool.title; const detail = document.createElement("small"); detail.textContent = `${tool.group} · ${tool.detail}`; content.append(title, detail); const status = document.createElement("em"); status.textContent = TOOL_STATUS[tool.status]; button.append(content, status); elements.commandList.append(button); });
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
elements.modelGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-model-download]");
  if (button && !button.disabled) startModelProfileDownload(button.dataset.modelDownload);
});
elements.newChat.addEventListener("click", newChat);
elements.insightTabs.forEach((button) => button.addEventListener("click", () => switchInsight(button.dataset.insight)));
elements.ragToggle.addEventListener("change", () => { state.ragEnabled = elements.ragToggle.checked; elements.ragLabel.textContent = state.ragEnabled ? "已启用" : "已关闭"; document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库"; savePreferences({ ragEnabled: state.ragEnabled }, { quiet: true }).catch(() => {}); renderDashboard(); });
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const userInput = elements.input.value.trim();
  const tool = toolById(state.activeToolId);
  if ((!userInput && !tool) || state.controller) return;
  const displayMessage = userInput || tool.title;
  const requestMessage = tool ? composeToolRequest(tool, userInput) : userInput;
  elements.input.value = "";
  clearActiveTool();
  autoResizeComposer();
  sendMessage(displayMessage, requestMessage);
});
elements.input.addEventListener("input", autoResizeComposer);
elements.input.addEventListener("keydown", (event) => { if (event.key === "/" && !elements.input.value) { event.preventDefault(); openCommand(); } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); elements.form.requestSubmit(); } });
elements.stop.addEventListener("click", () => state.controller?.abort());
elements.importButton.addEventListener("click", () => elements.documentFile.click());
elements.pptImport.addEventListener("click", () => elements.pptFile.click());
elements.pptSelect.addEventListener("change", () => { if (elements.pptSelect.value) loadPptPresentation(elements.pptSelect.value).catch((error) => showToast(error.message)); });
elements.pptFile.addEventListener("change", async () => { const [file] = elements.pptFile.files; if (!file) return; elements.pptImport.disabled = true; try { const form = new FormData(); form.append("file", file, file.name); const response = await fetch(apiPath("/api/v1/presentations/import"), { method: "POST", body: form }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "PPTX 导入失败"); } const payload = await response.json(); await refreshPresentations(payload.item.id); showToast("PPTX 已保存为只读原件，并建立首个版本"); } catch (error) { showToast(error.message); } finally { elements.pptImport.disabled = false; elements.pptFile.value = ""; } });
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
  const [file] = elements.documentFile.files; if (!file) return;
  try { const form = new FormData(); form.append("file", file, file.name); const response = await fetch(apiPath("/api/v1/documents/import"), { method: "POST", body: form }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "导入失败，请稍后重试"); } await Promise.all([refreshDocuments(), refreshRuntime()]); showToast(`已导入 ${file.name}，本地索引已更新`); showContextTip("imported-material", "材料已可用于对话。可以尝试“总结材料”或“提取待办”。"); } catch (error) { showToast(error.message); } finally { elements.documentFile.value = ""; }
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
    await ensureNativeServerAddress();
    const mobile = await refreshMobileBootstrap();
    await ensureMobilePairing(mobile);
    // Establish the long-lived local profile cookie before concurrent API requests.
    const preferences = await request("/api/v1/preferences");
    await Promise.all([refreshRuntime(), refreshConversations(), refreshDocuments(), refreshMobileBootstrap()]);
    applyProfile(preferences.item); renderTools(); renderDashboard(); renderWelcome(); renderContextActions(); setSplashStatus("本地工作区已准备完成"); completeSplash(); await hideSplash();
    if (!preferences.item.onboardingComplete) openOnboarding(); else switchView(preferences.item.lastView || "home", { persist: false });
  } catch (error) { elements.sidebarStatus.textContent = "服务连接失败"; elements.runtimeBadge.textContent = isNativeApp() ? "请配置后端地址" : "本地服务不可用"; setSplashStatus(isNativeApp() ? "请设置 EDGE_OFFICE_SERVER_URL" : "本地服务暂不可用"); completeSplash(); await hideSplash(); showToast(error.message); }
}
initialize();
