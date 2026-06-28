import test from "node:test";
import assert from "node:assert/strict";

import { getExecutor } from "../../open-sse/executors/index.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";

test("getExecutor('openai') returns a DefaultExecutor with provider='openai'", async () => {
  const exec = await getExecutor("openai");

  assert.ok(exec instanceof DefaultExecutor, "should be a DefaultExecutor");
  assert.equal(
    exec.getProvider(),
    "openai",
    `expected provider "openai" but got ${exec.getProvider()}`
  );
});

test("getExecutor('gemini') returns a DefaultExecutor with provider='gemini'", async () => {
  const exec = await getExecutor("gemini");

  assert.ok(exec instanceof DefaultExecutor, "should be a DefaultExecutor");
  assert.equal(
    exec.getProvider(),
    "gemini",
    `expected provider "gemini" but got ${exec.getProvider()}`
  );
});

test("getExecutor with unsupported provider falls to DefaultExecutor with correct provider", async () => {
  const PROVIDER = "openai-compatible-myapi";
  const exec = await getExecutor(PROVIDER);

  assert.ok(exec instanceof DefaultExecutor, "should be a DefaultExecutor");
  assert.equal(
    exec.getProvider(),
    PROVIDER,
    `expected provider "${PROVIDER}" but got ${exec.getProvider()}`
  );
});
