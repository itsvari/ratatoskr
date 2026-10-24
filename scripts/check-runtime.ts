import { execFileSync } from "node:child_process";

function versionParts(value: string): readonly number[] {
  return value.trim().replace(/^v/, "").split(".").map(Number);
}

const [nodeMajor = 0, nodeMinor = 0, nodePatch = 0] = versionParts(process.versions.node);
const minimumNodeVersions = new Map<number, readonly [number, number]>([
  [22, [23, 4]], [24, [22, 1]], [26, [12, 1]],
]);
const minimumNode = minimumNodeVersions.get(nodeMajor);
if (!(nodeMajor > 26 || (minimumNode && (nodeMinor > minimumNode[0]
  || (nodeMinor === minimumNode[0] && nodePatch >= minimumNode[1]))))) {
  throw new Error("Use patched Node.js 22.23.4, 24.22.1 or 26.12.1 (or a newer supported release). See .node-version.");
}

const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const [bunMajor = 0, bunMinor = 0, bunPatch = 0] = versionParts(bunVersion);
if (!(bunMajor > 1 || (bunMajor === 1 && (bunMinor > 4 || (bunMinor === 4 && bunPatch >= 4))))) {
  throw new Error("Use patched Bun 1.4.4 or later. See .bun-version.");
}

console.log(`Using patched runtimes: Node.js ${process.versions.node}, Bun ${bunVersion}.`);
