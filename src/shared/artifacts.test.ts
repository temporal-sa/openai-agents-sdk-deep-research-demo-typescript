import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactPath,
  artifactPublicPath,
  resolveArtifactPublicPath,
} from "../artifacts.js";

test("artifact paths are rooted and public paths are portable", () => {
  const publicPath = artifactPublicPath("reports", "report.pdf");
  assert.equal(publicPath, "artifacts/reports/report.pdf");
  assert.equal(
    resolveArtifactPublicPath(publicPath),
    artifactPath("reports", "report.pdf"),
  );
});

test("artifact filenames cannot escape their kind directory", () => {
  assert.equal(
    artifactPublicPath("images", "../../outside.png"),
    "artifacts/images/outside.png",
  );
  assert.throws(
    () => resolveArtifactPublicPath("artifacts/images/nested/outside.png"),
    /Invalid artifact path/,
  );
  assert.throws(
    () => resolveArtifactPublicPath("../artifacts/images/outside.png"),
    /Invalid artifact path/,
  );
});
