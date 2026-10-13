import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {RELEASE_FILES, stageReleaseAssets} from "../scripts/stage-release-assets.mjs";

test("release app shell excludes unrelated pages, models, and user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "edge-office-release-"));
  try {
    for (const file of RELEASE_FILES) {
      const path = join(root, "public", file);
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, "asset");
    }
    for (const file of ["private.html", "test.gguf", "history.db"]) {
      await writeFile(join(root, "public", file), "private");
    }
    const target = await stageReleaseAssets(root);
    await writeFile(join(target, "stale-private.html"), "stale");
    await stageReleaseAssets(root);
    const names = await readdir(target);
    for (const file of ["private.html", "test.gguf", "history.db", "stale-private.html"]) assert.ok(!names.includes(file));
    assert.equal(await readFile(join(root, "public", "private.html"), "utf8"), "private");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
