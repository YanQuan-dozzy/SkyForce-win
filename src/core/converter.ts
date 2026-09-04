import type {
  ConversionOptions,
  ConversionOutput,
  NoteGroup,
  ScoreDocument,
  ScriptTemplate
} from '../shared/types';

const MS_PER_MINUTE = 60_000;
export const NOTE_NAMES_21 = [
  'c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4',
  'c5', 'd5', 'e5', 'f5', 'g5', 'a5', 'b5',
  'c6', 'd6', 'e6', 'f6', 'g6', 'a6', 'b6'
] as const;
export const NOTE_NAMES_15 = NOTE_NAMES_21.slice(0, 15);

interface JsonNote {
  time: number;
  key: number;
  order: number;
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

export function convertContent(
  input: Uint8Array,
  sourceName: string,
  options: ConversionOptions
): ConversionOutput {
  let document: ScoreDocument;
  if (options.mode === 'txt-to-js') {
    document = parseSkyStudioText(input, sourceName);
  } else {
    const js = decodeUtf8(input);
    document = parseAutoJs(js, sourceName, options.sourceTemplate ?? 'auto');
  }

  if (document.groups.length === 0) {
    throw new ConversionError('没有读取到可转换的音符');
  }

  if (options.mode === 'js-to-txt') {
    const bytes = renderSkyStudioText(document, sourceName);
    return {
      bytes,
      extension: 'txt',
      preview: decodeUtf16Le(bytes).slice(0, 12_000),
      bpm: document.bpm,
      noteCount: countNotes(document.groups),
      groupCount: document.groups.length,
      template: options.template
    };
  }

  const output = renderAutoJs(document, options.template);
  const bytes = new TextEncoder().encode(output);
  return {
    bytes,
    extension: 'js',
    preview: output.slice(0, 12_000),
    bpm: document.bpm,
    noteCount: countNotes(document.groups),
    groupCount: document.groups.length,
    template: options.template
  };
}

export function parseSkyStudioText(
  bytes: Uint8Array,
  sourceName = 'score.txt'
): ScoreDocument {
  if (bytes.byteLength === 0) {
    throw new ConversionError('文件为空');
  }
  const text = decodeScoreBytes(bytes).trim();
  if (!text) throw new ConversionError('文件内容为空');
  if (text.startsWith('<DontCopyThisLine>')) {
    return parseAbc(text, sourceName);
  }
  return parseSkyStudioJson(text, sourceName);
}

export function parseAutoJs(
  js: string,
  sourceName = 'score.js',
  requestedTemplate: ScriptTemplate | 'auto' = 'auto'
): ScoreDocument {
  if (!js.trim()) throw new ConversionError('JS 文件为空');
  const template = requestedTemplate === 'auto' ? detectTemplate(js) : requestedTemplate;
  const noteTime = extractNoteTime(js);
  const editorGroups = parseEditorScore(js);

  let groups: NoteGroup[] | null = null;
  if (editorGroups) {
    groups = editorGroups;
  } else if (template === 'press') {
    groups = parsePressBody(js, noteTime);
  } else {
    groups = parseGestureList(js, noteTime, template);
  }

  if (!groups?.length && requestedTemplate === 'auto') {
    const fallbacks: ScriptTemplate[] = ['press', 'press_new', 'long_press'];
    for (const fallback of fallbacks) {
      if (fallback === template) continue;
      groups = fallback === 'press'
        ? parsePressBody(js, noteTime, false)
        : parseGestureList(js, noteTime, fallback, false);
      if (groups?.length) break;
    }
  }

  if (!groups?.length) {
    throw new ConversionError('无法识别该 AutoJS 脚本的乐谱结构');
  }
  return {
    bpm: Math.max(1, Math.round(MS_PER_MINUTE / noteTime)),
    noteTime,
    isJson: true,
    name: baseName(sourceName),
    groups
  };
}

export function renderAutoJs(document: ScoreDocument, template: ScriptTemplate): string {
  if (template === 'press') return renderPress(document);
  if (template === 'press_new') return renderPressNew(document);
  return renderLongPress(document);
}

export function renderSkyStudioText(
  document: ScoreDocument,
  sourceName = document.name
): Uint8Array {
  let time = 0;
  const songNotes: Array<{ time: number; key: string }> = [];
  for (const group of document.groups) {
    time += Math.max(0, Math.round(group.interval));
    for (const key of group.keys) {
      if (key >= 1 && key <= 21) {
        songNotes.push({ time, key: `1Key${key - 1}` });
      }
    }
  }
  const payload = {
    name: baseName(sourceName) || document.name || 'AutoJS反解析乐谱',
    author: '',
    transcribedBy: 'SkyForce',
    isComposed: true,
    bpm: document.bpm,
    bitsPerPage: 16,
    pitchLevel: 0,
    isEncrypted: false,
    songNotes
  };
  return encodeUtf16Le(JSON.stringify(payload));
}

function parseSkyStudioJson(text: string, sourceName: string): ScoreDocument {
  const payload = unwrapJsonPayload(text);
  const bpm = positiveBpm(payload.bpm);
  const songNotes = Array.isArray(payload.songNotes) ? payload.songNotes : [];
  const events: JsonNote[] = [];
  songNotes.forEach((raw, order) => {
    if (!raw || typeof raw !== 'object') return;
    const row = raw as Record<string, unknown>;
    const time = Number(row.time);
    const keyMatch = String(row.key ?? '').match(/Key(\d+)/i);
    if (!Number.isFinite(time) || !keyMatch) return;
    const keyIndex = Number(keyMatch[1]);
    if (keyIndex < 0 || keyIndex >= 21) return;
    events.push({ time: Math.max(0, Math.round(time)), key: keyIndex + 1, order });
  });
  if (!events.length) throw new ConversionError('JSON 中没有有效的 songNotes');
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  const firstTime = events[0]?.time ?? 0;
  const normalized = events.map((event) => ({ ...event, time: event.time - firstTime }));
  return {
    bpm,
    noteTime: Math.floor(MS_PER_MINUTE / bpm),
    isJson: true,
    name: String(payload.name || baseName(sourceName)),
    groups: groupTimedNotes(normalized)
  };
}

function unwrapJsonPayload(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart < 0 || objectEnd <= objectStart) {
      throw new ConversionError('不是有效的 SkyStudio JSON');
    }
    try {
      value = JSON.parse(text.slice(objectStart, objectEnd + 1));
    } catch {
      throw new ConversionError('SkyStudio JSON 格式错误');
    }
  }
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object') {
    throw new ConversionError('SkyStudio JSON 顶层结构无效');
  }
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.songNotes)) return object;
  for (const candidate of Object.values(object)) {
    if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).songNotes)) {
      return candidate as Record<string, unknown>;
    }
  }
  throw new ConversionError('JSON 中未找到 songNotes');
}

function parseAbc(text: string, sourceName: string): ScoreDocument {
  const firstLineEnd = text.search(/\r?\n/);
  if (firstLineEnd < 0) throw new ConversionError('ABC 谱缺少音符行');
  const header = text.slice(0, firstLineEnd);
  const bpmMatch = header.match(/<DontCopyThisLine>\s+(\d+)/);
  const bpm = positiveBpm(bpmMatch?.[1]);
  const tokens = text.slice(firstLineEnd).trim().split(/\s+/);
  const groups: NoteGroup[] = [];
  let dots = 0;
  let started = false;
  const noteTime = Math.floor(MS_PER_MINUTE / bpm);
  for (const token of tokens) {
    if (token === '.') {
      if (started) dots += 1;
      continue;
    }
    const keys: number[] = [];
    for (let index = 0; index + 1 < token.length; index += 2) {
      const letter = token[index]?.toUpperCase();
      const digit = Number(token[index + 1]);
      if (!letter || letter < 'A' || letter > 'C' || digit < 1 || digit > 5) continue;
      const key = (letter.charCodeAt(0) - 65) * 5 + digit;
      if (key >= 1 && key <= 15) keys.push(key);
    }
    if (!keys.length) continue;
    groups.push({ keys, interval: started ? dots * noteTime : 0 });
    dots = 0;
    started = true;
  }
  if (!groups.length) throw new ConversionError('ABC 谱中没有有效音符');
  return { bpm, noteTime, isJson: false, name: baseName(sourceName), groups };
}

function groupTimedNotes(events: JsonNote[]): NoteGroup[] {
  const groups: Array<{ time: number; keys: number[] }> = [];
  for (const event of events) {
    const previous = groups[groups.length - 1];
    if (previous && previous.time === event.time) {
      previous.keys.push(event.key);
    } else {
      groups.push({ time: event.time, keys: [event.key] });
    }
  }
  let previousTime = 0;
  return groups.map((group, index) => {
    const interval = index === 0 ? Math.max(0, group.time) : Math.max(0, group.time - previousTime);
    previousTime = group.time;
    return { keys: group.keys, interval };
  });
}

function detectTemplate(js: string): ScriptTemplate {
  if (/var\s+score\s*=\s*\[/i.test(js) || /score\s*=\s*\[\s*\{/i.test(js)) return 'press';
  if (/list\s*=\s*\[/i.test(js)) {
    if (/延音模式|volume_up|volume_down/i.test(js)) return 'long_press';
    return 'press_new';
  }
  return 'press';
}

function extractNoteTime(js: string): number {
  const direct = js.match(/\bvar\s+time\s*=\s*(\d+)/i);
  if (direct) return positiveNoteTime(direct[1]);
  const t1 = js.match(/\bt1\s*=\s*(\d+)/i);
  if (t1) return positiveNoteTime(t1[1]);
  const scoreSleeps = [...js.matchAll(/\bsleep\s*:\s*(\d+)/gi)].map((match) => Number(match[1]));
  const positive = scoreSleeps.filter((value) => value > 0).sort((a, b) => a - b);
  return positive[0] || 200;
}

function parsePressBody(js: string, noteTime: number, strict = true): NoteGroup[] | null {
  const startIndex = js.indexOf('start();');
  const body = startIndex >= 0 ? js.slice(startIndex + 'start();'.length) : js;
  const pattern = /\b([a-g][4-6])\s*\(\s*\)\s*;|\bt([124])\s*\(\s*\)\s*;/gi;
  const events: JsonNote[] = [];
  let elapsed = 0;
  let order = 0;
  for (const match of body.matchAll(pattern)) {
    if (match[2]) {
      elapsed += noteTime * Number(match[2]);
      continue;
    }
    const name = String(match[1]).toLowerCase();
    const key = NOTE_NAMES_21.indexOf(name as (typeof NOTE_NAMES_21)[number]) + 1;
    if (key > 0) events.push({ time: elapsed, key, order: order++ });
  }
  if (!events.length) {
    if (strict) throw new ConversionError('按压模板中没有识别到音符调用');
    return null;
  }
  return groupTimedNotes(events);
}

function parseGestureList(
  js: string,
  noteTime: number,
  template: ScriptTemplate,
  strict = true
): NoteGroup[] | null {
  const listMatch = /list\s*=\s*\[/i.exec(js);
  if (!listMatch) {
    if (strict) throw new ConversionError('手势模板中未找到 list');
    return null;
  }
  const bracketStart = (listMatch.index ?? 0) + listMatch[0].lastIndexOf('[');
  const listText = balancedSlice(js, bracketStart, '[', ']');
  if (!listText) {
    if (strict) throw new ConversionError('手势模板 list 括号不完整');
    return null;
  }
  const t0 = numericVariable(js, 't0', noteTime * 2);
  const t1 = numericVariable(js, 't1', noteTime);
  const t2 = numericVariable(js, 't2', noteTime * 4);
  const groups: NoteGroup[] = [];
  const rowPattern = /\[\s*\[([^\]]*)\]\s*,\s*([^,\]]+)\s*,\s*([^\]]+)\]/g;
  for (const row of listText.matchAll(rowPattern)) {
    const keys = [...String(row[1]).matchAll(/\d+/g)]
      .map((match) => Number(match[0]))
      .filter((key) => key >= 1 && key <= 21);
    if (!keys.length) continue;
    const press = evaluateTimeExpression(String(row[2]), { t0, t1, t2, pT: 35 });
    const total = evaluateTimeExpression(String(row[3]), { t0, t1, t2, pT: 35 });
    const interval = template === 'long_press' ? press : total;
    groups.push({ keys, interval: Math.max(0, interval) });
  }
  if (!groups.length) {
    if (strict) throw new ConversionError('手势模板 list 中没有有效音符');
    return null;
  }
  return groups;
}

function parseEditorScore(js: string): NoteGroup[] | null {
  const scoreMatch = /\b(?:var|let|const)\s+score\s*=\s*\[/i.exec(js);
  if (!scoreMatch) return null;
  const start = (scoreMatch.index ?? 0) + scoreMatch[0].lastIndexOf('[');
  const block = balancedSlice(js, start, '[', ']');
  if (!block) return null;
  const rows: NoteGroup[] = [];
  const objectPattern = /\{\s*keys\s*:\s*\[([^\]]*)\]\s*,\s*(?:sleep|interval)\s*:\s*(\d+)\s*\}/gi;
  for (const row of block.matchAll(objectPattern)) {
    const keys = [...String(row[1]).matchAll(/["']([a-g][4-6])["']/gi)]
      .map((match) => NOTE_NAMES_21.indexOf(String(match[1]).toLowerCase() as (typeof NOTE_NAMES_21)[number]) + 1)
      .filter((key) => key > 0);
    if (keys.length) rows.push({ keys, interval: Number(row[2]) });
  }
  if (rows.length) return rows;
  try {
    const parsed = JSON.parse(block) as Array<Record<string, unknown>>;
    for (const item of parsed) {
      const names = Array.isArray(item.keys) ? item.keys : [];
      const keys = names.map((name) =>
        NOTE_NAMES_21.indexOf(String(name).toLowerCase() as (typeof NOTE_NAMES_21)[number]) + 1
      ).filter((key) => key > 0);
      const interval = Number(item.sleep ?? item.interval ?? 0);
      if (keys.length) rows.push({ keys, interval: Math.max(0, interval) });
    }
  } catch {
    return null;
  }
  return rows.length ? rows : null;
}

function renderPress(document: ScoreDocument): string {
  const maxKey = Math.max(...document.groups.flatMap((group) => group.keys));
  const names = maxKey > 15 ? NOTE_NAMES_21 : NOTE_NAMES_15;
  const columns = names.length > 15 ? 7 : 5;
  const x = columns === 7
    ? '[410,680,950,1220,1490,1760,2030]'
    : '[780,975,1170,1365,1560]';
  const y = columns === 7 ? '[980,870,760]' : '[215,410,605]';
  const lines = [
    `var time=${document.noteTime};var time2=${document.noteTime * 2};var time4=${document.noteTime * 4};var pressoffset=18;var pressoffset2=36;var stop=1;var speedControl=1;`,
    `setScreenMetrics(1080,2340);var x=${x};var y=${y};`,
    'function ran(){return Math.random()*pressoffset2-pressoffset;}'
  ];
  names.forEach((name, index) => {
    lines.push(`function ${name}(){press(x[${index % columns}]+ran(),y[${Math.floor(index / columns)}]+ran(),1);}`);
  });
  lines.push(
    'var window=floaty.window(<frame><vertical><button id="btn" text="开始"/><horizontal><button id="speedLow" text="减速" w="80"/><button id="speedHigh" text="加速" w="80"/></horizontal><horizontal><button id="speed" text="1.0x" w="80"/><button id="stop" text="停止" w="80"/></horizontal></vertical></frame>);',
    'window.exitOnClose();',
    "window.btn.click(()=>{if(stop){stop=0;window.btn.setText('暂停');}else{stop=1;window.btn.setText('继续');}});",
    "window.speedHigh.click(()=>{speedControl=(speedControl*10+1)/10;window.speed.setText(speedControl+'x');});",
    "window.speedLow.click(()=>{if(speedControl<=0.1)return;speedControl=(speedControl*10-1)/10;window.speed.setText(speedControl+'x');});",
    "window.speed.click(()=>{speedControl=1;window.speed.setText(speedControl+'x');});",
    'window.stop.click(()=>{engines.stopAll();});',
    'function start(){while(stop){sleep(100);}}',
    'function t1(){while(stop){sleep(100);}sleep(time/speedControl);}',
    'function t2(){while(stop){sleep(100);}sleep(time2/speedControl);}',
    'function t4(){while(stop){sleep(100);}sleep(time4/speedControl);}',
    'start();'
  );
  let body = '';
  for (const group of document.groups) {
    body += intervalCalls(group.interval, document.noteTime);
    for (const key of group.keys) {
      const name = NOTE_NAMES_21[key - 1];
      if (name) body += `${name}();`;
    }
  }
  lines.push(body);
  return `${lines.join('\n')}\n`;
}

function renderPressNew(document: ScoreDocument): string {
  const timing = timingHeader(document.noteTime);
  const rows = document.groups.map((group) =>
    `  [[${group.keys.join(',')}],pT,${intervalExpression(group.interval, document.noteTime)}],`
  );
  return [
    '// SkyForce press_new template',
    timing,
    'let s=1,progressNow=0,speedControl=1,xy=[];',
    'setScreenMetrics(1080,2340);let x=[410,680,950,1220,1490,1760,2030],y=[980,870,760];',
    'for(let i=0;i<21;i++){xy.push(x[i%7],y[parseInt(i/7)]);}',
    'function ran(c){c=c||20;return Math.random()*c-c/2;}',
    'function pre(item){let items=[],keys=item[0],pressTime=item[1],sleepTime=Math.max(0,item[2]-item[1]);for(let id of keys){let px=xy[id*2-2]+ran(),py=xy[id*2-1]+ran();items.push([pressTime/speedControl,[px,py],[px,py]]);}if(items.length)gestures.apply(null,items);sleep(sleepTime/speedControl);}',
    'list = [',
    ...rows,
    '  [[],pT,0],',
    '];',
    'sleep(100);var window=floaty.window(\'<frame><vertical><button id="btn" text="暂停"/><horizontal><button id="speedLow" text="减速" w="80"/><button id="speedHigh" text="加速" w="80"/></horizontal><horizontal><button id="speed" text="x1" w="80"/><button id="stop" text="停止" w="80"/></horizontal><seekbar id="seek"/></vertical></frame>\');window.exitOnClose();',
    "window.btn.click(()=>{s=s?0:1;window.btn.setText(s?'暂停':'继续');});",
    "window.speedHigh.click(()=>{speedControl=(speedControl*10+1)/10;window.speed.setText('x'+speedControl);});",
    "window.speedLow.click(()=>{if(speedControl>0.1)speedControl=(speedControl*10-1)/10;window.speed.setText('x'+speedControl);});",
    'window.stop.click(()=>engines.stopAll());window.seek.setMax(list.length-1);',
    'for(let i=0;i<list.length-1;i++){while(s!==1)sleep(100);pre(list[i]);window.seek.setProgress(i+1);}',
    ''
  ].join('\n');
}

function renderLongPress(document: ScoreDocument): string {
  const rows = document.groups.map((group) =>
    `  [[${group.keys.join(',')}],${intervalExpression(group.interval, document.noteTime)},0],`
  );
  return [
    '// SkyForce long_press template',
    timingHeader(document.noteTime),
    'let s=1,progressNow=0,speedControl=1,xy=[];',
    'setScreenMetrics(1080,2340);let x=[410,680,950,1220,1490,1760,2030],y=[980,870,760];',
    'for(let i=0;i<21;i++){xy.push(x[i%7],y[parseInt(i/7)]);}',
    'function ran(c){c=c||20;return Math.random()*c-c/2;}',
    'function pre(item){let items=[];for(let id of item[0]){let px=xy[id*2-2]+ran(),py=xy[id*2-1]+ran();items.push([item[1]/speedControl,[px,py],[px,py]]);}if(items.length)gestures.apply(null,items);}',
    'list = [',
    ...rows,
    '  [[],0,0],',
    '];',
    'alert("延音模式：音量加停止；音量减暂停或继续");',
    "threads.start(function(){events.observeKey();events.onKeyDown('volume_up',()=>engines.stopAll());events.onKeyDown('volume_down',()=>{s=s?0:1;toast(s?'继续播放':'已暂停');});});",
    'for(let i=0;i<list.length-1;i++){while(s!==1)sleep(100);pre(list[i]);}',
    ''
  ].join('\n');
}

function timingHeader(noteTime: number): string {
  return [
    `let t0=${noteTime * 2},//默认间隔`,
    `    t1=${noteTime},//较短间隔`,
    `    t2=${noteTime * 4},//较长间隔`,
    '    t3=100,//固定间隔',
    '    pT=35,//按压时间',
    '    sW=true;'
  ].join('\n');
}

function intervalCalls(interval: number, noteTime: number): string {
  let units = Math.max(0, Math.round(interval / noteTime));
  let result = '';
  for (const [size, call] of [[4, 't4();'], [2, 't2();'], [1, 't1();']] as const) {
    while (units >= size) {
      result += call;
      units -= size;
    }
  }
  return result;
}

function intervalExpression(interval: number, noteTime: number): string {
  let units = Math.max(0, Math.round(interval / noteTime));
  const parts: string[] = [];
  while (units >= 4) {
    parts.push('t2');
    units -= 4;
  }
  while (units >= 2) {
    parts.push('t0');
    units -= 2;
  }
  while (units >= 1) {
    parts.push('t1');
    units -= 1;
  }
  return parts.length ? parts.join('+') : '0';
}

function evaluateTimeExpression(
  expression: string,
  variables: Record<string, number>
): number {
  const compact = expression.replace(/\s+/g, '');
  if (!compact || compact === '0') return 0;
  if (!/^[+\-\w\d]+$/.test(compact)) return 0;
  let total = 0;
  const matches = [...compact.matchAll(/([+-]?)([A-Za-z]\w*|\d+)/g)];
  if (matches.map((match) => match[0]).join('') !== compact) return 0;
  for (const match of matches) {
    const sign = match[1] === '-' ? -1 : 1;
    const token = String(match[2]);
    const value = /^\d+$/.test(token) ? Number(token) : (variables[token] ?? 0);
    total += sign * value;
  }
  return Math.max(0, Math.round(total));
}

function balancedSlice(
  text: string,
  start: number,
  open: string,
  close: string
): string | null {
  if (text[start] !== open) return null;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function numericVariable(js: string, name: string, fallback: number): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`, 'i').exec(js);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function decodeScoreBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16Le(bytes);
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset));
  } catch {
    throw new ConversionError('仅支持 UTF-16LE 或 UTF-8 SkyStudio 文件');
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ConversionError('JS 文件不是有效的 UTF-8 文本');
  }
}

function decodeUtf16Le(bytes: Uint8Array): string {
  const start = bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
  return new TextDecoder('utf-16le').decode(bytes.slice(start));
}

function encodeUtf16Le(text: string): Uint8Array {
  const result = new Uint8Array(2 + text.length * 2);
  result[0] = 0xff;
  result[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    result[2 + index * 2] = code & 0xff;
    result[3 + index * 2] = code >> 8;
  }
  return result;
}

function positiveBpm(value: unknown): number {
  const bpm = Math.round(Number(value));
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > MS_PER_MINUTE) {
    throw new ConversionError('BPM 无效');
  }
  return bpm;
}

function positiveNoteTime(value: unknown): number {
  const noteTime = Math.round(Number(value));
  if (!Number.isFinite(noteTime) || noteTime <= 0) {
    throw new ConversionError('JS 中的基础间隔无效');
  }
  return noteTime;
}

function countNotes(groups: NoteGroup[]): number {
  return groups.reduce((total, group) => total + group.keys.length, 0);
}

function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return clean.replace(/\.[^.]+$/, '') || 'score';
}
