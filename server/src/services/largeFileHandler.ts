import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';

/**
 * Service to handle large files gracefully using streaming and chunking.
 */
export class LargeFileHandler {
  /**
   * Read a large file in chunks and process each chunk.
   * @param filePath - Path to the file.
   * @param chunkSize - Size of each chunk in bytes (default 64KB).
   * @param onChunk - Callback invoked with each chunk (Buffer).
   */
  async readInChunks(
    filePath: string,
    chunkSize: number = 64 * 1024,
    onChunk: (chunk: Buffer) => Promise<void> | void
  ): Promise<void> {
    const readStream = createReadStream(filePath, { highWaterMark: chunkSize });
    for await (const chunk of readStream) {
      await onChunk(chunk);
    }
  }

  /**
   * Write data to a file using a writable stream.
   * @param filePath - Path to the output file.
   * @param data - Data to write (string or Buffer).
   */
  async writeStream(filePath: string, data: string | Buffer): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const writeStream = createWriteStream(filePath);
    writeStream.write(data);
    writeStream.end();
    return new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  }

  /**
   * Copy a large file using streams to avoid memory issues.
   * @param source - Source file path.
   * @param destination - Destination file path.
   */
  async copyFile(source: string, destination: string): Promise<void> {
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const readStream = createReadStream(source);
    const writeStream = createWriteStream(destination);
    await pipeline(readStream, writeStream);
  }

  /**
   * Get file size in bytes.
   */
  getFileSize(filePath: string): number {
    const stats = fs.statSync(filePath);
    return stats.size;
  }
}

export default new LargeFileHandler();
