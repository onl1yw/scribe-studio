import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/vendor", { recursive: true });
for (const [from, to] of [
  ["mediabunny/dist/bundles/mediabunny.min.mjs", "mediabunny.mjs"],
  ["mediabunny/LICENSE", "mediabunny.LICENSE"],
  ["fflate/esm/browser.js", "fflate.mjs"],
  ["fflate/LICENSE", "fflate.LICENSE"],
])
  await copyFile("node_modules/" + from, "dist/vendor/" + to);
await copyFile(
  "node_modules/@fontsource/doto/files/doto-latin-700-normal.woff2",
  "dist/vendor/doto.woff2",
);
await copyFile(
  "node_modules/@fontsource/doto/LICENSE",
  "dist/vendor/doto.LICENSE",
);
await mkdir("dist/vendor/lucide", { recursive: true });
for (const name of [
  "plus",
  "eye",
  "eye-off",
  "x",
  "arrow-up-right",
  "download",
  "audio-lines",
]) {
  await copyFile(
    `node_modules/lucide-static/icons/${name}.svg`,
    `dist/vendor/lucide/${name}.svg`,
  );
}
await copyFile(
  "node_modules/lucide-static/LICENSE",
  "dist/vendor/lucide.LICENSE",
);
await copyFile(
  "node_modules/lucide-static/icons/audio-lines.svg",
  "dist/icon.svg",
);
