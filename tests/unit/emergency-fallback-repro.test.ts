import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Response as NodeResponse } from "node-fetch";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-efb-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_EMERGENCY_FALLBACK = "true";

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
await providers.createProviderConnection({
  id: "pol-conn",
  provider: "pollinations",
  type: "apikey",
  credentials: { apiKey: "sk-pol" },
  isActive: true,
});
await providers.createProviderConnection({
  id: "nvidia-conn",
  provider: "nvidia",
  type: "apikey",
  credentials: { apiKey: "sk-nvidia" },
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

const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

test.after(() => {
  db.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("emergency fallback from gemini routes to configured model, not pollinations", async (t) => {
  let requestCount = 0;
  const requests: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url: string | URL | Request, init?: any) => {
    const bodyStr = typeof init?.body === "string" ? init.body : null;
    const body = bodyStr ? JSON.parse(bodyStr) : {};
    requests.push({ url: String(url), body });
    requestCount++;

    console.error(`[FETCH ${requestCount}] model=${body.model} url=${String(url)}`);

    // Return budget error for gemini, succeed for everything else
    if (body.model?.includes("gemma") || body.model?.includes("gemini")) {
      return new Response(
        JSON.stringify({ error: { message: "insufficient funds on this account" } }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      ) as unknown as NodeResponse;
    }

    return new Response(
      JSON.stringify({
        id: "resp-ok",
        object: "chat.completion",
        model: body.model || "unknown",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ) as unknown as NodeResponse;
  };

  try {
    const body = JSON.stringify({
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
      stream: false,
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    const res = await handleChat(req, null, JSON.parse(body));
    const text = await res.text();

    console.error(`\nResponse: ${res.status} ${text.substring(0, 150)}`);
    console.error(`Total fetch calls: ${requestCount}`);
    for (const r of requests) {
      console.error(`  -> ${r.body.model}`);
    }

    const logs = await callLogs.getCallLogs({ limit: 30 });
    const pollLogs = logs.filter((l: any) => l.provider === "pollinations");
    const geminiLogs = logs.filter((l: any) => l.provider === "gemini");
    const nvidiaLogs = logs.filter((l: any) => l.provider?.includes("nvidia"));

    console.error(`\nGemini entries: ${geminiLogs.length}`);
    console.error(`Nvidia entries: ${nvidiaLogs.length}`);
    console.error(`Pollinations entries: ${pollLogs.length}`);
    for (const l of pollLogs) {
      console.error(
        `  poll: comboName=${l.comboName} isCombo=${l.comboName === "default"} status=${l.status}`
      );
    }

    // The emergency fallback should route to nvidia/openai-gpt-oss-120b (the default config)
    // NOT to pollinations. If pollinations appears, the fallthrough is a bug.
    assert.equal(
      pollLogs.length,
      0,
      `Emergency fallback routed to pollinations instead of nvidia! ` +
        `Requests made: ${requests.map((r) => r.body.model).join(", ")}`
    );

    // The combo should try gemini first, then fall back to nvidia, NOT pollinations
    const geminiFailCount = geminiLogs.filter((l: any) => l.status >= 400).length;
    assert.ok(geminiFailCount > 0, "Expected at least one failed gemini request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
