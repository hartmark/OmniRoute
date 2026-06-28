import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderConnections } from "../../src/lib/db/providers.ts";

describe("Direct API key verification", async () => {
  const connections = await getProviderConnections({ authType: "apikey" });
  const providersToCheck = ["openrouter", "nvidia", "gemini", "mistral"];

  for (const providerId of providersToCheck) {
    const conn = connections.find((c: any) => c.provider === providerId);
    if (!conn) {
      it(`${providerId} - SKIP`, () => {});
      continue;
    }

    it(`${providerId} - API key is valid (direct, no proxy)`, async () => {
      const apiKey = (conn as any).apiKey;
      assert.ok(apiKey, "API key must be present");

      const prefix = apiKey.slice(0, Math.min(20, apiKey.length));
      const suffix = apiKey.slice(-4);

      console.log(`\n=== ${providerId} ===`);
      console.log(`key prefix: "${prefix}...", suffix: "...${suffix}", length: ${apiKey.length}`);

      let url: string;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "OmniRoute-Test/1.0",
      };

      switch (providerId) {
        case "openrouter":
          headers["Authorization"] = `Bearer ${apiKey}`;
          url = "https://openrouter.ai/api/v1/chat/completions";
          break;
        case "nvidia":
          headers["Authorization"] = `Bearer ${apiKey}`;
          url = "https://api.nvcf.nvidia.com/v1/chat/completions";
          break;
        case "gemini":
          url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
          break;
        case "mistral":
          headers["Authorization"] = `Bearer ${apiKey}`;
          url = "https://api.mistral.ai/v1/chat/completions";
          break;
        default:
          throw new Error("unknown provider");
      }

      console.log(`requesting: POST ${url.slice(0, 60)}...`);

      const body =
        providerId === "gemini"
          ? JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "hi" }] }],
              generationConfig: { maxOutputTokens: 1 },
            })
          : JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 1,
            });

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        console.log(`response status: ${response.status}`);
        console.log(`response headers:`, Object.fromEntries(response.headers.entries()));
        console.log(`response body: ${body.slice(0, 500)}`);
        throw new Error(`${providerId} returned ${response.status}`);
      }

      const result = (await response.json()) as any;
      console.log(`SUCCESS: ${JSON.stringify(result).slice(0, 200)}`);
    });
  }
});
