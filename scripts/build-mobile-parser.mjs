import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const vendorDir = resolve(publicDir, "vendor");
await mkdir(vendorDir, {recursive: true});
await Promise.all([
  copyFile(resolve(root, "node_modules/pdfjs-dist/build/pdf.min.mjs"), resolve(vendorDir, "pdf.min.mjs")),
  copyFile(resolve(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), resolve(vendorDir, "pdf.worker.min.mjs")),
]);
const workerPath = resolve(vendorDir, "pdf.worker.min.mjs");
const worker = await readFile(workerPath, "utf8");
const compatibility = [
  'if(!Uint8Array.prototype.toHex)Object.defineProperty(Uint8Array.prototype,"toHex",{value(){return Array.from(this,b=>b.toString(16).padStart(2,"0")).join("")}});',
  'if(!Uint8Array.prototype.toBase64)Object.defineProperty(Uint8Array.prototype,"toBase64",{value(){let s="";for(let i=0;i<this.length;i+=8192)s+=String.fromCharCode(...this.subarray(i,i+8192));return btoa(s)}});',
  'if(!Uint8Array.fromBase64)Object.defineProperty(Uint8Array,"fromBase64",{value(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}});',
].join("\n") + "\n";
await writeFile(workerPath, compatibility + worker);
await build({
  entryPoints: [resolve(publicDir, "mobile-document-parser.source.js")],
  outfile: resolve(publicDir, "mobile-document-parser.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["./vendor/pdf.min.mjs"],
  minify: true,
  legalComments: "none",
});
await build({entryPoints:[resolve(publicDir, "mobile-ppt.source.js")], outfile:resolve(publicDir, "mobile-ppt.js"),
  bundle:true, format:"esm", platform:"browser", target:"es2022", minify:true, legalComments:"none"});
