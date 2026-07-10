import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const path = join(dirname(fileURLToPath(import.meta.url)), "../src/swarm/StigmergyRunner.ts");
let src = readFileSync(path, "utf8");
const aStart = src.indexOf("  private applyAnnotation(ann: ParsedAnnotation): void {");
const rStart = src.indexOf("  /** #303: optional transform applied");
if (aStart < 0 || rStart < 0) throw new Error(`markers ${aStart} ${rStart}`);
const thin = `  private applyAnnotation(ann: ParsedAnnotation): void {
    applyAnnotationExtracted(this.pheromoneHost(), ann, {
      onHighInterest: (file, interest) => {
        void this.spreadCrossClusterPheromones(file, interest);
      },
    });
  }

  private async spreadCrossClusterPheromones(
    seedFile: string,
    seedInterest: number,
  ): Promise<void> {
    await spreadCrossClusterPheromonesExtracted(
      this.pheromoneHost(),
      seedFile,
      seedInterest,
    );
  }

`;
src = src.slice(0, aStart) + thin + src.slice(rStart);
writeFileSync(path, src);
console.log("lines", src.split("\n").length);
