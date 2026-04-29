// A small module with several console.log calls scattered through it.
// The eval task: produce a JSON report listing every console.log call's
// file path + line number. The fixture's verifier checks the JSON shape.

export function start(config) {
  console.log("startup begin");
  if (!config) {
    console.log("no config — using defaults");
    return;
  }
  console.log(`mode=${config.mode}`);
  doWork(config);
}

function doWork(config) {
  console.log("doWork running");
  for (const item of config.items ?? []) {
    process.stdout.write(`processed ${item}\n`);
  }
  console.log("doWork done");
}

export function shutdown() {
  // intentional: no console.log here so the count is unambiguous
  process.stdout.write("bye\n");
}
