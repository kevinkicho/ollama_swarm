// Tiny module exporting a greet() function.
// The eval task adds an npm script that invokes this module.
export function greet(name) {
  return `hello, ${name}!`;
}

if (process.argv[1]?.endsWith("greeter.js")) {
  // CLI entry: print greeting for the first argv after the script path
  const name = process.argv[2] ?? "world";
  process.stdout.write(greet(name) + "\n");
}
