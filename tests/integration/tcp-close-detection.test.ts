/**
 * TCP close / upstream disconnect detection integration tests.
 *
 * Verifies that the stream pipeline (pipeWithDisconnect, createDisconnectAwareStream)
 * detects upstream TCP connection drops and handles them gracefully instead of hanging
 * until the global stall timeout.
 *
 * Run with:  node --import tsx/esm --test --test-concurrency=1  tests/integration/tcp-close-detection.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fakeUpstreamStream } from "../helpers/fakeUpstreamStream.ts";
import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.ts";

/** Drain a ReadableStream to a string; rejects after timeoutMs. */
async function drain(out: ReadableStream, timeoutMs = 5000): Promise<string> {
  const r = out.getReader();
  const dec = new TextDecoder();
  let s = "";
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`drain timeout after ${timeoutMs}ms`)), timeoutMs)
  );
  const read = async () => {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      s += dec.decode(value);
    }
    return s;
  };
  return Promise.race([read(), timeout]);
}

/** A passthrough TransformStream that just forwards bytes unchanged. */
function passthroughTransform(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
    },
  });
}

/**
 * Wrap a controller method to detect it was called.
 * Keeps the original behaviour intact.
 */
function watchMethod<T extends (...args: never[]) => unknown>(
  obj: Record<string, unknown>,
  name: string,
  onCall: T
): void {
  const orig = obj[name] as (...args: unknown[]) => unknown;
  obj[name] = (...args: unknown[]) => {
    onCall(...(args as never[]));
    return orig?.call(obj, ...args);
  };
}

// ─── Scenario 1: Upstream errors mid-stream (simulates TCP RST) ────────────

test("1. TCP RST mid-stream is detected and produces SSE error chunks", async () => {
  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const sc = createStreamController({
    provider: "gemini",
    model: "gemini-2.5-pro",
    clientResponseFormat: "openai",
  });

  let errorCalled = false;
  watchMethod(sc, "handleError", () => {
    errorCalled = true;
  });

  const result = pipeWithDisconnect(response, passthroughTransform(), sc);

  // Push one valid Gemini-style SSE chunk
  up.push('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n');
  await new Promise((r) => setTimeout(r, 10));

  // Simulate TCP RST — error the upstream body stream
  up.error(new Error("socket hang up"));

  // Read all output — must not hang
  const reader = result.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  } catch {
    // Some error propagation paths throw rather than producing {done:true}
  }

  const output = chunks.join("");
  assert.ok(output.includes("Hello"), `expected 'Hello' in output: ${JSON.stringify(output)}`);

  // The pipeline must indicate an error — either handleError was called or
  // the output carries finish_reason/error chunks (from buildStreamErrorChunks).
  assert.ok(
    errorCalled || output.includes("finish_reason") || output.includes("error"),
    `TCP RST was not detected. handleError=${errorCalled} output=${JSON.stringify(output)}`
  );
});

// ─── Scenario 2: Upstream closes cleanly without [DONE] (simulates TCP FIN) ──

test("2. TCP FIN mid-stream completes gracefully (no hang)", async () => {
  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
  let completeCalled = false;
  watchMethod(sc, "handleComplete", () => {
    completeCalled = true;
  });

  const result = pipeWithDisconnect(response, passthroughTransform(), sc);

  up.push('data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n');
  await new Promise((r) => setTimeout(r, 10));

  // Simulate TCP FIN — close the stream cleanly but without [DONE]
  up.close();

  const text = await drain(result, 3000);
  assert.ok(text.includes("Partial"), `expected 'Partial' in output: ${JSON.stringify(text)}`);
  assert.ok(completeCalled, "handleComplete must be called on clean close");
});

// ─── Scenario 3: Stall watchdog fires when upstream goes silent mid-stream ──

test("3. stall watchdog detects silent upstream and errors the stream", async () => {
  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
  let errorCalled = false;
  watchMethod(sc, "handleError", () => {
    errorCalled = true;
  });

  // Very short stall timeout so the test completes quickly
  const result = pipeWithDisconnect(response, passthroughTransform(), sc, {
    stallTimeoutMs: 100,
  });

  up.push('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n');
  await new Promise((r) => setTimeout(r, 10));

  // Don't push more data — the watchdog should fire after stallTimeoutMs
  try {
    await drain(result, 2000);
  } catch {
    // drain timeout is acceptable; the watchdog fires independently
  }

  await new Promise((r) => setTimeout(r, 200));
  assert.ok(errorCalled, "handleError must be called by stall watchdog");
});

// ─── Scenario 4: Client disconnect propagates ──────────────────────────────

test("4. client cancel triggers handleDisconnect", async () => {
  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
  let disconnectCalled = false;
  watchMethod(sc, "handleDisconnect", () => {
    disconnectCalled = true;
  });

  const result = pipeWithDisconnect(response, passthroughTransform(), sc);

  up.push('data: {"candidates":[{"content":{"parts":[{"text":"Data"}]}}]}\n\n');
  await new Promise((r) => setTimeout(r, 10));

  // Cancel the result stream (simulating client disconnect)
  const reader = result.getReader();
  await reader.cancel("client-abort");
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(disconnectCalled, "handleDisconnect must be called on cancel");
});

// ─── Scenario 5: Real HTTP server — TCP RST mid-stream ─────────────────────

test("5. real HTTP server TCP reset mid-stream is detected by fetch + pipeline", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    // Send one valid SSE event then destroy the socket (TCP RST)
    res.write('data: {"candidates":[{"content":{"parts":[{"text":"Hello from server"}]}}]}\n\n');
    setTimeout(() => {
      _req.socket.destroy();
    }, 50);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const fetchResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }),
    });

    const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
    let errorCalled = false;
    watchMethod(sc, "handleError", () => {
      errorCalled = true;
    });

    const result = pipeWithDisconnect(fetchResponse, passthroughTransform(), sc);

    const reader = result.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    } catch {
      // socket destroy propagates as a stream error
    }

    const output = chunks.join("");
    assert.ok(
      output.includes("Hello from server"),
      `expected 'Hello from server' in output: ${JSON.stringify(output)}`
    );

    // The TCP reset MUST be detected — either handleError called or error chunks in output
    if (!errorCalled && !output.includes("error") && !output.includes("finish_reason")) {
      assert.fail(
        `TCP reset was not detected as an error. handleError=${errorCalled} output=${JSON.stringify(output)}`
      );
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ─── Scenario 6: Real HTTP server — idle after one event (half-open TCP) ───

test("6. real HTTP server idle mid-stream triggers stall watchdog and aborts fetch", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });

    // Send one SSE event, then never close the socket and never send more data.
    // This simulates a half-open TCP connection where the server has gone silent.
    res.write('data: {"candidates":[{"content":{"parts":[{"text":"Only me"}]}}]}\n\n');
    // Intentionally never call res.end() or req.socket.destroy()
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const abortController = new AbortController();
    const fetchResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }),
      signal: abortController.signal,
    });

    const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });

    // Connect the stream controller's abort to the fetch abort so the stall
    // watchdog can kill the stuck connection (mirrors what chatCore.ts does
    // by passing streamController.signal to the executor).
    sc.abort = () => {
      abortController.abort();
    };

    let errorCalled = false;
    watchMethod(sc, "handleError", () => {
      errorCalled = true;
    });

    // Short stall timeout for the test
    const result = pipeWithDisconnect(fetchResponse, passthroughTransform(), sc, {
      stallTimeoutMs: 200,
    });

    // Read until the watchdog fires or the stream ends
    const reader = result.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    } catch {
      // watchdog may cause a stream error
    }

    // Wait for watchdog to have had time to fire
    await new Promise((r) => setTimeout(r, 300));

    const output = chunks.join("");
    assert.ok(
      output.includes("Only me"),
      `expected 'Only me' in output: ${JSON.stringify(output)}`
    );

    // The stall watchdog MUST have fired — without it the stream would still be
    // open waiting for data from the half-open TCP connection.
    assert.ok(
      errorCalled ||
        output.includes("error") ||
        output.includes("finish_reason") ||
        output.includes("stall"),
      `Stall watchdog did not fire for idle upstream. errorCalled=${errorCalled} output=${JSON.stringify(output)}`
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ─── Scenario 7: ensureStreamReadiness handoff + mid-stream close ──────────

test("7. ensureStreamReadiness handoff handles mid-stream close without hanging", async () => {
  const { ensureStreamReadiness } = await import("../../open-sse/utils/streamReadiness.ts");

  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  // ensureStreamReadiness reads the first chunk and hands off the reader
  const readyPromise = ensureStreamReadiness(response, {
    timeoutMs: 5000,
    provider: "gemini",
    model: "gemini-2.5-pro",
  });

  up.push('data: {"candidates":[{"content":{"parts":[{"text":"First chunk"}]}}]}\n\n');
  const readiness = await readyPromise;
  assert.ok(readiness.ok, "ensureStreamReadiness must confirm readiness");

  // Close the upstream after handoff (simulates TCP close right after readiness)
  up.close();

  const providerResponse = (readiness as { ok: true; response: Response }).response;
  const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
  let completeCalled = false;
  watchMethod(sc, "handleComplete", () => {
    completeCalled = true;
  });

  const result = pipeWithDisconnect(providerResponse, passthroughTransform(), sc);

  // Must drain within timeout — proves the handed-off reader didn't hang
  const text = await drain(result, 5000);
  assert.ok(
    text.includes("First chunk"),
    `expected 'First chunk' in output: ${JSON.stringify(text)}`
  );
  assert.ok(completeCalled, "stream must complete after TCP close during handoff");
});

// ─── Scenario 8: Rapid back-to-back SSE events followed by close ───────────

test("8. multiple SSE events then TCP close does not lose data or hang", async () => {
  const up = fakeUpstreamStream();
  const response = new Response(up.stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const sc = createStreamController({ provider: "gemini", model: "gemini-2.5-pro" });
  let completeCalled = false;
  watchMethod(sc, "handleComplete", () => {
    completeCalled = true;
  });

  const result = pipeWithDisconnect(response, passthroughTransform(), sc);

  // Simulate multiple SSE events followed by abrupt TCP close
  for (let i = 0; i < 5; i++) {
    up.push(`data: {"candidates":[{"content":{"parts":[{"text":"Chunk ${i}"}]}}]}\n\n`);
  }
  await new Promise((r) => setTimeout(r, 10));

  // Simulate TCP FIN after all events
  up.close();

  const text = await drain(result, 3000);
  for (let i = 0; i < 5; i++) {
    assert.ok(
      text.includes(`Chunk ${i}`),
      `expected 'Chunk ${i}' in output: ${JSON.stringify(text)}`
    );
  }
  assert.ok(completeCalled, "handleComplete must be called after all events and close");
});
