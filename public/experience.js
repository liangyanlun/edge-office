export const WRITING_TASKS = new Set(["email", "polish", "minutes", "rewrite"]);
export function answerLabel(kind, metrics = {}) {
  const base = ({generated: "模型生成 · 请核对内容", grounded: "根据材料生成 · 请核对引用", extractive: "原文依据 · 模型未返回可用回答", extractive_fallback: "原文依据 · 模型回答未通过校验", insufficient_evidence: "依据不足 · 可调整材料范围", unavailable: "需要可用模型", awaiting_confirmation: "等待确认 · 尚未执行", simulation: "仅演练 · 未执行真实操作", tool_result: "处理结果"})[kind] || "历史结果";
  const reason = metrics.fallbackReason ? ` · ${metrics.fallbackReason}` : "";
  const model = metrics.modelName ? ` · ${metrics.modelName}` : "";
  return base + reason + model;
}
function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
function button(label, action, cls = "ghost-button") { const el = node("button", cls, label); el.type = "button"; el.addEventListener("click", action); return el; }
export function renderRichText(container, text, onCitation) {
  container.replaceChildren();
  function inline(parent, value) {
    for (const part of value.split(/(【\d+】|\*\*[^*]+\*\*)/g)) {
      if (/^【\d+】$/.test(part)) parent.append(button(part, () => onCitation?.(Number(part.slice(1,-1)) - 1), "citation-link"));
      else if (part.startsWith("**") && part.endsWith("**")) parent.append(node("strong", "", part.slice(2,-2)));
      else parent.append(document.createTextNode(part));
    }
  }
  let list = null;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) { list = null; continue; }
    const heading = line.match(/^#{1,4}\s+(.+)/);
    const bullet = line.match(/^(?:[-*•]\s+|\d+[.)、]\s*)(.+)/);
    if (bullet) { if (!list) { list = node("ul"); container.append(list); } const item = node("li"); inline(item, bullet[1]); list.append(item); }
    else { list = null; const block = node(heading ? "h3" : "p"); inline(block, heading ? heading[1] : line); container.append(block); }
  }
}
export function createExperience(ctx) {
  const {state, elements, request, showToast, useTool} = ctx;
  state.documentIds = null;
  let activeDialog = null;
  const scopeButton = button("全部材料", () => chooseSources());
  scopeButton.id = "source-scope-button"; scopeButton.classList.add("scope-button"); scopeButton.setAttribute("aria-haspopup", "dialog");
  document.querySelector(".chat-toolbar").append(scopeButton);
  const modeText = node("span", "scope-note"); scopeButton.after(modeText);
  function dialog(title, description) {
    activeDialog?.close(); const previous = document.activeElement;
    const el = node("dialog", "experience-dialog"); const heading = node("div", "dialog-heading");
    const titleEl = node("h2", "", title); titleEl.id = "experience-dialog-title"; el.setAttribute("aria-labelledby", titleEl.id);
    const close = button("×", () => el.close(), "icon-button"); close.setAttribute("aria-label", "关闭对话框");
    const body = node("div", "dialog-body"); body.append(node("p", "dialog-helper", description));
    heading.append(titleEl, close); el.append(heading, body); document.body.append(el); activeDialog = el;
    el.addEventListener("close", () => { el.remove(); if (activeDialog === el) activeDialog = null; if (previous?.isConnected) previous.focus(); });
    return el;
  }
  async function confirmRemoval(name) {
    const el = dialog("移除这份材料？", name + " 将从知识库和检索索引中移除。电脑中的原始文件不受影响；已有回答仍保留历史引用。");
    const actions = node("div", "dialog-actions"); actions.append(button("保留材料", () => el.close()), button("确认移除", () => el.close("confirmed"), "danger-button")); el.querySelector(".dialog-body").append(actions); el.showModal();
    return new Promise(resolve => el.addEventListener("close", () => resolve(el.returnValue === "confirmed"), {once:true}));
  }
  function refreshScope() {
    const writing = WRITING_TASKS.has(state.activeToolId);
    const names = state.documentIds?.map(id => state.documents.find(doc => doc.id === id)?.name || "已移除的材料");
    scopeButton.textContent = writing ? "仅使用输入文字" : names ? (names.length === 1 ? names[0] : "已选 " + names.length + " 份材料") : "全部材料 · " + state.documents.length;
    scopeButton.title = names?.join("、") || "选择回答使用的材料"; scopeButton.disabled = writing || !!state.controller;
    modeText.textContent = writing ? "生成草稿" : state.documentIds ? "只检索所选范围" : "可指定文件";
    document.querySelector("#composer-hint").textContent = writing ? "直接处理输入文本，不检索知识库" : state.ragEnabled ? "引用可核对 · Shift + Enter 换行" : "本轮不检索材料";
  }
  function chooseSources(forCompare = state.activeToolId === "compare") {
    const el = dialog(forCompare ? "选择两份要对比的材料" : "这次使用哪些材料？", forCompare ? "对比两份材料中的相关片段，证据不足时会明确说明。" : "回答只检索所选文件。最多选择 8 份。");
    const selected = new Set((state.documentIds || []).filter(id => state.documents.some(doc => doc.id === id)));
    const search = node("input", "source-search"); search.type = "search"; search.placeholder = "按文件名查找"; search.setAttribute("aria-label", "搜索材料");
    const list = node("div", "source-options"); const count = node("span", "selection-count");
    const apply = button("使用所选材料", () => { state.documentIds = Array.from(selected); refreshScope(); el.close(); elements.input.focus(); }, "primary-button");
    function sync() { count.textContent = "已选 " + selected.size + (forCompare ? " / 2 份" : " / 8 份"); apply.disabled = forCompare ? selected.size !== 2 : selected.size < 1 || selected.size > 8; }
    for (const doc of state.documents) {
      const row = node("label", "source-option"); row.dataset.name = doc.name.toLowerCase(); const input = node("input"); input.type = "checkbox"; input.value = doc.id; input.checked = selected.has(doc.id);
      input.addEventListener("change", () => { if (input.checked) selected.add(doc.id); else selected.delete(doc.id); sync(); }); row.append(input, node("span", "", doc.name)); list.append(row);
    }
    if (!state.documents.length) list.append(node("p", "empty-inline", "还没有材料，请先导入一份文档。"));
    search.addEventListener("input", () => list.querySelectorAll(".source-option").forEach(row => { row.hidden = !row.dataset.name.includes(search.value.trim().toLowerCase()); }));
    const actions = node("div", "dialog-actions");
    if (!forCompare) actions.append(button("使用全部材料", () => { state.documentIds = null; refreshScope(); el.close(); }));
    actions.append(count, apply); el.querySelector(".dialog-body").append(search, list, actions); sync(); el.showModal();
  }
  function prepareTool(tool) {
    if (["summary", "outline", "tasks"].includes(tool.id) && state.documents.length === 1 && !state.documentIds) state.documentIds = [state.documents[0].id];
    refreshScope(); if (tool.id === "compare" && state.documentIds?.length !== 2) chooseSources(true);
  }
  function download(text, filename, type = "text/markdown;charset=utf-8") {
    const blob = new Blob([text], {type}); const url = URL.createObjectURL(blob); const a = node("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const input = node("textarea", "clipboard-fallback"); input.value = text; (activeDialog || document.body).append(input); input.select(); const copied = document.execCommand("copy"); input.remove(); if (!copied) throw new Error("无法自动复制，请选择文字手动复制"); }
    showToast("已复制，可以粘贴到其他应用");
  }
  function resultActions(message, text, citations = [], kind) {
    message.item.querySelector(".result-actions")?.remove();
    if (!text || ["unavailable", "insufficient_evidence", "awaiting_confirmation"].includes(kind)) return;
    const bar = node("div", "result-actions");
    const withSources = value => value + (citations.length ? "\n\n引用依据\n" + citations.map((c,i) => "[" + (i+1) + "] " + c.fileName + " · " + (c.locator || "") + "\n" + c.quote).join("\n\n") : "") + "\n\n结果类型：" + answerLabel(kind);
    const safeCopy = value => copy(value).catch(error => showToast(error.message));
    bar.append(button("复制", () => safeCopy(text), "result-action"));
    bar.append(button("编辑副本", () => {
      const el = dialog("把结果整理成你的版本", "直接修改后复制或导出。原始回答与引用保持不变。"); el.classList.add("result-editor-dialog");
      const textarea = node("textarea", "result-editor"); textarea.value = text; textarea.setAttribute("aria-label", "编辑结果副本"); const actions = node("div", "dialog-actions");
      actions.append(button("复制编辑结果", () => safeCopy(textarea.value)), button("导出副本", () => download(withSources(textarea.value) + "\n此副本已由用户编辑，引用仅供核对。", "微知-编辑副本.md"), "primary-button")); el.querySelector(".dialog-body").append(textarea, actions); el.showModal();
    }, "result-action"));
    bar.append(button("导出", () => download(withSources(text), "微知-结果.md"), "result-action"));
    if (citations.length) bar.append(button("查看依据", () => { ctx.updateEvidence(citations); ctx.focusEvidence(0); }, "result-action"));
    message.meta.after(bar);
  }
  function documentActions(doc, actions) {
    const scoped = task => { state.documentIds = [doc.id]; useTool(task); refreshScope(); };
    if (!state.offline || state.nativeInference) actions.prepend(button("总结", () => scoped("summary"), "document-action"));
    actions.prepend(button("提问", () => scoped("quote"), "document-action"));
    if (state.documents.length >= 2 && (!state.offline || state.nativeInference)) actions.append(button("对比", () => scoped("compare"), "document-action"));
  }
  setupWorkspace(ctx, download); refreshScope();
  return {refreshScope, chooseSources, prepareTool, confirmRemoval, resultActions, documentActions, download};
}
function setupWorkspace(ctx, download) {
  const {elements, request, showToast, useTool, openSettings} = ctx;
  const start = document.querySelector('[data-onboarding-step="0"]');
  start.querySelector("h1").textContent = "把手边的材料，变成下一步。";
  start.querySelector("h1 + p").textContent = "读懂一份文件、写好一段文字。从眼前这件小事开始。";
  const firstTasks = document.querySelector(".first-task-grid"); firstTasks.querySelector('[data-first-task="summary"]')?.remove();
  const preferences = node("details", "onboarding-preferences"); preferences.append(node("summary", "", "可选：设置称呼与偏好"), elements.onboardingForm);
  const skip = document.querySelector("#onboarding-skip"); skip.textContent = "先看看工作台";
  start.querySelector(".onboarding-actions").replaceChildren(skip);
  start.querySelector(".trust-list").replaceChildren(node("p", "onboarding-note", "桌面和手机端都优先保存在本机；Android 可离线导入多格式材料，安装 GGUF 后可生成草稿或编辑 PPT。手机为结构预览，复杂 PPT 版式请导出核对；扫描件 OCR 仍需电脑端。"));
  start.insertBefore(firstTasks, start.querySelector(".onboarding-actions")); start.insertBefore(preferences, start.querySelector(".onboarding-actions"));
  document.querySelectorAll(".onboarding-step:not([data-onboarding-step='0'])").forEach(el => el.remove());
  document.querySelector(".onboarding-header > span").textContent = "欢迎来到微知";
  document.querySelector("#onboarding-step-label").textContent = "快速开始";
  const closeOnboarding = button("×", () => ctx.dismissOnboarding(), "icon-button");
  closeOnboarding.setAttribute("aria-label", "关闭引导");
  document.querySelector(".onboarding-header").append(closeOnboarding);
  elements.onboardingForm.addEventListener("submit", event => event.preventDefault());
  const settings = document.querySelector(".settings-dialog"); document.querySelector("#settings-title").textContent = "你的工作区";
  const models = node("details", "settings-section"); models.id = "model-settings"; models.append(node("summary", "", "模型与下载"), document.querySelector(".model-center-section"), elements.modelDownloadControl); settings.append(models);
  const diagnostics = node("details", "settings-section"); diagnostics.append(node("summary", "", "运行诊断"), document.querySelector('[data-insight-content="metrics"]')); settings.append(diagnostics);
  document.querySelector('[data-insight="metrics"]').remove();
  const data = node("details", "settings-section"); data.append(node("summary", "", "数据与隐私"), node("p", "dialog-helper", "导出包含对话与材料提取文本，不含模型、PPT 原件或应用配置。这是可阅读的存档，不是可恢复安装的备份。"));
  data.append(button("导出对话与材料文本", async event => { const btn = event.currentTarget; btn.disabled = true; try { const archive = await request("/api/v1/workspace/export"); download(JSON.stringify(archive, null, 2), "微知-工作区文本存档.json", "application/json"); showToast("文本存档已导出，请妥善保存"); } catch (error) { showToast(error.message); } finally { btn.disabled = false; } })); settings.append(data);
  // The header is outside the scrolling content, so its close action never moves.
  const settingsBody = node("div", "dialog-body");
  Array.from(settings.children).filter(child => !child.classList.contains("dialog-heading")).forEach(child => settingsBody.append(child));
  settings.append(settingsBody);
  document.querySelector("#close-settings").setAttribute("aria-label", "关闭设置");
  const desktopStorage = node("p", "dialog-helper desktop-storage-info"); desktopStorage.hidden = true; models.querySelector("summary").after(desktopStorage);
  async function showDesktopStorage() {
    if (!window.pywebview?.api?.get_installation_info) return;
    try {
      const info = await window.pywebview.api.get_installation_info();
      desktopStorage.textContent = "软件安装位置：" + info.applicationDirectory + "。软件位置可在安装向导中选择；每个模型下载前可选择保存文件夹。";
      desktopStorage.hidden = false;
    } catch { /* Browser/mobile versions have no native directory picker. */ }
  }
  window.addEventListener("pywebviewready", showDesktopStorage);
  showDesktopStorage();
  const badge = document.querySelector("#runtime-badge"); badge.setAttribute("role", "button"); badge.tabIndex = 0; badge.setAttribute("aria-label", "查看模型与运行设置");
  const openModel = () => { openSettings(); models.open = true; }; badge.addEventListener("click", openModel); badge.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); openModel(); } });
  const history = button("最近对话", event => { const shown = document.querySelector("#chat-view").classList.toggle("show-history"); event.currentTarget.setAttribute("aria-expanded", String(shown)); }, "history-toggle ghost-button");
  history.setAttribute("aria-expanded", "false"); history.setAttribute("aria-controls", "conversation-list"); document.querySelector(".chat-toolbar").prepend(history);
  const hero = document.querySelector(".dashboard-intro");
  const actions = node("div", "hero-actions"); actions.append(button("＋ 导入一份材料", () => useTool("import"), "primary-button"), button("开始写作 →", () => useTool("polish"))); hero.append(actions);
  const art = node("div", "hero-art"); art.setAttribute("aria-hidden", "true"); art.innerHTML = '<div class="art-orbit"></div><div class="art-paper paper-back"><i></i><i></i><i></i></div><div class="art-paper paper-front"><span>微</span><i></i><i></i><b>从想法到成果</b></div><div class="art-spark">✦</div>'; hero.append(art);
  document.querySelector(".insight-tabs").after(node("p", "evidence-help", "点击回答中的引用，核对对应原文。"));
  document.querySelector("#ppt-view .section-kicker").textContent = "PPT 编辑 · 实验功能";
  document.querySelector("#ppt-empty span").textContent = "支持修改文字、克隆或删除段落、替换或删除图片。建议使用经过专项验证的 4B 模型。";
  document.querySelector("#ppt-confirm-button").textContent = "应用修改并自动保存";
  document.querySelector(".ppt-complete-card p").textContent = "工作副本自动保存，可以直接继续编辑；仅在需要带走文件时导出。原件与撤销记录自动保留。";
  let opener = null;
  const layers = Array.from(document.querySelectorAll(".modal-layer, .onboarding-layer"));
  const observer = new MutationObserver(records => {
    for (const {target:layer} of records) if (!layer.classList.contains("hidden")) {
      opener = document.activeElement;
      queueMicrotask(() => {
        if (layer.classList.contains("hidden")) return;
        if (layer.classList.contains("onboarding-layer")) {
          const dialog = layer.querySelector(".onboarding-dialog");
          const step = layer.querySelector(".onboarding-step.active");
          if (dialog) { dialog.tabIndex = -1; dialog.scrollTop = 0; dialog.focus({preventScroll:true}); }
          if (step) step.scrollTop = 0;
        } else layer.querySelector("button, input, select")?.focus({preventScroll:true});
      });
    }
    if (!layers.some(layer => !layer.classList.contains("hidden"))) { opener?.focus(); opener = null; }
    document.querySelector("#app-shell").inert = layers.some(layer => !layer.classList.contains("hidden"));
  });
  layers.forEach(layer => observer.observe(layer, {attributes:true, attributeFilter:["class"]}));
  document.addEventListener("keydown", event => {
    if (event.key !== "Tab" || document.querySelector("dialog[open]")) return;
    const layer = layers.find(item => !item.classList.contains("hidden")); if (!layer) return;
    const focusable = Array.from(layer.querySelectorAll("button, input, select, textarea, summary, a[href]")).filter(el => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
}
