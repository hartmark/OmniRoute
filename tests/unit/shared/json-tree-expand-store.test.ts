import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import useJsonTreeExpandStore from "../../../src/store/jsonTreeExpandStore.ts";

// Regression guard: collapse/expand-level controls share one global,
// localStorage-persisted level across every JSON tree box on the page (see
// JsonTreeExpandControls). Level is 0-indexed to match react-json-view-lite's
// own shouldExpandNode(level) convention: 0 means nothing is expanded.

function reset() {
  useJsonTreeExpandStore.setState({ level: 2 });
}

beforeEach(reset);

test("collapseAll sets level to 0", () => {
  useJsonTreeExpandStore.getState().collapseAll();
  assert.equal(useJsonTreeExpandStore.getState().level, 0);
});

test("expandAll sets level to the max depth", () => {
  useJsonTreeExpandStore.getState().expandAll();
  assert.equal(useJsonTreeExpandStore.getState().level, 64);
});

test("collapseOneLevel decrements by one and clamps at 0", () => {
  const { collapseOneLevel } = useJsonTreeExpandStore.getState();
  collapseOneLevel();
  assert.equal(useJsonTreeExpandStore.getState().level, 1);
  collapseOneLevel();
  assert.equal(useJsonTreeExpandStore.getState().level, 0);
  collapseOneLevel();
  assert.equal(useJsonTreeExpandStore.getState().level, 0);
});

test("expandOneLevel increments by one and clamps at the max", () => {
  useJsonTreeExpandStore.setState({ level: 63 });
  const { expandOneLevel } = useJsonTreeExpandStore.getState();
  expandOneLevel();
  assert.equal(useJsonTreeExpandStore.getState().level, 64);
  expandOneLevel();
  assert.equal(useJsonTreeExpandStore.getState().level, 64);
});
