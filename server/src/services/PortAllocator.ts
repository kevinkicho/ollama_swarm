import net from "node:net";

export class PortAllocator {
  private reserved = new Set<number>();

  async allocate(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = await this.probe();
      if (!this.reserved.has(port)) {
        this.reserved.add(port);
        return port;
      }
    }
    throw new Error("Could not find a free port after 20 attempts");
  }

  release(port: number): void {
    this.reserved.delete(port);
  }

  private probe(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close();
          reject(new Error("Failed to read ephemeral port"));
        }
      });
    });
  }
}
