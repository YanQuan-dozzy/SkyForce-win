import { describe, expect, it } from 'vitest';
import {
  convertContent,
  NOTE_NAMES_15,
  parseAutoJs,
  parseSkyStudioText,
  renderAutoJs,
  renderSkyStudioText
} from '../src/core/converter';
import type { ScoreDocument, ScriptTemplate } from '../src/shared/types';

const encoder = new TextEncoder();

function jsonBytes(notes: Array<{ time: number; key: string }>, bpm = 300): Uint8Array {
  return encoder.encode(JSON.stringify({
    name: '测试',
    bpm,
    songNotes: notes
  }));
}

function semantic(document: ScoreDocument) {
  return document.groups.map((group) => ({
    keys: group.keys,
    interval: group.interval
  }));
}

describe('SkyStudio parser', () => {
  it('groups chords and removes only the initial delay', () => {
    const document = parseSkyStudioText(jsonBytes([
      { time: 500, key: '2Key0' },
      { time: 500, key: '2Key4' },
      { time: 700, key: '1Key7' },
      { time: 1100, key: '1Key14' }
    ]), 'song.txt');

    expect(document.bpm).toBe(300);
    expect(document.groups).toEqual([
      { keys: [1, 5], interval: 0 },
      { keys: [8], interval: 200 },
      { keys: [15], interval: 400 }
    ]);
  });

  it('accepts UTF-16LE output and preserves notes', () => {
    const original: ScoreDocument = {
      bpm: 300,
      noteTime: 200,
      isJson: true,
      name: 'roundtrip',
      groups: [
        { keys: [1, 5, 8], interval: 0 },
        { keys: [15], interval: 400 }
      ]
    };
    const encoded = renderSkyStudioText(original);
    expect(encoded[0]).toBe(0xff);
    expect(encoded[1]).toBe(0xfe);
    expect(semantic(parseSkyStudioText(encoded))).toEqual(semantic(original));
  });

  it('parses ABC chords and dot intervals', () => {
    const abc = '<DontCopyThisLine> 300 0 16\n. . A1A5 . B3 . . C5';
    const document = parseSkyStudioText(encoder.encode(abc), 'abc.txt');
    expect(document.groups).toEqual([
      { keys: [1, 5], interval: 0 },
      { keys: [8], interval: 200 },
      { keys: [15], interval: 400 }
    ]);
  });
});

describe('AutoJS templates', () => {
  const source: ScoreDocument = {
    bpm: 300,
    noteTime: 200,
    isJson: true,
    name: 'template',
    groups: [
      { keys: [1, 5], interval: 0 },
      { keys: [8], interval: 200 },
      { keys: [2, 9, 15], interval: 400 },
      { keys: [3], interval: 800 }
    ]
  };

  for (const template of ['press', 'press_new', 'long_press'] as ScriptTemplate[]) {
    it(`round-trips ${template} without losing keys or timing`, () => {
      const js = renderAutoJs(source, template);
      const parsed = parseAutoJs(js, 'source.js', template);
      expect(semantic(parsed)).toEqual(semantic(source));
    });
  }

  it('auto-detects templates', () => {
    for (const template of ['press', 'press_new', 'long_press'] as ScriptTemplate[]) {
      const parsed = parseAutoJs(renderAutoJs(source, template), 'source.js', 'auto');
      expect(semantic(parsed)).toEqual(semantic(source));
    }
  });

  it('parses score-editor object rows', () => {
    const js = `
      var time=200;
      var score = [
        { keys: ["c4", "g4"], sleep: 0 },
        { keys: ["c5"], sleep: 400 }
      ];
    `;
    expect(parseAutoJs(js).groups).toEqual([
      { keys: [1, 5], interval: 0 },
      { keys: [8], interval: 400 }
    ]);
  });

  it('does not skip the first JSON notes in gesture templates', () => {
    const notes = Array.from({ length: 1075 }, (_, index) => ({
      time: index * 200,
      key: `1Key${index % NOTE_NAMES_15.length}`
    }));
    const input = jsonBytes(notes);
    for (const template of ['press_new', 'long_press'] as ScriptTemplate[]) {
      const output = convertContent(input, 'large.txt', {
        mode: 'txt-to-js',
        template
      });
      expect(output.noteCount).toBe(1075);
      const back = parseAutoJs(new TextDecoder().decode(output.bytes), 'large.js', template);
      expect(back.groups.reduce((sum, group) => sum + group.keys.length, 0)).toBe(1075);
    }
  });
});
