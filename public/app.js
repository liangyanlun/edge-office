const TOOL_CATALOG = [
  { id: "summary", group: "阅读与总结", title: "总结材料", detail: "提取重点、结论与下一步", status: "ready", prompt: "请总结本地知识库中最相关的材料，按背景、核心要点、结论和下一步整理。", placeholder: "可补充材料范围或关注重点，直接发送则总结相关材料", hint: "系统会检索本地材料并附上引用依据" },
  { id: "compare", group: "阅读与总结", title: "对比材料", detail: "找出两份材料的差异与共识", status: "ready", prompt: "请对比本地知识库中最近的两份材料，列出共同点、差异和需要确认的内容。", placeholder: "可说明要对比的材料或关注维度", hint: "系统会从本地材料中提取共识、差异和待确认项" },
  { id: "quote", group: "阅读与总结", title: "定位原文", detail: "按问题返回可核对的引用", status: "ready", prompt: "请从本地材料中定位与这个问题最相关的原文，并保留引用依据：", placeholder: "输入要查找的问题，例如：项目的核心创新是什么？", hint: "系统会查找相关原文，并显示在“引用依据”中" },
  { id: "email", group: "写作与沟通", title: "撰写邮件", detail: "生成可编辑邮件草稿", status: "draft", prompt: "请创建一封邮件草稿。收件人、主题和正文信息不完整时先向我确认。", placeholder: "说明收件人、主题和想表达的内容", hint: "先生成本地草稿，不会直接发送" },
  { id: "polish", group: "写作与沟通", title: "优化表达", detail: "将已有内容改得更清晰专业", status: "ready", prompt: "请将下面内容改写得清晰、专业、简洁，并保持原意：", placeholder: "粘贴需要优化的文字", hint: "系统会保留原意并改善结构与表达" },
  { id: "outline", group: "写作与沟通", title: "生成汇报提纲", detail: "把材料整理为可讲述的结构", status: "ready", prompt: "请根据本地材料生成一个汇报提纲，包含标题、核心论点和每页建议内容。", placeholder: "可补充汇报对象、时长或重点", hint: "系统会结合本地材料生成可编辑提纲" },
  { id: "minutes", group: "任务与规划", title: "整理会议纪要", detail: "提炼结论、待办和负责人", status: "ready", prompt: "请将以下会议内容整理为会议纪要，分为结论、待办、负责人和时间节点：", placeholder: "粘贴会议记录或补充会议主题", hint: "系统会整理结论、待办、负责人和时间节点" },
  { id: "tasks", group: "任务与规划", title: "提取待办", detail: "从材料或文本识别可执行事项", status: "ready", prompt: "请从本地材料中提取待办事项，按事项、负责人、截止时间和依据列出。", placeholder: "可补充材料范围或直接发送", hint: "系统会提取事项、负责人、截止时间和依据" },
  { id: "calendar", group: "任务与规划", title: "创建日程草稿", detail: "生成待确认的日程安排", status: "draft", prompt: "请创建一个日程草稿。时间、参与人或主题不完整时先向我确认。", placeholder: "说明主题、时间、参与人和地点", hint: "先生成日程草稿，确认后才能执行外部操作" },
  { id: "import", group: "知识库", title: "导入本地材料", detail: "支持文档、表格、演示文稿与网页", status: "ready", prompt: "" },
];

const TOOL_STATUS = { ready: "可直接使用", draft: "草稿后确认" };
const state = { conversationId: null, ragEnabled: true, controller: null, citations: [], profile: null, documents: [], conversations: [], onboardingStep: 0, activeToolId: null, modelDownload: null, modelDownloadTimer: null };
const elements = {
  splash: document.querySelector("#app-splash"), splashStatus: document.querySelector("#splash-status"), onboarding: document.querySelector("#onboarding-layer"), onboardingProgress: document.querySelector("#onboarding-progress"), onboardingForm: document.querySelector("#onboarding-profile-form"),
  nav: document.querySelectorAll(".nav-item"), views: document.querySelectorAll(".view"), viewTitle: document.querySelector("#view-title"), viewEyebrow: document.querySelector("#view-eyebrow"), profileLabel: document.querySelector("#profile-label"), sidebarStatus: document.querySelector("#sidebar-service-status"), runtimeBadge: document.querySelector("#runtime-badge span:last-child"), modelDownloadButton: document.querySelector("#model-download-button"),
  dashboardGreeting: document.querySelector("#dashboard-greeting"), dashboardContext: document.querySelector("#dashboard-context"), workspaceStats: document.querySelector("#workspace-stats"), quickActions: document.querySelector("#quick-actions"), recommendations: document.querySelector("#recommendation-section"), recentConversations: document.querySelector("#recent-conversations"),
  messages: document.querySelector("#messages"), chatPanel: document.querySelector(".chat-panel"), contextActions: document.querySelector("#context-actions"), form: document.querySelector("#chat-form"), input: document.querySelector("#chat-input"), activeToolHint: document.querySelector("#active-tool-hint"), activeToolTitle: document.querySelector("#active-tool-title"), activeToolDetail: document.querySelector("#active-tool-detail"), clearActiveTool: document.querySelector("#clear-active-tool"), ragToggle: document.querySelector("#rag-toggle"), ragLabel: document.querySelector("#rag-label"), stop: document.querySelector("#stop-button"), send: document.querySelector("#send-button"), conversations: document.querySelector("#conversation-list"), newChat: document.querySelector("#new-chat-button"),
  evidence: document.querySelector("#evidence-list"), evidenceCount: document.querySelector("#evidence-count"), ttft: document.querySelector("#metric-ttft"), retrieval: document.querySelector("#metric-retrieval"), speed: document.querySelector("#metric-speed"), memory: document.querySelector("#metric-memory"),
  documentFile: document.querySelector("#document-file"), importButton: document.querySelector("#import-button"), documentList: document.querySelector("#document-list"), knowledgeSummary: document.querySelector("#knowledge-summary"), tools: document.querySelector("#tool-groups"),
  settingsLayer: document.querySelector("#settings-layer"), settingsForm: document.querySelector("#settings-form"), commandLayer: document.querySelector("#command-layer"), commandInput: document.querySelector("#command-input"), commandList: document.querySelector("#command-list"), insightTabs: document.querySelectorAll(".insight-tab"), insightContents: document.querySelectorAll(".insight-content"), contextTip: document.querySelector("#context-tip"), contextTipText: document.querySelector("#context-tip-text"), toast: document.querySelector("#toast"),
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "请求失败，请稍后重试"); }
  return response.json();
}
function showToast(message) { elements.toast.textContent = message; elements.toast.classList.remove("hidden"); window.clearTimeout(showToast.timeout); showToast.timeout = window.setTimeout(() => elements.toast.classList.add("hidden"), 2600); }
function firstName() { return state.profile?.displayName || "你"; }
function setSplashStatus(message) { elements.splashStatus.textContent = message; }
function completeSplash() { window.setTimeout(() => { document.body.classList.remove("booting"); elements.splash.classList.add("leaving"); window.setTimeout(() => elements.splash.remove(), 520); }, 360); }

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
  if (!download?.enabled) { elements.modelDownloadButton.classList.add("hidden"); stopModelDownloadPolling(); return; }
  const downloading = download.state === "downloading";
  const modelUnavailable = model?.status === "llama-cpp-unavailable";
  const shouldShow = downloading || !download.modelInstalled || modelUnavailable || download.state === "failed";
  elements.modelDownloadButton.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) { stopModelDownloadPolling(); return; }
  elements.modelDownloadButton.disabled = downloading;
  if (downloading) {
    const progress = Number.isFinite(Number(download.progressPercent)) ? ` ${Math.floor(Number(download.progressPercent))}%` : "";
    elements.modelDownloadButton.textContent = `${download.phase || "正在下载模型"}${progress}`;
  } else if (download.state === "failed") {
    elements.modelDownloadButton.textContent = "重试下载模型";
  } else {
    elements.modelDownloadButton.textContent = "下载本地模型";
  }
  elements.modelDownloadButton.title = download.error || "从已配置的 GitHub Release 下载并校验本地 GGUF 模型";
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
}
async function startModelDownload() {
  try {
    const payload = await request("/api/v1/model/download", { method: "POST" });
    renderModelDownload(payload.item, null);
    showToast("已开始下载本地模型，完成后会自动安装");
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
    const response = await fetch("/api/v1/chat/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: state.conversationId, message: requestMessage, displayMessage: question, ragEnabled: state.ragEnabled }), signal: state.controller.signal });
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
function switchView(viewName, options = {}) {
  const metadata = { home: ["工作台", "PERSONAL WORKSPACE"], chat: ["智能对话", "LOCAL AGENT"], knowledge: ["知识库", "LOCAL KNOWLEDGE BASE"], tools: ["全部工具", "TASK LIBRARY"] };
  if (!metadata[viewName]) return;
  elements.nav.forEach((button) => button.classList.toggle("active", button.dataset.view === viewName)); elements.views.forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`)); [elements.viewTitle.textContent, elements.viewEyebrow.textContent] = metadata[viewName];
  if (viewName === "knowledge") refreshDocuments(); if (viewName === "home") renderDashboard(); if (viewName === "tools") renderTools();
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
elements.documentFile.addEventListener("change", async () => {
  const [file] = elements.documentFile.files; if (!file) return;
  try { const form = new FormData(); form.append("file", file, file.name); const response = await fetch("/api/v1/documents/import", { method: "POST", body: form }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "导入失败，请稍后重试"); } await Promise.all([refreshDocuments(), refreshRuntime()]); showToast(`已导入 ${file.name}，本地索引已更新`); showContextTip("imported-material", "材料已可用于对话。可以尝试“总结材料”或“提取待办”。"); } catch (error) { showToast(error.message); } finally { elements.documentFile.value = ""; }
});
elements.settingsForm.addEventListener("submit", async (event) => { event.preventDefault(); const form = elements.settingsForm; try { await savePreferences({ displayName: form.elements.displayName.value.trim(), role: form.elements.role.value, writingTone: form.elements.writingTone.value, ragEnabled: form.elements.ragEnabled.checked }); closeSettings(); } catch (error) { showToast(error.message); } });
elements.commandInput.addEventListener("input", () => renderCommandList(elements.commandInput.value));
elements.commandInput.addEventListener("keydown", (event) => { if (event.key === "Escape") closeCommand(); if (event.key === "Enter") elements.commandList.querySelector("button")?.click(); });
document.addEventListener("click", (event) => { const toolButton = event.target.closest("[data-tool]"); if (toolButton) useTool(toolButton.dataset.tool); const conversationButton = event.target.closest("[data-conversation]"); if (conversationButton) loadConversation(conversationButton.dataset.conversation); });
document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); openCommand(); } if (event.key === "Escape") { closeCommand(); closeSettings(); } });
window.addEventListener("beforeunload", stopModelDownloadPolling);

async function initialize() {
  try {
    setSplashStatus("正在检查本地服务");
    // Establish the long-lived local profile cookie before concurrent API requests.
    const preferences = await request("/api/v1/preferences");
    await Promise.all([refreshRuntime(), refreshConversations(), refreshDocuments()]);
    applyProfile(preferences.item); renderTools(); renderDashboard(); renderWelcome(); renderContextActions(); setSplashStatus("本地工作区已准备完成"); completeSplash();
    if (!preferences.item.onboardingComplete) openOnboarding(); else switchView(preferences.item.lastView || "home", { persist: false });
  } catch (error) { elements.sidebarStatus.textContent = "服务连接失败"; elements.runtimeBadge.textContent = "本地服务不可用"; setSplashStatus("本地服务暂不可用"); completeSplash(); showToast(error.message); }
}
initialize();
