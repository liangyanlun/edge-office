import {copyFile, mkdir, lstat, realpath, rm} from "node:fs/promises";
import {dirname, resolve, relative, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";

export const RELEASE_FILES = Object.freeze([
  "index.html", "app.js", "styles.css", "experience.css", "experience.js",
  "offline-runtime.js", "native-bridge.js", "sw.js", "icon.svg",
  "manifest.webmanifest", "mobile-document-parser.js", "mobile-ppt.js",
  "vendor/pdf.min.mjs", "vendor/pdf.worker.min.mjs",
]);

export async function stageReleaseAssets(root) {
  const workspace = await realpath(root);
  const build = resolve(workspace, "build");
  await mkdir(build, {recursive: true});
  if ((await realpath(build)) !== build) throw new Error("Refusing redirected build directory");
  const target = resolve(build, "release-public");
  const within = relative(workspace, target);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Unsafe staging directory");
  const previous = await lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous?.isSymbolicLink()) throw new Error("Refusing redirected app-shell directory");
  // This is the exact, disposable generated app-shell directory, never public/.
  await rm(target, {recursive: true, force: true});
  for (const name of RELEASE_FILES) {
    const source = resolve(workspace, "public", name);
    if ((await lstat(source)).isSymbolicLink()) throw new Error(`Refusing linked release asset: ${name}`);
    const destination = resolve(target, name);
    await mkdir(dirname(destination), {recursive: true});
    await copyFile(source, destination);
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = await stageReleaseAssets(root);
  process.stdout.write(`Staged ${RELEASE_FILES.length} allow-listed app-shell files: ${target}\n`);
}
