/**
 * Reproduction test: model "default" combo routing to pollinations.
 *
 * The "default" combo has strategy "auto" with candidatePool: ["gemini"] and
 * models only gemini/gemma-*-*, but sometimes the auto strategy selects
 * pollinations. Run this several times — the bug appears sporadically
 * on the 2nd-3rd call.
 */
import test from "node:test";
import assert from "node:assert/strict";

const API_KEY = process.env.OMNIROUTE_API_KEY;
const BASE_URL = process.env.OMNIROUTE_URL || "http://localhost:20128";

const skip = !API_KEY ? "OMNIROUTE_API_KEY not set" : undefined;

test("model 'default' must never route to pollinations", { skip }, async (t) => {
  for (let round = 0; round < 5; round++) {
    // Query call logs for pollinations BEFORE this round
    const beforeRes = await fetch(`${BASE_URL}/api/logs?limit=50&search=pollinations`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }).catch(() => null);
    const beforeData = beforeRes?.ok ? await beforeRes.json() : { logs: [] };
    const beforeLogs = beforeData.logs || beforeData.rows || [];
    const beforeDefault = beforeLogs.filter(
      (l: any) => l.comboName === "default" && l.provider === "pollinations"
    ).length;

    // Send 3 requests with model "default" sequentially
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Say hello in 3 words" }],
          max_tokens: 20,
          stream: true,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        console.log(
          `[round ${round + 1}, req ${i + 1}] HTTP ${res.status}: ${errText.substring(0, 100)}`
        );
      } else {
        console.log(`[round ${round + 1}, req ${i + 1}] HTTP 200 OK`);
      }
    }

    // Check call logs for pollinations+default entries created in this round
    const afterRes = await fetch(`${BASE_URL}/api/logs?limit=50&search=pollinations`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }).catch(() => null);

    if (!afterRes?.ok) continue;

    const afterData = await afterRes.json();
    const afterLogs = afterData.logs || afterData.rows || [];
    const afterDefault = afterLogs.filter(
      (l: any) => l.comboName === "default" && l.provider === "pollinations"
    ).length;

    const newLeaks = afterDefault - beforeDefault;

    assert.equal(
      newLeaks,
      0,
      `Round ${round + 1}: ${newLeaks} new pollinations+default entries found! ` +
        `Details: ${JSON.stringify(
          afterLogs
            .filter((l: any) => l.comboName === "default" && l.provider === "pollinations")
            .slice(0, 3)
            .map((l: any) => ({
              id: l.id,
              model: l.model,
              status: l.status,
              comboStepId: l.comboStepId,
            }))
        )}`
    );
  }
});
