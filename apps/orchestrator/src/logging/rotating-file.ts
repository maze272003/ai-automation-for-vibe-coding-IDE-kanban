import fs from 'node:fs';
import path from 'node:path';

export interface RotatingFileOptions {
  file: string;
  maxBytes: number;
  keep: number;
  transform?: (chunk: string) => string;
}

/** Synchronous size-rotated log file: file, file.1 … file.<keep>. */
export class RotatingFile {
  private readonly opts: RotatingFileOptions;
  private fd: number;
  private size: number;

  constructor(opts: RotatingFileOptions) {
    this.opts = opts;
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    this.fd = fs.openSync(opts.file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  write(chunk: string): boolean {
    const text = this.opts.transform ? this.opts.transform(chunk) : chunk;
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.opts.maxBytes) this.rotate();
    fs.writeSync(this.fd, text);
    this.size += bytes;
    return true;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private rotate(): void {
    const { file, keep } = this.opts;
    fs.closeSync(this.fd);
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
    this.fd = fs.openSync(file, 'a');
    this.size = 0;
  }
}
