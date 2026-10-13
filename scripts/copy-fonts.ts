import { copyFileSync, mkdirSync } from "node:fs";

const fontDirectory = "admin/public/_fonts";
mkdirSync(fontDirectory, { recursive: true });
copyFileSync("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", `${fontDirectory}/inter.woff2`);
copyFileSync("node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", `${fontDirectory}/jetbrains-mono.woff2`);
