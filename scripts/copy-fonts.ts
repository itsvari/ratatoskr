import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";

const fontDirectory = "admin/public/_fonts";
const stagingDirectory = "admin/.font-staging";
mkdirSync(fontDirectory, { recursive: true });
mkdirSync(stagingDirectory, { recursive: true });
for (const [source, name] of [
  ["node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "inter.woff2"],
  ["node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", "jetbrains-mono.woff2"],
] as const) {
  const temporary = `${stagingDirectory}/${crypto.randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, `${fontDirectory}/${name}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}
