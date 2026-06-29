import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readExpectedFiles(
  clonePath: string | undefined,
  files: string[],
): Promise<Record<string, string | null>> {
  if (!clonePath) return {};
  const result: Record<string, string | null> = {};
  for (const f of files) {
    try {
      const content = await readFile(resolve(clonePath, f), "utf8");
      result[f] = content;
    } catch {
      result[f] = null;
    }
  }
  return result;
}
