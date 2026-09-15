const state = {
  conversationId: null,
  ragEnabled: true,
  controller: null,
  citations: []
};

const elements = {
  nav: document.querySelectorAll(".nav-item"),
  views: document.querySelectorAll(".view"),
  viewTitle: document.querySelector("#view-title"),
  viewEyebrow: document.querySelector("#view-eyebrow"),
  sidebarStatus: document.querySelector("#sidebar-service-status"),
  runtimeBadge: document.querySelector("#runtime-badge span:last-child"),
  messages: document.querySelector("#messages"),
  chatPanel: document.querySelector(".chat-panel"),
  form: document.querySelector("#chat-form"),
  input: document.querySelector("#chat-input"),
  ragToggle: document.querySelector("#rag-toggle"),
  ragLabel: document.querySelector("#rag-label"),
  stop: document.querySelector("#stop-button"),
  send: document.querySelector("#send-button"),
  conversations: document.querySelector("#conversation-list"),
  newChat: document.querySelector("#new-chat-button"),
  evidence: document.querySelector("#evidence-list"),
  evidenceCount: document.querySelector("#evidence-count"),
  ttft: document.querySelector("#metric-ttft"),
  retrieval: document.querySelector("#metric-retrieval"),
  speed: document.querySelector("#metric-speed"),
  memory: document.querySelector("#metric-memory"),
  documentFile: document.querySelector("#document-file"),
  importButton: document.querySelector("#import-button"),
  documentList: document.querySelector("#document-list"),
  knowledgeSummary: document.querySelector("#knowledge-summary"),
  toast: document.querySelector("#toast")
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || "请求失败，请稍后重试");
  }
  return response.json();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.add("hidden"), 2600);
}

function escapeText(value) {
  return String(value ?? "");
}

function renderTextWithCitations(container, text) {
  container.replaceChildren();
  const parts = escapeText(text).split(/(【\d+】)/g);
  for (const part of parts) {
    const match = part.match(/^【(\d+)】$/);
    if (match) {
      const button = document.createElement("button");
      button.className = "citation-link";
      button.type = "button";
      button.textContent = part;
      button.addEventListener("click", () => focusEvidence(Number(match[1]) - 1));
      container.append(button);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

function addMessage(role, content = "", options = {}) {
  document.querySelector("#welcome-card")?.remove();
  const item = document.createElement("article");
  item.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? "✦" : "你";
  const card = document.createElement("div");
  card.className = "message-card";
  const body = document.createElement("div");
  body.className = "message-content";
  if (role === "assistant") renderTextWithCitations(body, content);
  else body.textContent = content;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = options.meta || (role === "assistant" ? "本地 Flask Agent" : "刚刚");
  card.append(body, meta);
  item.append(avatar, card);
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return { item, body, meta };
}

function addPlanCard(plan, onCompleted) {
  const card = document.createElement("section");
  card.className = `plan-card ${plan.riskClass || "read_only"}`;
  const title = document.createElement("strong");
  title.textContent = `行动计划 · ${plan.label}`;
  const status = document.createElement("span");
  status.className = "plan-status";
  status.textContent = plan.status === "AWAITING_CONFIRMATION" ? "等待你的确认" : "已验证";
  const argumentsList = document.createElement("dl");
  Object.entries(plan.arguments || {}).forEach(([key, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = Array.isArray(value) ? value.join("、") : String(value);
    row.append(term, detail);
    argumentsList.append(row);
  });
  const note = document.createElement("p");
  note.className = "plan-note";
  note.textContent = plan.riskClass === "high_risk"
    ? "高风险操作必须确认。当前仍是本地沙箱，不会连接真实邮箱、日历、待办或文件系统。"
    : "该计划已由本地策略校验；模型输出不能自行授予权限。";
  card.append(title, status, argumentsList, note);
  if (plan.status === "AWAITING_CONFIRMATION") {
    const actions = document.createElement("div");
    actions.className = "plan-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost-button";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary-button";
    confirm.textContent = "确认执行";
    cancel.addEventListener("click", async () => {
      try {
        await request(`/api/v1/plans/${encodeURIComponent(plan.planId)}/cancel`, { method: "POST" });
        status.textContent = "已取消";
        actions.remove();
      } catch (error) { showToast(error.message); }
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = cancel.disabled = true;
      status.textContent = "正在执行沙箱操作…";
      try {
        const result = await request(`/api/v1/plans/${encodeURIComponent(plan.planId)}/confirm`, { method: "POST" });
        status.textContent = result.plan?.status === "SUCCEEDED" ? "已完成" : (result.plan?.status || "已提交");
        actions.remove();
        onCompleted?.(result);
      } catch (error) {
        status.textContent = "确认未通过";
        showToast(error.message);
      }
    });
    actions.append(cancel, confirm);
    card.append(actions);
  }
  elements.messages.append(card);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updateEvidence(items) {
  state.citations = items;
  elements.evidenceCount.textContent = String(items.length);
  elements.evidenceCount.classList.remove("counter-updated");
  void elements.evidenceCount.offsetWidth;
  elements.evidenceCount.classList.add("counter-updated");
  elements.evidence.replaceChildren();
  if (!items.length) {
    elements.evidence.className = "evidence-list empty-state";
    elements.evidence.innerHTML = "<p>本轮没有检索到可引用证据。</p>";
    return;
  }
  elements.evidence.className = "evidence-list";
  items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "evidence-card";
    card.style.setProperty("--item-index", index);
    card.dataset.evidenceIndex = String(index);
    const heading = document.createElement("header");
    const title = document.createElement("span");
    title.textContent = `${index + 1}. ${item.fileName}`;
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${Math.round(item.score * 100)}% 匹配`;
    heading.append(title, score);
    const quote = document.createElement("p");
    quote.textContent = item.quote;
    const locator = document.createElement("small");
    locator.textContent = item.locator;
    card.append(heading, quote, locator);
    elements.evidence.append(card);
  });
}

function focusEvidence(index) {
  const card = elements.evidence.querySelector(`[data-evidence-index="${index}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.animate([{ outline: "3px solid rgba(42,98,221,.42)" }, { outline: "0 solid rgba(42,98,221,0)" }], { duration: 850 });
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "—";
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function setMetric(element, value) {
  element.textContent = value;
  element.classList.remove("metric-updated");
  void element.offsetWidth;
  element.classList.add("metric-updated");
}

function updateMetrics(metrics) {
  const responseLatency = metrics.responseLatencyMs ?? metrics.ttftMs;
  setMetric(elements.ttft, formatDuration(responseLatency));
  setMetric(elements.retrieval, metrics.retrievalMs == null ? (metrics.ragEnabled === false ? "未启用" : "—") : formatDuration(metrics.retrievalMs));
  setMetric(elements.speed, Number.isFinite(Number(metrics.tokensPerSecond)) ? `${Number(metrics.tokensPerSecond).toFixed(1)} tok/s` : "—");
  setMetric(elements.memory, Number.isFinite(Number(metrics.peakRssMb)) ? `${Number(metrics.peakRssMb).toFixed(1)} MB` : "—");
}

function resetMetrics() {
  [elements.ttft, elements.retrieval, elements.speed, elements.memory].forEach((item) => (item.textContent = "—"));
}

function setGenerating(isGenerating) {
  elements.send.disabled = isGenerating;
  elements.input.disabled = isGenerating;
  elements.stop.classList.toggle("hidden", !isGenerating);
  elements.chatPanel.classList.toggle("is-generating", isGenerating);
  elements.chatPanel.setAttribute("aria-busy", String(isGenerating));
}

async function refreshRuntime() {
  const [health, runtime] = await Promise.all([request("/api/v1/health"), request("/api/v1/runtime/status")]);
  elements.sidebarStatus.textContent = health.status === "ok" ? "服务正常 · 本机运行" : "服务异常";
  elements.runtimeBadge.textContent = `${runtime.model.name} · ${runtime.resources.rssMb} MB`;
}

async function refreshConversations() {
  const payload = await request("/api/v1/conversations");
  elements.conversations.replaceChildren();
  if (!payload.items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有保存的对话";
    elements.conversations.append(empty);
    return;
  }
  payload.items.forEach((conversation) => {
    const button = document.createElement("button");
    button.className = `conversation-item ${conversation.id === state.conversationId ? "active" : ""}`;
    button.type = "button";
    button.textContent = conversation.title;
    button.addEventListener("click", () => loadConversation(conversation.id));
    elements.conversations.append(button);
  });
}

async function loadConversation(id) {
  const payload = await request(`/api/v1/conversations/${encodeURIComponent(id)}`);
  state.conversationId = payload.item.id;
  elements.messages.replaceChildren();
  payload.item.messages.forEach((message) => addMessage(message.role, message.content, { meta: message.role === "assistant" ? "历史回答" : "历史提问" }));
  const lastAssistant = [...payload.item.messages].reverse().find((item) => item.role === "assistant");
  updateEvidence(lastAssistant?.citations || []);
  if (lastAssistant?.metrics) updateMetrics(lastAssistant.metrics);
  else resetMetrics();
  refreshConversations();
}

function newChat() {
  state.conversationId = null;
  state.citations = [];
  elements.messages.innerHTML = `
    <div class="welcome-card" id="welcome-card">
      <span class="welcome-icon" aria-hidden="true">✦</span>
      <p class="eyebrow">新的本地对话</p>
      <h2>从本地资料中找到有依据的答案</h2>
      <p>输入一个问题，Flask Agent 会调用本地知识库并生成可追溯回答。</p>
    </div>`;
  updateEvidence([]);
  resetMetrics();
  refreshConversations();
  elements.input.focus();
}

function parseSseChunk(buffer, onEvent) {
  const blocks = buffer.split("\n\n");
  const remainder = blocks.pop();
  for (const block of blocks) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1] || "message";
    const raw = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!raw) continue;
    try { onEvent(event, JSON.parse(raw)); } catch { /* ignore incomplete protocol event */ }
  }
  return remainder;
}

async function sendMessage(question) {
  const userMessage = addMessage("user", question);
  const assistant = addMessage("assistant", "", { meta: "准备中" });
  assistant.body.classList.add("typing");
  assistant.body.textContent = "正在连接本地演示服务…";
  updateEvidence([]);
  resetMetrics();
  setGenerating(true);
  state.controller = new AbortController();
  let answer = "";

  try {
    const response = await fetch("/api/v1/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: state.conversationId, message: question, ragEnabled: state.ragEnabled }),
      signal: state.controller.signal
    });
    if (!response.ok || !response.body) throw new Error("无法建立流式回答连接");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const handleEvent = (event, data) => {
      if (event === "meta") {
        state.conversationId = data.conversationId;
        assistant.meta.textContent = data.ragEnabled
          ? `${data.model} · 本地知识库已启用`
          : `${data.model} · 直接本地推理（未检索知识库）`;
      }
      if (event === "stage") {
        assistant.body.classList.add("typing");
        assistant.body.textContent = data.label;
        assistant.meta.textContent = "处理中";
      }
      if (event === "plan") {
        addPlanCard(data, (result) => {
          if (result.citations?.length) updateEvidence(result.citations);
          assistant.body.classList.remove("typing");
          assistant.body.textContent = result.answer || "沙箱操作已完成。";
          assistant.meta.textContent = "本地 Agent · 已确认执行";
          elements.messages.scrollTop = elements.messages.scrollHeight;
        });
      }
      if (event === "citations") updateEvidence(data.items || []);
      if (event === "token") {
        if (!answer) {
          assistant.body.classList.remove("typing");
          assistant.body.textContent = "";
        }
        answer += data.text;
        renderTextWithCitations(assistant.body, answer);
        assistant.body.classList.add("streaming");
        assistant.meta.textContent = "本地 Flask Agent · 流式输出";
        elements.messages.scrollTop = elements.messages.scrollHeight;
      }
      if (event === "metrics") updateMetrics(data);
      if (event === "done") {
        assistant.body.classList.remove("streaming");
        assistant.meta.textContent = "本地 Flask Agent · 已完成";
      }
      if (event === "error") throw new Error(data.message || "生成失败");
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = parseSseChunk(buffer + value, handleEvent);
    }
    if (buffer.trim()) parseSseChunk(`${buffer}\n\n`, handleEvent);
    await Promise.all([refreshConversations(), refreshRuntime()]);
  } catch (error) {
    if (error.name === "AbortError") {
      assistant.body.classList.remove("typing");
      if (!answer) assistant.body.textContent = "已停止生成。";
      assistant.meta.textContent = "已停止";
      showToast("已停止本轮生成");
    } else {
      assistant.body.classList.remove("typing");
      assistant.body.classList.remove("streaming");
      assistant.body.textContent = `发生错误：${error.message}`;
      assistant.meta.textContent = "生成失败";
      showToast(error.message);
    }
  } finally {
    setGenerating(false);
    state.controller = null;
  }
}

async function refreshDocuments() {
  const payload = await request("/api/v1/documents");
  const imported = payload.items.filter((item) => !item.builtin).length;
  elements.knowledgeSummary.innerHTML = `<span class="summary-chip">${payload.items.length} 份材料</span><span class="summary-chip">${imported} 份用户导入</span><span class="summary-chip">下一轮问答即时生效</span>`;
  elements.documentList.replaceChildren();
  payload.items.forEach((document, index) => {
    const card = document.createElement("article");
    card.className = "document-card";
    card.style.setProperty("--item-index", index);
    const main = document.createElement("div");
    main.className = "document-main";
    const icon = document.createElement("div");
    icon.className = "document-icon";
    icon.textContent = document.builtin ? "⌘" : "T";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = document.name;
    const detail = document.createElement("span");
    const qualityLabel = document.extractionQuality === "ocr-reviewed"
      ? "OCR 已识别"
      : document.extractionQuality === "ocr-low-confidence" ? "OCR 低置信度" : "原生文本";
    detail.textContent = `${document.source} · ${document.characters} 字符 · ${document.locator} · ${qualityLabel}`;
    info.append(title, detail);
    main.append(icon, info);
    const actions = document.createElement("div");
    actions.className = "document-actions";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = document.extractionQuality === "ocr-low-confidence"
      ? "需复核" : (document.builtin ? "内置可用" : "已导入");
    actions.append(tag);
    if (!document.builtin) {
      const remove = document.createElement("button");
      remove.className = "delete-button";
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", async () => {
        await request(`/api/v1/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
        await refreshDocuments();
        await refreshRuntime();
        showToast("材料已从本地知识库移除，并已重建 FAISS 索引");
      });
      actions.append(remove);
    }
    card.append(main, actions);
    elements.documentList.append(card);
  });
}

function switchView(viewName) {
  elements.nav.forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  elements.views.forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`));
  const isChat = viewName === "chat";
  elements.viewTitle.textContent = isChat ? "智能对话" : "知识库";
  elements.viewEyebrow.textContent = isChat ? "LOCAL RAG DEMO" : "LOCAL KNOWLEDGE BASE";
  if (!isChat) refreshDocuments();
}

elements.nav.forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
elements.newChat.addEventListener("click", newChat);
elements.ragToggle.addEventListener("change", () => {
  state.ragEnabled = elements.ragToggle.checked;
  elements.ragLabel.textContent = state.ragEnabled ? "已启用" : "已关闭";
  document.querySelector("#composer-hint").textContent = state.ragEnabled ? "本地知识库将参与回答" : "本轮不检索知识库";
});
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = elements.input.value.trim();
  if (!question || state.controller) return;
  elements.input.value = "";
  sendMessage(question);
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
elements.stop.addEventListener("click", () => state.controller?.abort());
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => {
  elements.input.value = button.dataset.question;
  elements.form.requestSubmit();
}));
elements.importButton.addEventListener("click", () => elements.documentFile.click());
elements.documentFile.addEventListener("change", async () => {
  const [file] = elements.documentFile.files;
  if (!file) return;
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch("/api/v1/documents/import", { method: "POST", body: form });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || "导入失败，请稍后重试");
    }
    await Promise.all([refreshDocuments(), refreshRuntime()]);
    showToast(`已导入 ${file.name}，已更新本地索引`);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.documentFile.value = "";
  }
});

Promise.all([refreshRuntime(), refreshConversations(), refreshDocuments()]).catch((error) => {
  elements.sidebarStatus.textContent = "服务连接失败";
  elements.runtimeBadge.textContent = "本地服务不可用";
  showToast(error.message);
});
