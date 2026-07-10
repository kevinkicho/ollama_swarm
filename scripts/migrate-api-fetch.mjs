/**
 * One-shot: replace fetch(.../api/...) with apiFetch in web/src and add imports.
 */
import fs from "node:fs";
import path from "node:path";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const root = path.resolve("web/src");
const files = walk(root);
let changed = 0;

for (const file of files) {
  if (file.endsWith(`apiFetch.ts`)) continue;
  let c = fs.readFileSync(file, "utf8");
  if (!c.includes("fetch(") || !c.includes("/api/")) continue;

  const orig = c;
  // Replace fetch( only when the call targets /api/
  c = c.replace(/\bfetch\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g, (full, arg) => {
    if (arg.includes("/api/")) return `apiFetch(${arg}`;
    return full;
  });
  // Templates that start with `/api/` after interpolation start
  c = c.replace(/\bfetch\s*\(\s*`(\/api\/)/g, "apiFetch(`$1");

  if (c === orig) continue;

  if (!/from ["'].*lib\/apiFetch["']/.test(c)) {
    const relDir = path.relative(root, path.dirname(file));
    const ups = relDir === "" ? 0 : relDir.split(path.sep).filter(Boolean).length;
    const imp = ups === 0 ? "./lib/apiFetch" : "../".repeat(ups) + "lib/apiFetch";
    const lines = c.split("\n");
    let lastImp = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s/.test(lines[i])) lastImp = i;
    }
    if (lastImp >= 0) {
      lines.splice(lastImp + 1, 0, `import { apiFetch } from "${imp}";`);
      c = lines.join("\n");
    } else {
      c = `import { apiFetch } from "${imp}";\n` + c;
    }
  }

  fs.writeFileSync(file, c);
  changed++;
  console.log("updated", path.relative(root, file));
}
console.log("changed", changed);
