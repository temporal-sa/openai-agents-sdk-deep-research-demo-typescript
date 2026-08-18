import path from "node:path";

export type ArtifactKind = "images" | "reports";

export function artifactRoot(): string {
  return path.resolve(process.env.ARTIFACT_ROOT?.trim() || "artifacts");
}

export function artifactDirectory(kind: ArtifactKind): string {
  return path.join(artifactRoot(), kind);
}

export function artifactPath(kind: ArtifactKind, filename: string): string {
  return path.join(artifactDirectory(kind), path.basename(filename));
}

export function artifactPublicPath(
  kind: ArtifactKind,
  filename: string,
): string {
  return path.posix.join("artifacts", kind, path.basename(filename));
}

export function resolveArtifactPublicPath(publicPath: string): string {
  const normalized = publicPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const match = /^artifacts\/(images|reports)\/([^/]+)$/.exec(normalized);
  if (!match?.[1] || !match[2]) {
    throw new Error("Invalid artifact path");
  }
  return artifactPath(match[1] as ArtifactKind, match[2]);
}
