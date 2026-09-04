import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  shell
} from 'electron';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertContent, ConversionError } from '../core/converter';
import type {
  DesktopConvertRequest,
  DesktopConvertResult,
  ScriptTemplate
} from '../shared/types';
import { AppDatabase } from './database';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'skyforce',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase;
let logPath = '';

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.skyforce.desktop');
  const userData = app.getPath('userData');
  mkdirSync(join(userData, 'logs'), { recursive: true });
  logPath = join(userData, 'logs', 'skyforce.log');
  database = new AppDatabase(userData);
  registerProtocol();
  registerIpc();
  createWindow();
  log('info', `SkyForce ${app.getVersion()} started`);
}).catch((error) => {
  dialog.showErrorBox('SkyForce 启动失败', error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try {
    database?.close();
  } catch {
    // Database may not have been initialized.
  }
});

process.on('uncaughtException', (error) => log('error', error.stack ?? error.message));
process.on('unhandledRejection', (error) => log('error', String(error)));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    show: false,
    backgroundColor: '#f3f6ff',
    title: 'SkyForce',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL)
      : url.startsWith('skyforce://app/');
    if (!allowed) event.preventDefault();
  });
  if (process.argv.includes('--smoke-test')) {
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents.executeJavaScript(`
        (async () => ({
          title: document.title,
          navigationItems: document.querySelectorAll('[data-page]').length,
          version: await window.skyforce.app.version()
        }))()
      `).then((result: { title: string; navigationItems: number; version: string }) => {
        if (result.title !== 'SkyForce' || result.navigationItems < 8 || !result.version) {
          throw new Error('Renderer smoke-test assertions failed');
        }
        log('info', `Packaged smoke test passed (${result.navigationItems} pages, v${result.version})`);
        setTimeout(() => app.quit(), 300);
      }).catch((error: unknown) => {
        log('error', `Packaged smoke test failed: ${String(error)}`);
        app.exit(2);
      });
    });
  }
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadURL('skyforce://app/index.html');
  }
}

function registerProtocol(): void {
  protocol.handle('skyforce', (request) => {
    const url = new URL(request.url);
    const rendererRoot = resolve(__dirname, '..', '..', 'renderer');
    const requestedPath = decodeURIComponent(url.pathname.replace(/^\/+/, '') || 'index.html');
    const target = resolve(rendererRoot, normalize(requestedPath));
    if (relative(rendererRoot, target).startsWith('..') || !existsSync(target)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

function registerIpc(): void {
  ipcMain.handle('app:version', checked(() => app.getVersion()));
  ipcMain.handle('app:paths', checked(() => ({
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    logs: dirname(logPath),
    database: database.path
  })));

  ipcMain.handle('dialogs:choose-files', checked(async (_event, extensions: unknown) => {
    const normalizedExtensions = Array.isArray(extensions)
      ? extensions.map(String).map((item) => item.replace(/^\./, '')).filter((item) => /^[a-z0-9]+$/i.test(item))
      : [];
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: normalizedExtensions.length
        ? [{ name: '支持的文件', extensions: normalizedExtensions }]
        : [{ name: '所有文件', extensions: ['*'] }]
    });
    return result.canceled ? [] : result.filePaths;
  }));

  ipcMain.handle('dialogs:choose-directory', checked(async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }));

  ipcMain.handle('conversion:run', checked(async (_event, value: unknown) => {
    const request = validateConversionRequest(value);
    return runConversion(request);
  }));

  ipcMain.handle('files:read-text', checked((_event, value: unknown) => {
    const path = requireAbsolutePath(value);
    const bytes = readFileSync(path);
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('文件超过 20MiB');
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8').decode(bytes);
  }));

  ipcMain.handle('files:read-binary', checked((_event, value: unknown) => {
    const path = requireAbsolutePath(value);
    const bytes = readFileSync(path);
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('文件超过 50MiB');
    return new Uint8Array(bytes);
  }));

  ipcMain.handle('files:save', checked(async (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('保存参数无效');
    const request = value as { suggestedName?: unknown; data?: unknown };
    const suggestedName = sanitizeFilename(String(request.suggestedName ?? 'output.txt'));
    const bytes = toUint8Array(request.data);
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('保存内容超过 100MiB');
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: join(app.getPath('downloads'), suggestedName)
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, bytes);
    return result.filePath;
  }));

  ipcMain.handle('files:reveal', checked((_event, value: unknown) => {
    const path = requireAbsolutePath(value);
    shell.showItemInFolder(path);
  }));

  ipcMain.handle('settings:get-all', checked(() => database.getSettings()));
  ipcMain.handle('settings:set', checked((_event, key: unknown, value: unknown) => {
    const safeKey = String(key);
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(safeKey)) throw new Error('设置键无效');
    database.setSetting(safeKey, value);
  }));
  ipcMain.handle('history:list', checked((_event, limit: unknown) =>
    database.listHistory(Number(limit) || 100)
  ));
  ipcMain.handle('history:clear', checked(() => database.clearHistory()));

  ipcMain.handle('secrets:has-deepseek', checked(() => {
    return database.getSetting<string>('secret.deepseek', '') !== '';
  }));
  ipcMain.handle('secrets:set-deepseek', checked((_event, value: unknown) => {
    const key = String(value).trim();
    if (key.length < 10 || key.length > 500) throw new Error('API Key 长度无效');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用');
    const encrypted = safeStorage.encryptString(key).toString('base64');
    database.setSetting('secret.deepseek', encrypted);
  }));
  ipcMain.handle('secrets:clear-deepseek', checked(() => database.setSetting('secret.deepseek', '')));

  ipcMain.handle('ai:generate-chords', checked(async (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('AI 请求无效');
    const encrypted = database.getSetting<string>('secret.deepseek', '');
    if (!encrypted) throw new Error('请先在设置中配置 DeepSeek API Key');
    const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    const request = value as Record<string, unknown>;
    const score = String(request.score ?? '').slice(0, 20_000);
    if (!score) throw new Error('乐谱为空');
    const baseUrl = database.getSetting<string>('deepseek.baseUrl', 'https://api.deepseek.com');
    const model = database.getSetting<string>('deepseek.model', 'deepseek-chat');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是乐谱和弦助手。只返回 JSON：{"items":[{"sourceNotes":["c4"],"addedNotes":["e4","g4"],"chordName":"C","intervalSymbol":"-"}]}。音名限制为 c4 到 b6，每项总音符不超过3个。'
          },
          {
            role: 'user',
            content: JSON.stringify({
              score,
              keyRoot: String(request.keyRoot ?? 'C'),
              style: String(request.style ?? '流行'),
              instruction: String(request.instruction ?? '').slice(0, 500)
            })
          }
        ]
      }),
      signal: AbortSignal.timeout(30_000)
    });
    const json = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = json.error as Record<string, unknown> | undefined;
      throw new Error(String(error?.message ?? `DeepSeek HTTP ${response.status}`));
    }
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = String(message?.content ?? '');
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error('DeepSeek 返回的 JSON 无法解析');
    }
  }));

  ipcMain.handle('legacy:import-project', checked((_event, source: unknown) => {
    return importLegacyProject(requireAbsolutePath(source));
  }));
}

function checked<T extends unknown[], R>(
  handler: (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<R>
): (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<R> {
  return (event, ...args) => {
    const url = event.senderFrame?.url ?? event.sender.getURL();
    const valid = process.env.VITE_DEV_SERVER_URL
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL)
      : url.startsWith('skyforce://app/');
    if (!valid) throw new Error('拒绝未知页面的桌面权限请求');
    return handler(event, ...args);
  };
}

async function runConversion(request: DesktopConvertRequest): Promise<DesktopConvertResult> {
  mkdirSync(request.outputDirectory, { recursive: true });
  const started = performance.now();
  const items: DesktopConvertResult['items'] = [];
  const usedNames = new Set<string>();
  for (const inputPath of request.inputPaths) {
    const itemStarted = performance.now();
    const sourceName = basename(inputPath);
    let outputName = '';
    try {
      const stat = statSync(inputPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 10 * 1024 * 1024) {
        throw new Error('文件必须大于 0 且不超过 10MiB');
      }
      const output = convertContent(readFileSync(inputPath), sourceName, request);
      outputName = uniqueFilename(
        `${basename(sourceName, extname(sourceName))}.${output.extension}`,
        usedNames,
        request.outputDirectory
      );
      const outputPath = join(request.outputDirectory, outputName);
      writeFileSync(outputPath, output.bytes);
      const elapsedMs = Math.round(performance.now() - itemStarted);
      items.push({
        inputPath,
        outputPath,
        ok: true,
        bpm: output.bpm,
        noteCount: output.noteCount,
        elapsedMs
      });
      database.addHistory({
        sourceName,
        outputName,
        mode: request.mode,
        template: request.template,
        status: 1,
        noteCount: output.noteCount,
        bpm: output.bpm,
        elapsedMs
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = Math.round(performance.now() - itemStarted);
      items.push({ inputPath, ok: false, error: message, elapsedMs });
      database.addHistory({
        sourceName,
        outputName,
        mode: request.mode,
        template: request.template,
        status: 0,
        errorMessage: message,
        elapsedMs
      });
      log('warn', `${sourceName}: ${message}`);
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  return {
    items,
    success: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    elapsedMs: Math.round(performance.now() - started)
  };
}

function validateConversionRequest(value: unknown): DesktopConvertRequest {
  if (!value || typeof value !== 'object') throw new Error('转换参数无效');
  const request = value as Partial<DesktopConvertRequest>;
  const mode = request.mode;
  if (!['txt-to-js', 'js-to-txt', 'js-to-js'].includes(String(mode))) throw new Error('转换模式无效');
  const template = request.template;
  if (!['press', 'press_new', 'long_press'].includes(String(template))) throw new Error('输出模板无效');
  const sourceTemplate = request.sourceTemplate ?? 'auto';
  if (!['auto', 'press', 'press_new', 'long_press'].includes(String(sourceTemplate))) {
    throw new Error('源模板无效');
  }
  const inputPaths = Array.isArray(request.inputPaths)
    ? request.inputPaths.map(requireAbsolutePath)
    : [];
  if (!inputPaths.length || inputPaths.length > 500) throw new Error('请选择 1 到 500 个输入文件');
  const outputDirectory = requireAbsolutePath(request.outputDirectory);
  return {
    mode: mode as DesktopConvertRequest['mode'],
    template: template as ScriptTemplate,
    sourceTemplate: sourceTemplate as DesktopConvertRequest['sourceTemplate'],
    inputPaths,
    outputDirectory
  };
}

function requireAbsolutePath(value: unknown): string {
  const path = resolve(String(value ?? ''));
  if (!String(value ?? '') || !isAbsolute(path)) throw new Error('路径必须是绝对路径');
  return path;
}

function sanitizeFilename(value: string): string {
  const clean = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
  const stem = clean.replace(/\.[^.]+$/, '').toUpperCase();
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
  return reserved || !clean ? `_${clean || 'output.txt'}` : clean;
}

function uniqueFilename(value: string, used: Set<string>, outputDirectory: string): string {
  const clean = sanitizeFilename(value);
  const extension = extname(clean);
  const stem = basename(clean, extension);
  let candidate = clean;
  let number = 2;
  while (
    used.has(candidate.toLocaleLowerCase('en-US')) ||
    existsSync(join(outputDirectory, candidate))
  ) {
    candidate = `${stem}_${number}${extension}`;
    number += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value.map(Number));
  if (value && typeof value === 'object' && 'data' in value) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  throw new Error('二进制内容无效');
}

function importLegacyProject(sourceRoot: string): Record<string, number | string[]> {
  const required = ['app', 'public', 'runtime'];
  if (!required.every((name) => existsSync(join(sourceRoot, name)))) {
    throw new Error('所选目录不是有效的 SkyForge 项目');
  }
  const importRoot = join(
    app.getPath('userData'),
    'legacy-import',
    new Date().toISOString().replace(/[:.]/g, '-')
  );
  mkdirSync(importRoot, { recursive: true });
  let files = 0;
  let bytes = 0;
  const imported: string[] = [];
  for (const name of ['converted', 'downloads']) {
    const source = join(sourceRoot, name);
    if (!existsSync(source)) continue;
    const target = join(importRoot, name);
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
    const summary = directorySummary(target);
    files += summary.files;
    bytes += summary.bytes;
    imported.push(name);
  }
  const soundSource = join(sourceRoot, 'runtime', 'sound_packs');
  if (existsSync(soundSource)) {
    const target = join(importRoot, 'sound_packs');
    cpSync(soundSource, target, { recursive: true, force: false, errorOnExist: false });
    const summary = directorySummary(target);
    files += summary.files;
    bytes += summary.bytes;
    imported.push('sound_packs');
  }
  const manifest = {
    sourceRoot,
    importedAt: new Date().toISOString(),
    files,
    bytes,
    imported
  };
  writeFileSync(join(importRoot, 'import-manifest.json'), JSON.stringify(manifest, null, 2));
  database.setSetting('legacy.lastImport', manifest);
  return { files, bytes, imported, destination: [importRoot] };
}

function directorySummary(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySummary(path);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

function log(level: string, message: string): void {
  if (!logPath) return;
  const safeMessage = message.replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***');
  appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${safeMessage}\n`, 'utf8');
}
