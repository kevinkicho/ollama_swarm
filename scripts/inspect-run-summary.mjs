import http from "node:http";
const cwd = process.cwd();
const q = "runId=f3290ac3-aed2-47ad-9095-f943302a14db&clonePath=" + encodeURIComponent(cwd);
http.get("http://127.0.0.1:8243/api/swarm/run-summary?" + q , (r) => {
  let d = "";
  r.on("data", c => d += c);
  r.on("end", () => {
    try {
      const j = JSON.parse(d);
      console.log("STATUS:", r.statusCode);
      console.log("keys:", Object.keys(j));
      console.log("preset:", j.preset, "stopReason:", j.stopReason);
      console.log("top-level hybrid flags:", j.useHybridPlanning, j.planningPreset);
      console.log("runConfig present:", !!j.runConfig);
      if (j.runConfig) {
        console.log("runConfig.hybrid:", j.runConfig.useHybridPlanning, j.runConfig.planningPreset);
      }
      console.log("transcript sample[0]:", j.transcript && j.transcript[0] && j.transcript[0].text);
    } catch (e) {
      console.log("parse err, raw head:", d.slice(0,400));
    }
  });
}).on("error", console.error);