import { promises as fs } from "node:fs";
import path from "node:path";

// Tmp-file + rename so a crash mid-write leaves the original file intact.
// fs.rename replaces the target on both POSIX and Windows (Node >=14), so
// callers don't need to pre-delete. Parent directories are created if the
// caller names a file in a fresh subtree.
export async function writeFileAtomic(abs: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.swarm-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
