import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-trace-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const db = core.getDbInstance();

const providers = await import("../../src/lib/db/providers.ts");
await providers.createProviderConnection({
  id: "gemini-conn",
  provider: "gemini",
  type: "apikey",
  credentials: { apiKey: "sk-gemini" },
  isActive: true,
});

const { createCombo } = await import("../../src/lib/db/combos.ts");
await createCombo({
  name: "default",
  strategy: "auto",
  models: [
    { id: "gm1", kind: "model", model: "gemini/gemma-4-31b-it", providerId: "gemini", weight: 0 },
    {
      id: "gm2",
      kind: "model",
      model: "gemini/gemma-4-26b-a4b-it",
      providerId: "gemini",
      weight: 0,
    },
  ],
  config: { candidatePool: ["gemini"], routerStrategy: "lkgp", explorationRate: 0 },
  sortOrder: 1,
});

const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");

test.after(() => {
  db.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("trace combo target resolution for model 'default'", async (t) => {
  let fetchCalls: Array<{ url: string; body: any; status: number }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const entry = { url: String(url), body, status: 200 };
    fetchCalls.push(entry);
    return new Response(
      JSON.stringify({
        id: "resp-ok",
        object: "chat.completion",
        model: body.model || "unknown",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ) as any;
  };

  try {
    const body = JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      stream: false,
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });

    const res = await handleChat(req, null, JSON.parse(body));
    const text = await res.text();

    console.log("Response status:", res.status);
    console.log("Fetch calls:", fetchCalls.length);
    for (const c of fetchCalls) {
      console.log("  -> model:", c.body.model, "url:", c.url.substring(0, 80));
    }

    // Check call logs
    const logs = await callLogs.getCallLogs({ limit: 20 });
    const comboLogs = logs.filter((l: any) => l.comboName === "default");
    console.log("\nCall logs with combo_name 'default':");
    for (const l of comboLogs) {
      console.log(`  ${l.status} ${l.provider} ${l.model} stepId=${l.comboStepId}`);
    }

    // The combo should have tried gemini and succeeded
    assert.ok(fetchCalls.length > 0, "Should have made at least one upstream call");
    assert.ok(
      fetchCalls.every((c) => c.body.model?.includes("gemma")),
      `All upstream calls should be to gemini models, got: ${fetchCalls.map((c) => c.body.model).join(", ")}`
    );

    // No pollinations entries should exist
    const pollLogs = logs.filter((l: any) => l.provider === "pollinations");
    assert.equal(pollLogs.length, 0, `Expected 0 pollinations entries, got ${pollLogs.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trace combo with failing gemini - should return error, not fall through", async (t) => {
  let fetchCalls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async (url: string | URL | Request, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fetchCalls.push({ url: String(url), body });
    callCount++;
    // Return 500 for gemini calls
    return new Response(JSON.stringify({ error: { message: "internal server error" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }) as any;
  };

  try {
    const body = JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      stream: false,
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });

    const res = await handleChat(req, null, JSON.parse(body));

    console.log("\nFailing gemini test:");
    console.log("Response status:", res.status);
    console.log("Fetch calls:", fetchCalls.length);
    for (const c of fetchCalls) {
      console.log("  -> model:", c.body.model);
    }

    // Check call logs
    const logs = await callLogs.getCallLogs({ limit: 20 });
    const comboLogs = logs.filter((l: any) => l.comboName === "default");
    console.log("Call logs:");
    for (const l of comboLogs) {
      console.log(`  ${l.status} ${l.provider} ${l.model} stepId=${l.comboStepId}`);
    }

    // The combo should have tried gemini (both targets) and failed
    assert.ok(fetchCalls.length > 0, "Should have tried at least one gemini target");
    assert.ok(
      fetchCalls.every((c) => c.body.model?.includes("gemma")),
      `All upstream calls should be to gemini, got: ${fetchCalls.map((c) => c.body.model).join(", ")}`
    );

    // No pollinations entries
    const pollLogs = logs.filter((l: any) => l.provider === "pollinations");
    assert.equal(pollLogs.length, 0, `Expected 0 pollinations entries, got ${pollLogs.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
