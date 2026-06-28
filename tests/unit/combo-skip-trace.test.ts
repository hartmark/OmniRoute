import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-skip-trace-"));
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
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");

test.after(() => {
  db.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("combo with circuit breaker open returns 502 without upstream calls", async (t) => {
  let fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fetchCalls.push(body.model);
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

  // Open the circuit breaker for gemini BEFORE the request
  const cb = getCircuitBreaker("gemini");
  // Record enough failures to open the breaker
  for (let i = 0; i < 10; i++) {
    cb._onFailure();
  }
  assert.equal(cb.getStatus().state, "OPEN", "Circuit breaker should be OPEN");

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

    const { handleChat } = await import("../../src/sse/handlers/chat.ts");
    const res = await handleChat(req, null, JSON.parse(body));

    console.log("Response status:", res.status);
    console.log("Fetch calls:", fetchCalls.length);
    console.log("Fetch models:", fetchCalls);

    // Check call logs
    const logs = await callLogs.getCallLogs({ limit: 10 });
    const comboLogs = logs.filter((l: any) => l.comboName === "default");
    console.log("\nCall logs with combo_name 'default':");
    for (const l of comboLogs) {
      console.log(`  ${l.status} ${l.provider} ${l.model} stepId=${l.comboStepId}`);
    }

    // The combo should return 503 because all targets are skipped by circuit breaker
    assert.ok(
      res.status === 502 || res.status === 503,
      `Should return 502/503 when circuit breaker is open, got ${res.status}`
    );

    // No upstream calls should have been made
    assert.equal(
      fetchCalls.length,
      0,
      "Should not make any upstream calls when circuit breaker is open"
    );

    // No pollinations entries
    const pollLogs = logs.filter((l: any) => l.provider === "pollinations");
    assert.equal(pollLogs.length, 0, `Expected 0 pollinations entries, got ${pollLogs.length}`);

    // The 502/503 should be logged with combo_name "default"
    const failLogs = comboLogs.filter((l: any) => l.status === 502 || l.status === 503);
    assert.ok(failLogs.length > 0, "Should have a 502/503 entry in call logs");
  } finally {
    globalThis.fetch = originalFetch;
    // Reset the circuit breaker
    cb._onSuccess();
    cb._onSuccess();
    cb._onSuccess();
  }
});

test("combo with circuit breaker open should not fall through to pollinations", async (t) => {
  let fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fetchCalls.push(body.model);
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

  // Open the circuit breaker for gemini
  const cb = getCircuitBreaker("gemini");
  for (let i = 0; i < 10; i++) {
    cb._onFailure();
  }

  try {
    // Send 5 requests rapidly (like the live test does)
    for (let i = 0; i < 5; i++) {
      const body = JSON.stringify({
        model: "default",
        messages: [{ role: "user", content: `request ${i}` }],
        max_tokens: 10,
        stream: false,
      });
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

      const { handleChat } = await import("../../src/sse/handlers/chat.ts");
      const res = await handleChat(req, null, JSON.parse(body));
      console.log(`Request ${i}: status=${res.status}`);
    }

    // Check call logs
    const logs = await callLogs.getCallLogs({ limit: 20 });

    // No pollinations entries should exist
    const pollLogs = logs.filter((l: any) => l.provider === "pollinations");
    assert.equal(
      pollLogs.length,
      0,
      `Expected 0 pollinations entries, got ${pollLogs.length}. Entries: ${JSON.stringify(pollLogs.map((l: any) => ({ id: l.id, model: l.model, status: l.status })))}`
    );

    // All entries should be either 502/503 (combo failure) or 200 (success)
    const comboLogs = logs.filter((l: any) => l.comboName === "default");
    for (const l of comboLogs) {
      assert.ok(
        l.status === 502 || l.status === 503 || l.status === 200,
        `Unexpected status ${l.status} for combo entry`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    cb._onSuccess();
    cb._onSuccess();
    cb._onSuccess();
  }
});
