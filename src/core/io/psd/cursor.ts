// Bounds-checked big-endian read cursor for PSD/PSB parsing.
// All multi-byte values in the format are big-endian; every read validates the
// remaining byte count and throws 'PSD 文件已截断' on overrun. Ported from the
// Swift implementation's PSDCursor.

export class Cursor {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos: number;
  readonly end: number;

  constructor(data: ArrayBuffer | Uint8Array, start = 0, end?: number) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
    this.pos = start;
    this.end = Math.min(end ?? this.bytes.length, this.bytes.length);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (n < 0 || this.end - this.pos < n) throw new Error('PSD 文件已截断');
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  seekTo(p: number): void {
    if (p < 0 || p > this.end) throw new Error('PSD 文件已截断');
    this.pos = p;
  }

  /** Zero-copy sub-cursor windowed onto [start, start+length) of this cursor. */
  sub(start: number, length: number): Cursor {
    if (start < 0 || length < 0 || start > this.end) throw new Error('PSD 文件已截断');
    const len = Math.min(length, this.end - start);
    return new Cursor(this.bytes.subarray(start, start + len));
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const hi = this.view.getUint32(this.pos);
    const lo = this.view.getUint32(this.pos + 4);
    this.pos += 8;
    const v = hi * 4294967296 + lo;
    if (v > Number.MAX_SAFE_INTEGER) throw new Error('PSD 文件已截断');
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  ascii(n: number): string {
    this.need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i));
    this.pos += n;
    return s;
  }

  slice(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}
