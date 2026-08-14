import type { MountPoint } from "@/proto/clouddrive_pb";

export type LocalPathMatch = {
  mountPoint: MountPoint;
  localTarget: string;
  localDirectory: string;
};

function normalizeCloudPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!normalized || normalized === "/") return "/";
  return `/${normalized.replace(/^\/+|\/+$/g, "")}`;
}

function isCloudPathWithin(path: string, parent: string): boolean {
  return parent === "/" ? path.startsWith("/") : path === parent || path.startsWith(`${parent}/`);
}

function joinWindowsPath(root: string, parts: string[]): string {
  const cleanRoot = root.replace(/[\\/]+$/g, "");
  return parts.length > 0 ? `${cleanRoot}\\${parts.join("\\")}` : cleanRoot;
}

function getWindowsParent(path: string): string {
  const normalized = path.replace(/[\\/]+$/g, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 2 ? normalized.slice(0, index) : normalized;
}

export function mapCloudPathToLocal(
  cloudPath: string,
  isDirectory: boolean,
  mountPoints: MountPoint[],
): LocalPathMatch | undefined {
  const normalizedPath = normalizeCloudPath(cloudPath);
  const match = mountPoints
    // CloudDrive2 returns `localMount = false` for ordinary Windows drive-letter
    // mounts (for example Z: -> /115open).  `isMounted` and a non-empty target
    // are the authoritative signals that the path can be opened locally.
    .filter((point) => point.isMounted && point.mountPoint)
    .map((point) => ({ point, sourceDir: normalizeCloudPath(point.sourceDir || "/") }))
    .filter(({ sourceDir }) => isCloudPathWithin(normalizedPath, sourceDir))
    .sort((left, right) => right.sourceDir.length - left.sourceDir.length)[0];
  if (!match) return undefined;
  const relative = normalizedPath.slice(match.sourceDir === "/" ? 1 : match.sourceDir.length).replace(/^\/+/, "");
  const localTarget = joinWindowsPath(match.point.mountPoint, relative ? relative.split("/").filter(Boolean) : []);
  return {
    mountPoint: match.point,
    localTarget,
    localDirectory: isDirectory ? localTarget : getWindowsParent(localTarget),
  };
}
