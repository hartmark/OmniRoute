import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-guard-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const core = await import("../../src/lib/db/core.ts");

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function buildUpstreamResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function invokeChatCore({
  body,
  provider = "openai",
  model = "gpt-4o-mini",
  comboName = null,
  isCombo = false,
}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => buildUpstreamResponse();
  try {
    await handleChatCore({
      body,
      modelInfo: { provider, model, extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      comboName,
      isCombo,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.after(() => {
  try {
    core.getDbInstance().close();
  } catch {}
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("saveCallLog round-trips comboName correctly", async () => {
  const id1 = "save-combo-test-1";
  await callLogs.saveCallLog({
    id: id1,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "gpt-4o-mini",
    provider: "openai",
    comboName: "test-combo",
    comboStepId: "step-1",
    comboExecutionKey: "exec-1",
    duration: 10,
    tokens: {},
  });
  const row1 = await callLogs.getCallLogById(id1);
  assert.equal(row1?.comboName, "test-combo");

  const id2 = "save-combo-test-2";
  await callLogs.saveCallLog({
    id: id2,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "gpt-4o-mini",
    provider: "openai",
    comboName: null,
    duration: 10,
    tokens: {},
  });
  const row2 = await callLogs.getCallLogById(id2);
  assert.equal(row2?.comboName, null);
});

test("isCombo = false: handleChatCore passes comboName through (stripping is at handleSingleModelChat level)", async () => {
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  };
  await invokeChatCore({ body, comboName: "default", isCombo: false });
  const rows = await callLogs.getCallLogs({ limit: 5 });
  const entry = rows.find((r) => r.model === "gpt-4o-mini");
  assert.ok(entry);
  assert.equal(entry.comboName, "default");
  assert.equal(entry.comboStepId, null);
  assert.equal(entry.comboExecutionKey, null);
});

test("isCombo = true preserves comboName", async () => {
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  };
  await invokeChatCore({ body, comboName: "test-combo", isCombo: true });
  const rows = await callLogs.getCallLogs({ limit: 10 });
  const entry = rows.find((r) => r.comboName === "test-combo" && r.model === "gpt-4o-mini");
  assert.ok(entry, "combo entry should exist");
  assert.equal(entry.comboName, "test-combo");
});

test("state leak: combo then non-combo requests do not leak comboName", async () => {
  await invokeChatCore({
    body: { model: "combo-model", messages: [{ role: "user", content: "hi" }] },
    model: "combo-model",
    comboName: "my-combo",
    isCombo: true,
  });

  await invokeChatCore({
    body: { model: "non-combo-model", messages: [{ role: "user", content: "hi" }] },
    model: "non-combo-model",
    comboName: null,
    isCombo: false,
  });

  await invokeChatCore({
    body: { model: "non-combo-model-2", messages: [{ role: "user", content: "hi" }] },
    model: "non-combo-model-2",
    comboName: null,
    isCombo: false,
  });

  const rows = await callLogs.getCallLogs({ limit: 10 });
  const comboEntry = rows.find((r) => r.model === "combo-model");
  assert.ok(comboEntry);
  assert.equal(comboEntry.comboName, "my-combo");

  const nonCombo1 = rows.find((r) => r.model === "non-combo-model");
  assert.ok(nonCombo1);
  assert.equal(nonCombo1.comboName, null);

  const nonCombo2 = rows.find((r) => r.model === "non-combo-model-2");
  assert.ok(nonCombo2);
  assert.equal(nonCombo2.comboName, null);
});
