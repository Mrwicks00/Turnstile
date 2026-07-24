// Copies non-.ts assets that tsc doesn't touch into dist/, mirroring source layout.
// Plain Node script (not TypeScript) so it can run standalone before/without a build.
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function copyDirFiles(srcDir, destDir, pattern) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (pattern.test(name)) {
      copyFileSync(join(srcDir, name), join(destDir, name));
    }
  }
}

copyDirFiles(join(ROOT, "test/fixtures"), join(ROOT, "dist/test/fixtures"), /\.json$/);
copyDirFiles(join(ROOT, "public"), join(ROOT, "dist/public"), /\.html$/);

mkdirSync(join(ROOT, "dist/public"), { recursive: true });
copyFileSync(join(ROOT, "node_modules/gsap/dist/gsap.min.js"), join(ROOT, "dist/public/gsap.min.js"));

const fontsDest = join(ROOT, "dist/public/fonts");
mkdirSync(fontsDest, { recursive: true });
const fonts = [
  "node_modules/@fontsource/space-mono/files/space-mono-latin-400-normal.woff2",
  "node_modules/@fontsource/space-mono/files/space-mono-latin-700-normal.woff2",
  "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2",
  "node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2",
];
for (const f of fonts) {
  copyFileSync(join(ROOT, f), join(fontsDest, f.split("/").pop()));
}

console.log("Assets copied to dist/.");
