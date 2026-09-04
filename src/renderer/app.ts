import { NOTE_NAMES_15, NOTE_NAMES_21 } from '../core/converter';
import type {
  ChordPlanItem,
  EditorIntervals,
  EditorToken
} from './score-tools';
import {
  applyChordPlan,
  buildEditorScript,
  buildLocalChords,
  editorScoreToSkyStudioJson,
  parseEditorScore,
  playEditorTokens,
  renderScoreCanvas,
  skyStudioJsonToEditor,
  stopPlayback
} from './score-tools';
import { midiToSkyStudio } from './midi';

const pageTitles: Record<string, string> = {
  home: '工作台概览',
  convert: '格式转换',
  editor: '乐谱编辑',
  midi: 'MIDI 转 JSON',
  image: '简谱长图',
  chord: '自动和弦',
  library: '历史记录',
  settings: '设置与数据'
};

const state = {
  settings: {} as Record<string, unknown>,
  appPaths: {} as Record<string, string>,
  convertFiles: [] as string[],
  lastOutputDirectory: '',
  generatedEditorJs: '',
  midiPath: '',
  midiJson: '',
  chordPlan: [] as ChordPlanItem[],
  referenceUrl: ''
};

void initialize();

async function initialize(): Promise<void> {
  bindNavigation();
  bindConverter();
  bindEditor();
  bindMidi();
  bindImage();
  bindChords();
  bindHistory();
  bindSettings();

  const [version, settings, paths] = await Promise.all([
    window.skyforce.app.version(),
    window.skyforce.settings.getAll(),
    window.skyforce.app.paths()
  ]);
  state.settings = settings;
  state.appPaths = paths;
  byId('app-version').textContent = `v${version}`;
  applySettings();
  renderKeypad();
  renderPaths();
  await Promise.all([refreshHistory(), refreshAiState()]);
}

function bindNavigation(): void {
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.page ?? 'home'));
  });
  document.querySelectorAll<HTMLElement>('[data-go]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.go ?? 'home'));
  });
  byId('open-logs').addEventListener('click', () => {
    const path = state.appPaths.logs;
    if (path) void window.skyforce.files.reveal(path);
  });
}

function navigate(page: string): void {
  document.querySelectorAll<HTMLElement>('[data-page-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.pagePanel === page);
  });
  document.querySelectorAll<HTMLElement>('[data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  byId('page-title').textContent = pageTitles[page] ?? 'SkyForce';
  if (page === 'library') void refreshHistory();
}

function bindConverter(): void {
  const mode = byId<HTMLSelectElement>('convert-mode');
  const choose = byId<HTMLButtonElement>('choose-convert-files');
  const outputDirectory = byId<HTMLInputElement>('convert-output-dir');
  mode.addEventListener('change', () => {
    byId('source-template-field').classList.toggle('hidden', mode.value === 'txt-to-js');
    state.convertFiles = [];
    renderConvertFiles();
  });
  choose.addEventListener('click', async () => {
    const extensions = mode.value === 'txt-to-js' ? ['txt'] : ['js'];
    state.convertFiles = await window.skyforce.dialogs.chooseFiles(extensions);
    renderConvertFiles();
  });
  byId('choose-output-dir').addEventListener('click', async () => {
    const selected = await window.skyforce.dialogs.chooseDirectory();
    if (!selected) return;
    outputDirectory.value = selected;
    state.settings.exportDirectory = selected;
    await window.skyforce.settings.set('exportDirectory', selected);
    updateConvertReady();
  });
  byId('run-convert').addEventListener('click', () => void runConversion());
  byId('reveal-last-output').addEventListener('click', () => {
    if (state.lastOutputDirectory) void window.skyforce.files.reveal(state.lastOutputDirectory);
  });
}

function renderConvertFiles(): void {
  const host = byId('convert-file-list');
  host.replaceChildren();
  if (!state.convertFiles.length) {
    host.append(createElement('p', 'empty', '尚未选择文件'));
  } else {
    state.convertFiles.forEach((path) => {
      const row = createElement('div', 'file-row');
      row.append(createElement('b', '', fileName(path)), createElement('span', '', path));
      host.append(row);
    });
  }
  updateConvertReady();
}

function updateConvertReady(): void {
  byId<HTMLButtonElement>('run-convert').disabled =
    !state.convertFiles.length || !byId<HTMLInputElement>('convert-output-dir').value;
}

async function runConversion(): Promise<void> {
  const button = byId<HTMLButtonElement>('run-convert');
  const status = byId('convert-status');
  const results = byId('convert-results');
  setBusy(button, true, '转换中…');
  setStatus(status, `正在处理 ${state.convertFiles.length} 个文件…`);
  results.replaceChildren(createElement('div', 'empty-state', '正在转换，请稍候…'));
  try {
    const response = await window.skyforce.conversion.run({
      inputPaths: state.convertFiles,
      outputDirectory: byId<HTMLInputElement>('convert-output-dir').value,
      mode: byId<HTMLSelectElement>('convert-mode').value as 'txt-to-js' | 'js-to-txt' | 'js-to-js',
      template: byId<HTMLSelectElement>('convert-template').value as 'press' | 'press_new' | 'long_press',
      sourceTemplate: byId<HTMLSelectElement>('convert-source-template').value as 'auto'
    });
    state.lastOutputDirectory = byId<HTMLInputElement>('convert-output-dir').value;
    byId<HTMLButtonElement>('reveal-last-output').disabled = false;
    results.replaceChildren();
    response.items.forEach((item) => {
      const row = createElement('div', `result-row ${item.ok ? 'ok' : 'fail'}`);
      row.append(
        createElement('b', '', fileName(item.inputPath)),
        createElement('span', '', item.ok
          ? `已输出：${item.outputPath} · ${item.noteCount ?? 0} 音符 · ${item.elapsedMs}ms`
          : `${item.error ?? '转换失败'} · ${item.elapsedMs}ms`)
      );
      results.append(row);
    });
    setStatus(status, `完成：成功 ${response.success}，失败 ${response.failed}，总耗时 ${response.elapsedMs}ms`,
      response.failed ? 'error' : 'success');
    await refreshHistory();
  } catch (error) {
    setStatus(status, errorMessage(error), 'error');
  } finally {
    setBusy(button, false, '开始转换');
  }
}

function bindEditor(): void {
  byId('editor-import').addEventListener('click', () => void importEditorFile());
  byId('editor-reference').addEventListener('click', () => void loadReference());
  byId('editor-preview').addEventListener('click', () => {
    try {
      const tokens = currentEditorTokens();
      if (!tokens.length) throw new Error('请先输入乐谱');
      const duration = playEditorTokens(tokens, byId<HTMLSelectElement>('editor-sound').value);
      setStatus(byId('editor-status'), `正在试听，时长约 ${(duration / 1000).toFixed(1)} 秒`, 'success');
    } catch (error) {
      setStatus(byId('editor-status'), errorMessage(error), 'error');
    }
  });
  byId('editor-stop').addEventListener('click', () => {
    stopPlayback();
    setStatus(byId('editor-status'), '已停止试听');
  });
  byId('editor-generate').addEventListener('click', generateEditorJs);
  byId('editor-save-js').addEventListener('click', () => void saveEditorJs());
  byId('editor-save-score').addEventListener('click', () => void saveEditorScore());
  byId<HTMLTextAreaElement>('score-input').addEventListener('input', () => {
    window.clearTimeout(Number(byId<HTMLTextAreaElement>('score-input').dataset.saveTimer || 0));
    const timer = window.setTimeout(() => {
      void window.skyforce.settings.set('editor.draft', byId<HTMLTextAreaElement>('score-input').value);
    }, 350);
    byId<HTMLTextAreaElement>('score-input').dataset.saveTimer = String(timer);
  });
}

function renderKeypad(): void {
  const use21 = Boolean(state.settings.use21Keys);
  const host = byId('score-keypad');
  host.classList.toggle('keys-21', use21);
  host.replaceChildren();
  const names = use21 ? NOTE_NAMES_21 : NOTE_NAMES_15;
  names.forEach((note) => {
    const button = createElement('button', '', note);
    button.type = 'button';
    button.addEventListener('click', () => {
      const input = byId<HTMLTextAreaElement>('score-input');
      const insertion = `${note}-`;
      const start = input.selectionStart ?? input.value.length;
      input.setRangeText(insertion, start, input.selectionEnd ?? start, 'end');
      input.dispatchEvent(new Event('input'));
      try {
        playEditorTokens(
          [{ notes: [note], interval: 220, symbol: '-' }],
          byId<HTMLSelectElement>('editor-sound').value
        );
      } catch {
        // Audio is optional for insertion.
      }
      input.focus();
    });
    host.append(button);
  });
}

function currentIntervals(): EditorIntervals {
  return {
    default: safeNumber(byId<HTMLInputElement>('interval-default').value, 400, 20, 5_000),
    short: safeNumber(byId<HTMLInputElement>('interval-short').value, 200, 20, 5_000),
    long: safeNumber(byId<HTMLInputElement>('interval-long').value, 800, 20, 5_000)
  };
}

function currentEditorTokens(): EditorToken[] {
  return parseEditorScore(byId<HTMLTextAreaElement>('score-input').value, currentIntervals());
}

function generateEditorJs(): void {
  try {
    const tokens = currentEditorTokens();
    if (!tokens.length) throw new Error('没有可生成的音符');
    state.generatedEditorJs = buildEditorScript(
      byId<HTMLInputElement>('editor-name').value,
      tokens,
      Boolean(state.settings.use21Keys),
      Number(state.settings.pressTime ?? 35),
      byId<HTMLSelectElement>('editor-script-template').value as 'default' | 'simple' | 'custom',
      String(state.settings.customScriptTemplate ?? '')
    );
    byId('editor-code').textContent = state.generatedEditorJs;
    byId<HTMLButtonElement>('editor-save-js').disabled = false;
    setStatus(byId('editor-status'), `已生成 ${tokens.length} 个音符组`, 'success');
  } catch (error) {
    setStatus(byId('editor-status'), errorMessage(error), 'error');
  }
}

async function saveEditorJs(): Promise<void> {
  if (!state.generatedEditorJs) return;
  const path = await window.skyforce.files.save({
    suggestedName: `${safeFileName(byId<HTMLInputElement>('editor-name').value)}.js`,
    data: new TextEncoder().encode(state.generatedEditorJs)
  });
  if (path) setStatus(byId('editor-status'), `已保存：${path}`, 'success');
}

async function saveEditorScore(): Promise<void> {
  const tokens = currentEditorTokens();
  if (!tokens.length) {
    setStatus(byId('editor-status'), '没有可保存的乐谱', 'error');
    return;
  }
  const json = editorScoreToSkyStudioJson(
    byId<HTMLInputElement>('editor-name').value,
    tokens,
    currentIntervals(),
    Boolean(state.settings.use21Keys)
  );
  const path = await window.skyforce.files.save({
    suggestedName: `${safeFileName(byId<HTMLInputElement>('editor-name').value)}.txt`,
    data: encodeUtf16Le(json)
  });
  if (path) setStatus(byId('editor-status'), `SkyStudio TXT 已保存：${path}`, 'success');
}

async function importEditorFile(): Promise<void> {
  const paths = await window.skyforce.dialogs.chooseFiles(['txt', 'json']);
  const path = paths[0];
  if (!path) return;
  try {
    const text = await window.skyforce.files.readText(path);
    const input = byId<HTMLTextAreaElement>('score-input');
    if (text.includes('songNotes')) {
      input.value = skyStudioJsonToEditor(text, currentIntervals());
    } else {
      input.value = text;
    }
    byId<HTMLInputElement>('editor-name').value = fileName(path).replace(/\.[^.]+$/, '');
    input.dispatchEvent(new Event('input'));
    setStatus(byId('editor-status'), `已导入：${path}`, 'success');
  } catch (error) {
    setStatus(byId('editor-status'), errorMessage(error), 'error');
  }
}

async function loadReference(): Promise<void> {
  const paths = await window.skyforce.dialogs.chooseFiles(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf']);
  const path = paths[0];
  if (!path) return;
  try {
    const bytes = await window.skyforce.files.readBinary(path);
    if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl);
    const extension = path.split('.').pop()?.toLowerCase();
    const mime = extension === 'pdf' ? 'application/pdf' : `image/${extension === 'jpg' ? 'jpeg' : extension}`;
    const binary = Uint8Array.from(bytes);
    state.referenceUrl = URL.createObjectURL(new Blob([binary.buffer], { type: mime }));
    const stage = byId('reference-stage');
    stage.replaceChildren();
    const element = extension === 'pdf'
      ? document.createElement('embed')
      : document.createElement('img');
    if (element instanceof HTMLEmbedElement) {
      element.src = state.referenceUrl;
      element.type = 'application/pdf';
    } else {
      element.src = state.referenceUrl;
      element.alt = '参考乐谱';
    }
    stage.append(element);
    stage.classList.remove('hidden');
  } catch (error) {
    setStatus(byId('editor-status'), errorMessage(error), 'error');
  }
}

function bindMidi(): void {
  byId('choose-midi').addEventListener('click', async () => {
    const paths = await window.skyforce.dialogs.chooseFiles(['mid', 'midi']);
    if (!paths[0]) return;
    state.midiPath = paths[0];
    byId('midi-file-label').textContent = state.midiPath;
    byId<HTMLButtonElement>('run-midi').disabled = false;
  });
  byId('run-midi').addEventListener('click', () => void runMidi());
  byId('save-midi-json').addEventListener('click', async () => {
    if (!state.midiJson) return;
    const path = await window.skyforce.files.save({
      suggestedName: `${safeFileName(fileName(state.midiPath).replace(/\.(mid|midi)$/i, ''))}.json`,
      data: new TextEncoder().encode(state.midiJson)
    });
    if (path) setStatus(byId('midi-status'), `已保存：${path}`, 'success');
  });
}

async function runMidi(): Promise<void> {
  try {
    const bytes = await window.skyforce.files.readBinary(state.midiPath);
    const result = midiToSkyStudio(
      bytes,
      fileName(state.midiPath),
      Number(byId<HTMLSelectElement>('midi-range').value) === 21 ? 21 : 15,
      safeNumber(byId<HTMLInputElement>('midi-octave').value, 0, -4, 4),
      safeNumber(byId<HTMLInputElement>('midi-quantize').value, 40, 1, 2_000)
    );
    state.midiJson = result.json;
    byId('midi-output').textContent = result.json;
    byId<HTMLButtonElement>('save-midi-json').disabled = false;
    setStatus(byId('midi-status'),
      `完成：${result.notes} 个音符，忽略 ${result.skipped} 个，BPM ${result.bpm}`,
      result.notes ? 'success' : 'error');
  } catch (error) {
    setStatus(byId('midi-status'), errorMessage(error), 'error');
  }
}

function bindImage(): void {
  byId('image-from-editor').addEventListener('click', () => {
    byId<HTMLTextAreaElement>('image-score').value = byId<HTMLTextAreaElement>('score-input').value;
    byId<HTMLInputElement>('image-title').value = byId<HTMLInputElement>('editor-name').value;
  });
  byId('render-image').addEventListener('click', () => {
    try {
      const tokens = parseEditorScore(byId<HTMLTextAreaElement>('image-score').value, currentIntervals());
      if (!tokens.length) throw new Error('没有可绘制的音符');
      renderScoreCanvas(byId<HTMLCanvasElement>('score-canvas'), byId<HTMLInputElement>('image-title').value, tokens);
      byId<HTMLButtonElement>('save-image').disabled = false;
      setStatus(byId('image-status'), `已绘制 ${tokens.length} 个音符组`, 'success');
    } catch (error) {
      setStatus(byId('image-status'), errorMessage(error), 'error');
    }
  });
  byId('save-image').addEventListener('click', () => void saveCanvas());
}

async function saveCanvas(): Promise<void> {
  const canvas = byId<HTMLCanvasElement>('score-canvas');
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png')
  );
  const path = await window.skyforce.files.save({
    suggestedName: `${safeFileName(byId<HTMLInputElement>('image-title').value)}_简谱长图.png`,
    data: new Uint8Array(await blob.arrayBuffer())
  });
  if (path) setStatus(byId('image-status'), `已保存：${path}`, 'success');
}

function bindChords(): void {
  byId('chord-from-editor').addEventListener('click', () => {
    byId<HTMLTextAreaElement>('chord-score').value = byId<HTMLTextAreaElement>('score-input').value;
  });
  byId('run-chord').addEventListener('click', () => void runChords());
  byId('apply-chords').addEventListener('click', () => {
    if (!state.chordPlan.length) return;
    byId<HTMLTextAreaElement>('score-input').value = applyChordPlan(state.chordPlan);
    byId<HTMLTextAreaElement>('score-input').dispatchEvent(new Event('input'));
    navigate('editor');
    setStatus(byId('editor-status'), '和弦方案已应用', 'success');
  });
}

async function runChords(): Promise<void> {
  const status = byId('chord-status');
  try {
    const score = byId<HTMLTextAreaElement>('chord-score').value;
    const tokens = parseEditorScore(score, currentIntervals());
    if (!tokens.length) throw new Error('没有可处理的乐谱');
    if (byId<HTMLSelectElement>('chord-mode').value === 'ai') {
      setStatus(status, '正在请求 DeepSeek…');
      const response = await window.skyforce.ai.generateChords({
        score,
        keyRoot: byId<HTMLSelectElement>('chord-key').value,
        style: byId<HTMLSelectElement>('chord-style').value,
        instruction: byId<HTMLInputElement>('chord-instruction').value
      });
      state.chordPlan = normalizeAiChordPlan(response, tokens);
    } else {
      state.chordPlan = buildLocalChords(tokens, byId<HTMLSelectElement>('chord-key').value);
    }
    renderChordPlan();
    setStatus(status, `已生成 ${state.chordPlan.length} 个和弦建议`, 'success');
  } catch (error) {
    setStatus(status, errorMessage(error), 'error');
  }
}

function normalizeAiChordPlan(response: Record<string, unknown>, fallback: EditorToken[]): ChordPlanItem[] {
  const rawItems = Array.isArray(response.items)
    ? response.items
    : Array.isArray((response.plan as Record<string, unknown> | undefined)?.items)
      ? (response.plan as Record<string, unknown>).items as unknown[]
      : [];
  const validNote = (value: unknown) => NOTE_NAMES_21.includes(String(value).toLowerCase() as never);
  const items = rawItems.map((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sourceNotes = Array.isArray(row.sourceNotes)
      ? row.sourceNotes.filter(validNote).map((note) => String(note).toLowerCase())
      : fallback[index]?.notes ?? [];
    const addedNotes = Array.isArray(row.addedNotes)
      ? row.addedNotes.filter(validNote).map((note) => String(note).toLowerCase()).slice(0, Math.max(0, 3 - sourceNotes.length))
      : [];
    const symbol = row.intervalSymbol === '~' || row.intervalSymbol === ',' ? row.intervalSymbol : '-';
    return {
      sourceNotes,
      addedNotes,
      chordName: String(row.chordName ?? '-').slice(0, 20),
      symbol
    } as ChordPlanItem;
  }).filter((item) => item.sourceNotes.length);
  if (!items.length) throw new Error('AI 未返回有效的和弦方案');
  return items;
}

function renderChordPlan(): void {
  const host = byId('chord-output');
  host.replaceChildren();
  state.chordPlan.forEach((item) => {
    const row = createElement('div', 'chord-item');
    row.append(
      createElement('b', '', item.chordName),
      createElement('span', '', `原音：${item.sourceNotes.join(' · ')}`),
      createElement('span', '', `新增：${item.addedNotes.join(' · ') || '无'}`)
    );
    host.append(row);
  });
  byId<HTMLButtonElement>('apply-chords').disabled = !state.chordPlan.length;
}

function bindHistory(): void {
  byId('refresh-history').addEventListener('click', () => void refreshHistory());
  byId('clear-history').addEventListener('click', async () => {
    if (!window.confirm('确定清空本机转换历史吗？输出文件不会被删除。')) return;
    await window.skyforce.history.clear();
    await refreshHistory();
  });
}

async function refreshHistory(): Promise<void> {
  const rows = await window.skyforce.history.list(200);
  byId('home-history-count').textContent = String(rows.length);
  const host = byId<HTMLTableSectionElement>('history-body');
  host.replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty';
    cell.textContent = '暂无转换历史';
    row.append(cell);
    host.append(row);
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement('tr');
    [
      item.created_at,
      item.source_name,
      item.mode,
      item.template,
      String(item.note_count),
      `${item.elapsed_ms} ms`
    ].forEach((text) => row.append(createElement('td', '', text)));
    row.append(createElement('td', item.status ? 'status-ok' : 'status-fail',
      item.status ? '成功' : `失败：${item.error_message}`));
    host.append(row);
  });
}

function bindSettings(): void {
  byId<HTMLSelectElement>('setting-theme').addEventListener('change', async (event) => {
    const theme = (event.target as HTMLSelectElement).value;
    state.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    await window.skyforce.settings.set('theme', theme);
  });
  byId<HTMLInputElement>('setting-21-keys').addEventListener('change', async (event) => {
    state.settings.use21Keys = (event.target as HTMLInputElement).checked;
    await window.skyforce.settings.set('use21Keys', state.settings.use21Keys);
    renderKeypad();
  });
  byId('setting-choose-dir').addEventListener('click', async () => {
    const path = await window.skyforce.dialogs.chooseDirectory();
    if (!path) return;
    state.settings.exportDirectory = path;
    byId<HTMLInputElement>('setting-export-dir').value = path;
    byId<HTMLInputElement>('convert-output-dir').value = path;
    await window.skyforce.settings.set('exportDirectory', path);
    updateConvertReady();
  });
  byId('save-ai-settings').addEventListener('click', () => void saveAiSettings());
  byId('clear-ai-key').addEventListener('click', async () => {
    await window.skyforce.secrets.clearDeepSeekKey();
    byId<HTMLInputElement>('deepseek-key').value = '';
    await refreshAiState();
  });
  byId('choose-legacy-source').addEventListener('click', async () => {
    const path = await window.skyforce.dialogs.chooseDirectory();
    if (path) byId<HTMLInputElement>('legacy-source').value = path;
  });
  byId('run-legacy-import').addEventListener('click', () => void importLegacy());
  byId('save-custom-template').addEventListener('click', async () => {
    const value = byId<HTMLTextAreaElement>('custom-script-template').value;
    if (!value.includes('{{scoreJson}}')) {
      setStatus(byId('custom-template-status'), '模板必须包含 {{scoreJson}}', 'error');
      return;
    }
    state.settings.customScriptTemplate = value;
    await window.skyforce.settings.set('customScriptTemplate', value);
    setStatus(byId('custom-template-status'), '模板已保存', 'success');
  });
}

function applySettings(): void {
  const theme = String(state.settings.theme ?? 'aurora');
  document.documentElement.dataset.theme = theme;
  byId<HTMLSelectElement>('setting-theme').value = theme;
  byId<HTMLInputElement>('setting-21-keys').checked = Boolean(state.settings.use21Keys);
  const exportDirectory = String(state.settings.exportDirectory ?? state.appPaths.downloads ?? '');
  byId<HTMLInputElement>('setting-export-dir').value = exportDirectory;
  byId<HTMLInputElement>('convert-output-dir').value = exportDirectory;
  byId<HTMLInputElement>('deepseek-url').value = String(state.settings['deepseek.baseUrl'] ?? 'https://api.deepseek.com');
  byId<HTMLInputElement>('deepseek-model').value = String(state.settings['deepseek.model'] ?? 'deepseek-chat');
  byId<HTMLTextAreaElement>('score-input').value = String(state.settings['editor.draft'] ?? '');
  byId<HTMLTextAreaElement>('custom-script-template').value = String(
    state.settings.customScriptTemplate ??
    '// {{title}} - custom template\nvar keyMap={{coordsJson}};\nvar pressTime={{pressTime}};\nvar score={{scoreJson}};\n'
  );
  updateConvertReady();
}

async function saveAiSettings(): Promise<void> {
  const status = byId('ai-key-state');
  try {
    const key = byId<HTMLInputElement>('deepseek-key').value.trim();
    if (key) await window.skyforce.secrets.setDeepSeekKey(key);
    const baseUrl = byId<HTMLInputElement>('deepseek-url').value.trim();
    const model = byId<HTMLInputElement>('deepseek-model').value.trim();
    if (!/^https:\/\//i.test(baseUrl)) throw new Error('接口地址必须使用 HTTPS');
    await Promise.all([
      window.skyforce.settings.set('deepseek.baseUrl', baseUrl),
      window.skyforce.settings.set('deepseek.model', model)
    ]);
    state.settings['deepseek.baseUrl'] = baseUrl;
    state.settings['deepseek.model'] = model;
    byId<HTMLInputElement>('deepseek-key').value = '';
    await refreshAiState();
    status.textContent = '已保存';
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

async function refreshAiState(): Promise<void> {
  const configured = await window.skyforce.secrets.hasDeepSeekKey();
  const stateElement = byId('ai-key-state');
  stateElement.textContent = configured ? '已安全配置' : '未配置';
  stateElement.classList.toggle('offline-badge', configured);
}

async function importLegacy(): Promise<void> {
  const status = byId('legacy-status');
  setStatus(status, '正在复制旧项目资料…');
  try {
    const result = await window.skyforce.legacy.importProject(byId<HTMLInputElement>('legacy-source').value);
    setStatus(status, `已导入 ${result.files} 个文件，共 ${formatBytes(Number(result.bytes))}`, 'success');
  } catch (error) {
    setStatus(status, errorMessage(error), 'error');
  }
}

function renderPaths(): void {
  const host = byId('app-paths');
  host.replaceChildren();
  Object.entries(state.appPaths).forEach(([key, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = key;
    description.textContent = value;
    row.append(term, description);
    host.append(row);
  });
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function setStatus(target: HTMLElement, message: string, type: 'success' | 'error' | '' = ''): void {
  target.textContent = message;
  target.classList.remove('success', 'error');
  if (type) target.classList.add(type);
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  button.textContent = label;
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function safeFileName(value: string): string {
  return String(value || 'output').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'output';
}

function safeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
  return String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
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
