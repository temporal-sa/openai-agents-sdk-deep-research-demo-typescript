import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundleWorkflowCode } from "@temporalio/worker";

test("interactive research workflow bundles for the Temporal sandbox", async () => {
  const workflowPath = fileURLToPath(
    new URL("./interactive-research-workflow.js", import.meta.url),
  );
  const bundle = await bundleWorkflowCode({ workflowsPath: workflowPath });
  assert.ok(bundle.code.length > 0);
});
