import { NOTE_NAMES_15, NOTE_NAMES_21 } from '../core/converter';

interface MidiNote {
  note: number;
  tick: number;
  endTick: number;
  time?: number;
}

interface Tempo {
  tick: number;
  microsecondsPerBeat: number;
  elapsedMs?: number;
}

interface ParsedMidi {
  format: number;
  ticksPerBeat: number;
  notes: MidiNote[];
  tempos: Tempo[];
}

export function midiToSkyStudio(
  bytes: Uint8Array,
  name: string,
  keyCount: 15 | 21,
  octaveShift: number,
  quantize: number
): { json: string; notes: number; skipped: number; bpm: number } {
  const parsed = parseMidi(bytes);
  const names = keyCount === 21 ? NOTE_NAMES_21 : NOTE_NAMES_15;
  const grouped = new Map<number, Set<string>>();
  let skipped = 0;
  for (const note of parsed.notes) {
    const target = naturalMidiName(note.note + octaveShift * 12);
    if (!target || !names.includes(target as never)) {
      skipped += 1;
      continue;
    }
    const time = Math.max(0, Math.round((note.time ?? 0) / quantize) * quantize);
    if (!grouped.has(time)) grouped.set(time, new Set());
    grouped.get(time)?.add(target);
  }
  const songNotes: Array<{ time: number; key: string }> = [];
  [...grouped.keys()].sort((a, b) => a - b).forEach((time) => {
    [...(grouped.get(time) ?? [])].sort((a, b) => names.indexOf(a as never) - names.indexOf(b as never)).forEach((note) => {
      songNotes.push({ time, key: `1Key${names.indexOf(note as never)}` });
    });
  });
  const firstTempo = parsed.tempos[0]?.microsecondsPerBeat ?? 500_000;
  const bpm = Math.max(1, Math.round(60_000_000 / firstTempo));
  return {
    json: JSON.stringify({
      name: name.replace(/\.(mid|midi)$/i, ''),
      author: '',
      transcribedBy: 'SkyForce MIDI',
      isComposed: true,
      bpm,
      bitsPerPage: 16,
      pitchLevel: octaveShift,
      isEncrypted: false,
      keyMode: keyCount,
      songNotes
    }, null, 2),
    notes: songNotes.length,
    skipped,
    bpm
  };
}

function parseMidi(bytes: Uint8Array): ParsedMidi {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const header = readChunk(view, offset);
  if (header.id !== 'MThd' || header.length < 6) throw new Error('不是有效的 MIDI 文件');
  offset = header.next;
  const format = view.getUint16(header.start);
  const trackCount = view.getUint16(header.start + 2);
  const division = view.getUint16(header.start + 4);
  if ((division & 0x8000) !== 0) throw new Error('暂不支持 SMPTE 时间格式 MIDI');
  const ticksPerBeat = division || 480;
  const tempos: Tempo[] = [{ tick: 0, microsecondsPerBeat: 500_000 }];
  const notes: MidiNote[] = [];

  for (let track = 0; track < trackCount && offset + 8 <= view.byteLength; track += 1) {
    const chunk = readChunk(view, offset);
    offset = chunk.next;
    if (chunk.id !== 'MTrk') continue;
    notes.push(...parseTrack(view, chunk.start, chunk.start + chunk.length, tempos));
  }
  if (!notes.length) throw new Error('MIDI 中没有音符事件');
  tempos.sort((a, b) => a.tick - b.tick);
  const normalized = normalizeTempos(tempos, ticksPerBeat);
  notes.forEach((note) => {
    note.time = tickToMs(note.tick, normalized, ticksPerBeat);
  });
  notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
  return { format, ticksPerBeat, notes, tempos: normalized };
}

function parseTrack(view: DataView, start: number, end: number, tempos: Tempo[]): MidiNote[] {
  let offset = start;
  let tick = 0;
  let runningStatus = 0;
  const active = new Map<string, MidiNote[]>();
  const notes: MidiNote[] = [];
  while (offset < end) {
    const delta = readVariable(view, offset, end);
    tick += delta.value;
    offset = delta.next;
    if (offset >= end) break;
    let status = view.getUint8(offset);
    if (status < 0x80) {
      if (!runningStatus) throw new Error('MIDI 运行状态异常');
      status = runningStatus;
    } else {
      offset += 1;
      if (status < 0xf0) runningStatus = status;
    }
    if (status === 0xff) {
      const type = view.getUint8(offset++);
      const length = readVariable(view, offset, end);
      offset = length.next;
      if (type === 0x51 && length.value === 3) {
        tempos.push({
          tick,
          microsecondsPerBeat:
            (view.getUint8(offset) << 16) |
            (view.getUint8(offset + 1) << 8) |
            view.getUint8(offset + 2)
        });
      }
      offset += length.value;
      if (type === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const length = readVariable(view, offset, end);
      offset = length.next + length.value;
      continue;
    }
    const type = status & 0xf0;
    const channel = status & 0x0f;
    const twoBytes = type !== 0xc0 && type !== 0xd0;
    if (offset >= end || (twoBytes && offset + 1 >= end)) break;
    const data1 = view.getUint8(offset);
    const data2 = twoBytes ? view.getUint8(offset + 1) : 0;
    offset += twoBytes ? 2 : 1;
    const key = `${channel}:${data1}`;
    if (type === 0x90 && data2 > 0) {
      if (!active.has(key)) active.set(key, []);
      active.get(key)?.push({ note: data1, tick, endTick: tick + 1 });
    } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
      const stack = active.get(key);
      const note = stack?.shift();
      if (note) {
        note.endTick = Math.max(note.tick + 1, tick);
        notes.push(note);
      }
      if (stack && !stack.length) active.delete(key);
    }
  }
  active.forEach((stack) => stack.forEach((note) => {
    note.endTick = Math.max(note.tick + 1, tick);
    notes.push(note);
  }));
  return notes;
}

function normalizeTempos(tempos: Tempo[], ticksPerBeat: number): Tempo[] {
  const unique: Tempo[] = [];
  tempos.forEach((tempo) => {
    const previous = unique[unique.length - 1];
    if (previous?.tick === tempo.tick) unique[unique.length - 1] = { ...tempo };
    else unique.push({ ...tempo });
  });
  let elapsed = 0;
  unique.forEach((tempo, index) => {
    const previous = unique[index - 1];
    if (previous) {
      elapsed += (tempo.tick - previous.tick) * previous.microsecondsPerBeat / ticksPerBeat / 1000;
    }
    tempo.elapsedMs = elapsed;
  });
  return unique;
}

function tickToMs(tick: number, tempos: Tempo[], ticksPerBeat: number): number {
  let tempo = tempos[0]!;
  for (const candidate of tempos.slice(1)) {
    if (candidate.tick > tick) break;
    tempo = candidate;
  }
  return Math.round((tempo.elapsedMs ?? 0) +
    (tick - tempo.tick) * tempo.microsecondsPerBeat / ticksPerBeat / 1000);
}

function readChunk(view: DataView, offset: number) {
  if (offset + 8 > view.byteLength) throw new Error('MIDI Chunk 不完整');
  const id = String.fromCharCode(...Array.from({ length: 4 }, (_, index) => view.getUint8(offset + index)));
  const length = view.getUint32(offset + 4);
  const start = offset + 8;
  const next = start + length;
  if (next > view.byteLength) throw new Error('MIDI Chunk 长度异常');
  return { id, length, start, next };
}

function readVariable(view: DataView, offset: number, end: number) {
  let value = 0;
  let cursor = offset;
  for (let index = 0; index < 4 && cursor < end; index += 1) {
    const byte = view.getUint8(cursor++);
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: cursor };
  }
  throw new Error('MIDI 可变长度字段异常');
}

function naturalMidiName(number: number): string {
  const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const name = names[((number % 12) + 12) % 12] ?? '';
  if (name.includes('#')) return '';
  return `${name}${Math.floor(number / 12) - 1}`;
}
