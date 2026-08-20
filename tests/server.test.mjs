import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.mjs";

async function withServer(run) {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health endpoint reports a ready local demo", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.modelStatus, "demo-ready");
  });
});

test("chat stream returns citations, token chunks and metrics", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "精准 RAG 为什么适合边缘设备？", ragEnabled: true })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: citations/);
    assert.match(body, /event: token/);
    assert.match(body, /event: metrics/);
    assert.match(body, /event: done/);
    assert.match(body, /引用提取模块/);
  });
});

test("imported text is available to subsequent local retrieval", async () => {
  await withServer(async (baseUrl) => {
    const importResponse = await fetch(`${baseUrl}/api/v1/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试通知.md", content: "中期检查材料需要在周五前提交，并附上实验记录。" })
    });
    assert.equal(importResponse.status, 201);

    const chatResponse = await fetch(`${baseUrl}/api/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "中期检查材料什么时候提交？", ragEnabled: true })
    });
    const body = await chatResponse.text();
    assert.match(body, /测试通知.md/);
    assert.match(body, /周五前提交/);
  });
});
