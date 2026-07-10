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
for (const file of walk(root)) {
  let c = fs.readFileSync(file, "utf8");
  if (!c.includes("import { apiFetch }")) continue;
  const broken = /import \{\s*\nimport \{ apiFetch \} from "[^"]+";\s*\n/;
  if (!broken.test(c)) continue;
  c = c.replace(broken, "import {\n");
  if (!/^import \{ apiFetch \}/m.test(c)) {
    const relDir = path.relative(root, path.dirname(file));
    const ups = relDir === "" ? 0 : relDir.split(path.sep).filter(Boolean).length;
    const imp = ups === 0 ? "./lib/apiFetch" : "../".repeat(ups) + "lib/apiFetch";
    // after last import
    const lines = c.split("\n");
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s/.test(lines[i])) last = i;
    }
    lines.splice(last + 1, 0, `import { apiFetch } from "${imp}";`);
    c = lines.join("\n");
  }
  fs.writeFileSync(file, c);
  console.log("fixed", path.relative(root, file));
}
