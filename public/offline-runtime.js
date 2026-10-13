const DB_NAME = "edge-office-offline";
import {createMobilePpt} from "./mobile-ppt.js";
const DB_VERSION = 2;

function uid(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return prefix + "-" + Date.now().toString(36) + "-" + random.replace(/-/g, "").slice(0, 12);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("preferences")) db.createObjectStore("preferences", {keyPath: "id"});
      if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents", {keyPath: "id"});
      if (!db.objectStoreNames.contains("conversations")) db.createObjectStore("conversations", {keyPath: "id"});
      if (!db.objectStoreNames.contains("presentations")) db.createObjectStore("presentations", {keyPath: "id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开手机本地数据库"));
  });
}

function transaction(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    if (request && "onsuccess" in request) {
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("本地数据库操作未保存"));
      request.onerror = () => reject(request.error || new Error("本地数据库操作失败"));
    } else {
      tx.oncomplete = () => resolve(request);
      tx.onerror = () => reject(tx.error || new Error("本地数据库操作失败"));
    }
  });
}

function makeChunks(units, size = 700, overlap = 80) {
  const chunks = [];
  for (const unit of units) {
    const clean = String(unit.text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    for (let start = 0; start < clean.length; start += Math.max(1, size - overlap)) {
      const value = clean.slice(start, start + size).trim();
      if (value) chunks.push({text: value, locator: unit.locator + (start ? " · 字符 " + (start + 1) : "")});
      if (start + size >= clean.length) break;
    }
  }
  return chunks;
}

function queryTokens(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]/g) || [];
}

function retrieve(documents, query, selectedIds) {
  const tokens = queryTokens(query);
  const candidates = [];
  for (const document of documents) {
    if (selectedIds && !selectedIds.includes(document.id)) continue;
    for (const chunk of document.chunks || []) {
      const lower = chunk.text.toLowerCase();
      const phrase = String(query || "").trim().toLowerCase();
      const phraseBoost = phrase.length > 2 && lower.includes(phrase) ? 3 : 0;
      const tokenHits = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
      const score = phraseBoost + tokenHits / Math.max(1, tokens.length);
      if (score > 0) candidates.push({document, chunk, score});
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function createOfflineRuntime({plugin = null} = {}) {
  let db;
  let model = {installed: false, name: "", size: 0};
  let nativeInference = false;
  let models = [];

  async function refreshNativeModels() {
    if (!plugin?.models) return models;
    try {
      const result = await plugin.models();
      models = Array.isArray(result?.items) ? result.items : [];
    } catch {
      models = [];
    }
    return models;
  }

  async function refreshNativeStatus() {
    if (!plugin?.status) return;
    try {
      const result = await plugin.status();
      model = {installed: Boolean(result?.installed), name: result?.name || "", size: Number(result?.size || 0), activeModelId: result?.activeModelId || "", chatModelName: result?.chatModelName || result?.name || "", chatModelInstalled: result?.chatModelInstalled ?? Boolean(result?.installed), modelRoutingNotice: result?.modelRoutingNotice || ""};
      nativeInference = Boolean(result?.nativeInference);
    } catch {
      model = {installed: false, name: "", size: 0, activeModelId: ""};
      nativeInference = false;
    }
  }

  async function start() {
    db = await openDatabase();
    await refreshNativeStatus();
    await refreshNativeModels();
    return {mode: "offline", paired: true, pairingRequired: false, model};
  }

  const ppt = createMobilePpt({
    read:id=>transaction(db, "presentations", "readonly", s=>s.get(id)),
    write:doc=>transaction(db, "presentations", "readwrite", s=>s.put(doc)),
    list:()=>transaction(db, "presentations", "readonly", s=>s.getAll()),
    infer:async options=>{if(!plugin?.infer || !nativeInference) throw new Error("请先下载并启用本机模型；PPT 编辑建议 4B");return plugin.infer(options);},
  });

  async function preferences(changes) {
    if (changes) {
      const current = await preferences();
      const item = {...current, ...changes};
      await transaction(db, "preferences", "readwrite", store => store.put({id: "profile", ...item}));
      return item;
    }
    const item = await transaction(db, "preferences", "readonly", store => store.get("profile"));
    return item || {id: "profile", displayName: "", role: "科研学习", writingTone: "professional", ragEnabled: true, onboardingComplete: false, lastView: "home"};
  }

  async function documents() {
    return transaction(db, "documents", "readonly", store => store.getAll());
  }

  async function importFile(file) {
    const {parseMobileDocument} = await import("./mobile-document-parser.js");
    const parsed = await parseMobileDocument(file);
    const existing = (await documents()).find((item) => item.fileSha256 === parsed.fileSha256 && item.name === file.name);
    if (existing) return {...existing, alreadyImported: true};
    const chunks = makeChunks(parsed.units);
    if (!chunks.length) throw new Error("材料没有可检索的文字");
    const item = {
      id: uid("doc"), name: file.name, source: "手机本地导入", builtin: false,
      fileSha256: parsed.fileSha256, versionId: parsed.fileSha256.slice(0, 12),
      mimeType: parsed.mimeType, parser: parsed.parser, fileSize: parsed.fileSize,
      characters: parsed.units.reduce((sum, unit) => sum + unit.text.length, 0),
      locator: parsed.units[0].locator, extractionQuality: parsed.extractionQuality,
      importWarning: parsed.warning || "", importedAt: new Date().toISOString(), chunks
    };
    await transaction(db, "documents", "readwrite", store => store.put(item));
    return item;
  }

  async function removeDocument(id) {
    await transaction(db, "documents", "readwrite", store => store.delete(id));
    return {ok: true};
  }

  async function conversationList() {
    return transaction(db, "conversations", "readonly", store => store.getAll());
  }

  async function conversation(id) {
    return transaction(db, "conversations", "readonly", store => store.get(id));
  }

  async function saveConversation(question, answer, citations, metrics) {
    const list = await conversationList();
    const item = list.find(entry => entry.id === metrics.conversationId) || {
      id: metrics.conversationId || uid("conversation"), title: question.slice(0, 36), messages: [], updatedAt: new Date().toISOString()
    };
    item.messages.push({role: "user", content: question, createdAt: new Date().toISOString()});
    item.messages.push({role: "assistant", content: answer, citations, metrics, createdAt: new Date().toISOString()});
    item.updatedAt = new Date().toISOString();
    await transaction(db, "conversations", "readwrite", store => store.put(item));
    return item;
  }

  async function answer(question, options = {}) {
    const started = performance.now();
    const docs = await documents();
    const retrievalStarted = performance.now();
    const candidates = options.ragEnabled === false ? [] : retrieve(docs, question, options.documentIds || null);
    const retrievalMs = options.ragEnabled === false ? null : Math.round(performance.now() - retrievalStarted);
    const citations = candidates.map((candidate, index) => ({
      id: candidate.document.id + "#" + (index + 1), fileName: candidate.document.name,
      locator: candidate.chunk.locator, quote: candidate.chunk.text.slice(0, 420), score: candidate.score
    }));
    let text;
    let answerKind;
    let fallbackReason = "";
    if (model.installed && nativeInference && plugin?.infer) {
      const evidence = citations.length
        ? citations.map((item, index) => `证据${index + 1}（${item.fileName}，${item.locator}）：${item.quote}`).join("\n")
        : "（本轮没有检索到本地材料。）";
      const directWriting = ["email", "polish", "minutes"].includes(options.task);
      const guard = citations.length ? "引用给定材料时只依据本地证据；缺少证据的事实不要猜测。" : directWriting || options.ragEnabled === false ? "可以处理用户提供的文字或撰写草稿，但没有材料依据的事实不要编造。" : "没有检索到依据；若问题涉及本地材料，明确说明无法确认。";
      const prompt = `你是 Edge Office 的离线办公助手。${guard}回答简洁、直接、使用中文。\n\n用户问题：${question}\n\n本地证据：\n${evidence}\n\n回答：`;
      try {
        const generated = await plugin.infer({prompt, maxTokens: 1024});
        if (generated?.finishReason === "length") throw new Error("模型输出达到长度上限，未完成回答");
        if (generated?.finishReason === "error") throw new Error("本轮本机推理未完成");
        if (generated?.answer) {
          answerKind = "generated";
          text = generated.answer.trim();
          if (citations.length) text += "\n\n本轮依据：" + citations.map((_, index) => `【${index + 1}】`).join(" ");
          const elapsed = Math.round(performance.now() - started);
          const conversationId = options.conversationId || uid("conversation");
          const metrics = {conversationId, answerKind, modelName: generated.model || model.chatModelName || model.name, responseLatencyMs: elapsed, retrievalMs, ragEnabled: options.ragEnabled !== false, modelGenerationMs: Number(generated.generationMs || 0), generatedTokens: Number(generated.generatedTokens || 0), tokensPerSecond: Number(generated.tokensPerSecond || 0), documentIds: options.documentIds || null};
          await saveConversation(question, text, citations, metrics);
          return {answer: text, citations, metrics, conversationId};
        }
      } catch (error) {
        fallbackReason = error.message === "模型输出达到长度上限，未完成回答" ? error.message : "本轮本机推理未完成，可重试并检查普通问答模型";
        // Fall through to deterministic local retrieval with an explicit status.
      }
    }
    if (citations.length) {
      answerKind = "extractive";
      text = "已在手机本地材料中找到 " + citations.length + " 条相关内容：\n\n" +
        citations.map((item, index) => (index + 1) + ". " + item.quote + "【" + (index + 1) + "】").join("\n\n") +
        "\n\n以上为本机材料原文；本轮模型未返回完整可用回答。";
    } else if (model.installed) {
      answerKind = "unavailable";
      text = "离线 GGUF 模型已导入，但本机推理暂时不可用。请在模型中心确认当前模型已完成校验并启用，或重新启动应用后重试。";
    } else if (docs.length) {
      answerKind = "insufficient_evidence";
      text = "手机本地知识库中没有找到足够依据。请换一个关键词、扩大材料范围，或导入更多文本材料。";
    } else {
      answerKind = "unavailable";
      text = "当前处于完全离线模式。请先导入模型，或导入 TXT、Markdown、PDF（含文本层）、DOCX、XLSX、CSV、PPTX、HTML、JSON 材料。";
    }
    const elapsed = Math.round(performance.now() - started);
    const conversationId = options.conversationId || uid("conversation");
    const metrics = {conversationId, answerKind, fallbackReason, responseLatencyMs: elapsed, retrievalMs, ragEnabled: options.ragEnabled !== false, modelGenerationMs: 0, generatedTokens: 0, tokensPerSecond: 0, documentIds: options.documentIds || null};
    await saveConversation(question, text, citations, metrics);
    return {answer: text, citations, metrics, conversationId};
  }

  async function exportWorkspace() {
    return {mode: "offline", exportedAt: new Date().toISOString(), documents: await documents(), conversations: await conversationList(), excludes: ["models", "original_files", "ppt_versions", "settings", "credentials"]};
  }

  async function pickModel() {
    if (!plugin?.pickModel) throw new Error("当前 Android 包没有启用本地模型导入插件");
    const result = await plugin.pickModel();
    model = {installed: Boolean(result?.installed), name: result?.name || "", size: Number(result?.size || 0)};
    nativeInference = Boolean(result?.nativeInference);
    return model;
  }

  async function downloadModel(modelId, sourceId = "modelscope") {
    if (!plugin?.downloadModel) throw new Error("当前 Android 包尚未启用模型 Release 下载");
    const result = await plugin.downloadModel({modelId, sourceId});
    await refreshNativeModels();
    return result?.item || null;
  }

  async function activateModel(modelId) {
    if (!plugin?.activateModel) throw new Error("当前 Android 包尚未启用模型切换");
    const result = await plugin.activateModel({modelId});
    await refreshNativeStatus();
    await refreshNativeModels();
    return result;
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    if (path === "/api/v1/mobile/bootstrap") return {mode: "offline", paired: true, pairingRequired: false, model};
    if (path === "/api/v1/mobile/pair") return {paired: true};
    if (path === "/api/v1/health") return {status: "ok", appVersion: "0.2.0-dev.20261013", apiVersion: "offline", modelStatus: model.installed ? "offline-model-imported" : "offline-extractive", indexStatus: "ready"};
    if (path === "/api/v1/preferences") return method === "PUT" ? {item: await preferences(JSON.parse(options.body || "{}"))} : {item: await preferences()};
    if (path === "/api/v1/runtime/status") {
      await refreshNativeStatus();
      await refreshNativeModels();
      const docs = await documents();
      return {model: {status: model.installed ? (nativeInference ? "llama-cpp-available" : "offline-model-imported") : "offline-extractive", name: model.name || "手机离线检索", quantization: "本地文件", runtime: nativeInference ? "llama.cpp Android JNI" : "Android OfflineRuntime", loaded: false, nativeInference, activeModelId: model.activeModelId}, chatModel: {name: model.chatModelName || "0.8B 普通问答模型", nativeInference, loaded: false}, modelRoutingNotice: model.modelRoutingNotice, modelDownload: {enabled: false, modelInstalled: model.installed, state: model.installed ? "installed" : "idle", modelDirectory: "Android 应用私有存储 · models"}, rag: {ready: true, chunkCount: docs.reduce((sum, item) => sum + (item.chunks?.length || 0), 0)}, documentCount: docs.length, models};
    }
    if (path === "/api/v1/conversations") return {items: await conversationList()};
    if (path.startsWith("/api/v1/conversations/")) return {item: await conversation(decodeURIComponent(path.split("/").pop()))};
    if (path === "/api/v1/documents") return {items: await documents()};
    if (path.startsWith("/api/v1/documents/") && method === "DELETE") return removeDocument(decodeURIComponent(path.split("/").pop()));
    if (path === "/api/v1/workspace/export") return exportWorkspace();
    if (path === "/api/v1/models") { await refreshNativeModels(); return {items: models}; }
    const modelDownloadMatch = path.match(/^\/api\/v1\/models\/([^/]+)\/download$/);
    if (modelDownloadMatch && method === "POST") return {item: await downloadModel(decodeURIComponent(modelDownloadMatch[1]), JSON.parse(options.body || "{}").sourceId || "modelscope")};
    const modelActivateMatch = path.match(/^\/api\/v1\/models\/([^/]+)\/activate$/);
    if (modelActivateMatch && method === "POST") return {item: await activateModel(decodeURIComponent(modelActivateMatch[1]))};
    if (path.includes("/model/download")) return {item: {enabled: false, modelInstalled: model.installed, state: "unavailable", modelDirectory: "Android 应用私有存储 · models"}};
    if (path.startsWith("/api/v1/presentations") || path.startsWith("/api/v1/ppt-patches")) return ppt.request(path,options);
    throw new Error("该功能需要连接电脑端服务");
  }

  return {start, request, importFile, answer, pickModel, downloadModel, activateModel, ppt, get model() { return model; }};
}
