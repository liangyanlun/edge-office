import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const rootDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(rootDir, "public");

const seedDocuments = [
  {
    id: "doc-overview",
    name: "项目综述（内置）",
    source: "立项申请摘要",
    locator: "项目综述",
    builtin: true,
    content:
      "本项目面向日常办公场景，研究并实现一套高效实用的轻量级智能对话系统。系统通过深度蒸馏获得轻量语言内核，再通过精准 RAG 外脑补充本地知识，适合个人电脑和离线终端。"
  },
  {
    id: "doc-goals",
    name: "研究目标与性能指标（内置）",
    source: "立项申请摘要",
    locator: "研究目的",
    builtin: true,
    content:
      "项目目标是在参数量减少 90% 以上的前提下，在办公对话任务中保持较高性能，任务完成准确率和指令遵循度损失不超过 5%。系统面向 CPU 与资源受限环境，目标首 token 响应延迟小于 500ms，整体运行内存小于 1GB。"
  },
  {
    id: "doc-rag",
    name: "精准 RAG 机制（内置）",
    source: "立项申请摘要",
    locator: "研究内容 4",
    builtin: true,
    content:
      "精准化 RAG 先从本地知识库检索候选信息，再通过引用提取模块从长文档中定位最相关的 1 到 2 个句子。它避免把整段文档直接输入小模型，从而减少上下文开销，提升回答的事实性和专业性。"
  },
  {
    id: "doc-roadmap",
    name: "实施路线（内置）",
    source: "立项申请摘要",
    locator: "研究路线",
    builtin: true,
    content:
      "实施路线分为基础构建与蒸馏实验、RAG 增强与协同设计、边缘适配与深度优化、系统集成与综合验证四个阶段。最终交付可交互应用原型、技术报告、评测结果与可复现实验材料。"
  }
];

const state = {
  documents: structuredClone(seedDocuments),
  conversations: [],
  startedAt: Date.now()
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, 404, { error: { code: "NOT_FOUND", message: "未找到请求的资源" } });
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求体必须是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function tokens(text) {
  const normalized = String(text ?? "").toLowerCase();
  const output = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
  for (const phrase of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    output.add(phrase);
    for (let index = 0; index < phrase.length - 1; index += 1) output.add(phrase.slice(index, index + 2));
  }
  return output;
}

function splitSentences(content) {
  return String(content)
    .split(/[。！？\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function retrieve(query) {
  const queryTokens = tokens(query);
  const candidates = [];
  for (const document of state.documents) {
    for (const sentence of splitSentences(document.content)) {
      const sentenceTokens = tokens(sentence);
      let score = 0;
      for (const token of queryTokens) {
        if (sentenceTokens.has(token)) score += token.length > 2 ? 3 : 1;
      }
      if (score > 0) {
        candidates.push({
          id: `${document.id}-${candidates.length + 1}`,
          documentId: document.id,
          fileName: document.name,
          locator: document.locator,
          quote: sentence,
          score: Math.min(0.99, 0.52 + score / 18)
        });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 2);
}

function answerFor(question, evidence, ragEnabled) {
  if (!ragEnabled) {
    return "当前处于无知识库演示模式。真实系统会交由本地轻量模型生成；本原型为了保证可复现，只展示不带外部证据的基础回答。";
  }
  if (!evidence.length) {
    return "我暂未在当前本地知识库中找到足够可靠的依据。你可以换一种问法，或导入相关的 TXT / Markdown 材料后再试。";
  }

  const text = question.toLowerCase();
  let opening = "根据当前本地知识库，相关结论如下：";
  if (text.includes("创新")) opening = "项目的核心创新可以概括为“轻量内核 + 精准外脑”：";
  if (text.includes("性能") || text.includes("延迟") || text.includes("内存") || text.includes("压缩")) {
    opening = "该项目把性能目标拆成模型压缩、响应延迟和资源占用三个维度：";
  }
  if (text.includes("rag") || text.includes("检索") || text.includes("知识库")) {
    opening = "RAG 在本项目中的作用，是让轻量模型基于本地证据回答：";
  }

  const bullets = evidence.map((item, index) => `• ${item.quote}【${index + 1}】`);
  return `${opening}\n\n${bullets.join("\n")}\n\n这是一条由本地规则检索和流式接口驱动的初步 demo 回答；接入真实模型后，回答组织方式会由模型替换，但引用与指标接口保持不变。`;
}

function memoryMb() {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

function findConversation(id) {
  return state.conversations.find((item) => item.id === id);
}

function newConversation() {
  const conversation = {
    id: randomUUID(),
    title: "新对话",
    createdAt: new Date().toISOString(),
    messages: []
  };
  state.conversations.unshift(conversation);
  return conversation;
}

async function streamChat(req, res) {
  const payload = await readJson(req);
  const question = String(payload.message ?? "").trim();
  if (!question) return json(res, 400, { error: { code: "EMPTY_MESSAGE", message: "请输入问题" } });

  const conversation = payload.conversationId ? findConversation(payload.conversationId) : newConversation();
  if (!conversation) return json(res, 404, { error: { code: "CONVERSATION_NOT_FOUND", message: "会话不存在" } });

  const requestId = randomUUID();
  const beganAt = performance.now();
  conversation.messages.push({ id: randomUUID(), role: "user", content: question, createdAt: new Date().toISOString() });
  if (conversation.title === "新对话") conversation.title = question.slice(0, 16);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  let closed = false;
  res.on("close", () => {
    if (!res.writableEnded) closed = true;
  });

  sendEvent(res, "meta", { requestId, conversationId: conversation.id, model: "edge-demo-rules-v1", mode: "local-demo" });
  sendEvent(res, "stage", { name: "retrieval", label: "正在检索本地知识库" });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const retrievalStarted = performance.now();
  const ragEnabled = payload.ragEnabled !== false;
  const evidence = ragEnabled ? retrieve(question) : [];
  const retrievalMs = Math.round(performance.now() - retrievalStarted);
  if (evidence.length) sendEvent(res, "citations", { items: evidence });
  sendEvent(res, "stage", { name: "generation", label: "正在生成可追溯回答" });

  const answer = answerFor(question, evidence, ragEnabled);
  const chunks = answer.match(/.{1,7}/gu) ?? [answer];
  const firstTokenAt = performance.now();
  let emitted = "";
  for (const chunk of chunks) {
    if (closed || res.writableEnded) break;
    sendEvent(res, "token", { text: chunk });
    emitted += chunk;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  if (closed || res.writableEnded) return;

  const generationMs = Math.max(1, Math.round(performance.now() - firstTokenAt));
  const metrics = {
    ttftMs: Math.round(firstTokenAt - beganAt),
    retrievalMs,
    generationMs,
    tokensPerSecond: Math.round((Math.max(1, emitted.length / 1.8) / generationMs) * 1000 * 10) / 10,
    peakRssMb: memoryMb()
  };
  conversation.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: emitted,
    citations: evidence,
    metrics,
    createdAt: new Date().toISOString()
  });
  sendEvent(res, "metrics", metrics);
  sendEvent(res, "done", { finishReason: "stop", usage: { inputTokens: Math.ceil(question.length / 1.8), outputTokens: Math.ceil(emitted.length / 1.8) } });
  res.end();
}

async function staticFile(res, fileName, contentType) {
  try {
    const content = await readFile(join(publicDir, fileName));
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(content);
  } catch {
    notFound(res);
  }
}

export function createAppServer() {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") return staticFile(res, "index.html", "text/html; charset=utf-8");
      if (req.method === "GET" && path === "/app.js") return staticFile(res, "app.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && path === "/styles.css") return staticFile(res, "styles.css", "text/css; charset=utf-8");

      if (req.method === "GET" && path === "/api/v1/health") {
        return json(res, 200, { status: "ok", apiVersion: "0.1", modelStatus: "demo-ready", indexStatus: "ready" });
      }
      if (req.method === "GET" && path === "/api/v1/runtime/status") {
        return json(res, 200, {
          model: { name: "edge-demo-rules-v1", quantization: "演示规则引擎", location: "本机 Node.js" },
          resources: { rssMb: memoryMb(), uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000) },
          documentCount: state.documents.length
        });
      }
      if (req.method === "GET" && path === "/api/v1/documents") {
        return json(res, 200, { items: state.documents.map(({ content, ...doc }) => ({ ...doc, characters: content.length })) });
      }
      if (req.method === "POST" && path === "/api/v1/documents") {
        const payload = await readJson(req);
        const name = String(payload.name ?? "未命名材料").trim().slice(0, 100);
        const content = String(payload.content ?? "").trim();
        if (!content) return json(res, 400, { error: { code: "EMPTY_DOCUMENT", message: "文档内容不能为空" } });
        if (content.length > 200_000) return json(res, 400, { error: { code: "DOCUMENT_TOO_LARGE", message: "初步 demo 限制单份文本 200KB" } });
        const document = { id: randomUUID(), name, source: "用户导入", locator: "文本内容", builtin: false, content };
        state.documents.push(document);
        return json(res, 201, { item: { ...document, content: undefined, characters: content.length } });
      }
      if (req.method === "DELETE" && path.startsWith("/api/v1/documents/")) {
        const id = decodeURIComponent(path.split("/").at(-1));
        const index = state.documents.findIndex((item) => item.id === id);
        if (index < 0) return notFound(res);
        if (state.documents[index].builtin) return json(res, 400, { error: { code: "BUILTIN_DOCUMENT", message: "内置材料不能删除" } });
        state.documents.splice(index, 1);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/v1/conversations") {
        return json(res, 200, { items: state.conversations.map(({ messages, ...item }) => ({ ...item, messageCount: messages.length })) });
      }
      if (req.method === "POST" && path === "/api/v1/conversations") return json(res, 201, { item: newConversation() });
      if (req.method === "GET" && path.startsWith("/api/v1/conversations/")) {
        const conversation = findConversation(decodeURIComponent(path.split("/").at(-1)));
        return conversation ? json(res, 200, { item: conversation }) : notFound(res);
      }
      if (req.method === "POST" && path === "/api/v1/chat/stream") return streamChat(req, res);

      return notFound(res);
    } catch (error) {
      if (!res.headersSent) {
        return json(res, 500, { error: { code: "INTERNAL_ERROR", message: error.message || "服务发生异常" } });
      }
      sendEvent(res, "error", { code: "INTERNAL_ERROR", message: "生成过程中发生异常" });
      res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Edge Office demo is running at http://127.0.0.1:${port}`);
  });
}
