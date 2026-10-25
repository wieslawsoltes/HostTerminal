import { base64ByteLength, type OutputEvent, type ReplayChunk } from './protocol';

/** A bounded, in-memory tail. It is not a durable terminal screen snapshot. */
export class ReplayBuffer {
  private items: ReplayChunk[] = [];
  private bytes = 0;
  truncated = false;
  constructor(readonly limit = 1024 * 1024, readonly maxChunks = 4096) {}
  append(event: OutputEvent): void {
    const size = base64ByteLength(event.data);
    if (size > this.limit) {
      this.items = [];
      this.bytes = 0;
      this.truncated = true;
      return;
    }
    this.items.push({ data: event.data, seq: event.seq });
    this.bytes += size;
    while (this.bytes > this.limit || this.items.length > this.maxChunks) {
      this.bytes -= base64ByteLength(this.items.shift()!.data);
      this.truncated = true;
    }
  }
  snapshot(): ReplayChunk[] { return this.items.slice(); }
  get size(): number { return this.bytes; }
}
