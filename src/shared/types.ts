export type ScriptTemplate = 'press' | 'press_new' | 'long_press';
export type ConvertMode = 'txt-to-js' | 'js-to-txt' | 'js-to-js';

export interface NoteGroup {
  keys: number[];
  interval: number;
}

export interface ScoreDocument {
  bpm: number;
  noteTime: number;
  isJson: boolean;
  name: string;
  groups: NoteGroup[];
}

export interface ConversionOptions {
  mode: ConvertMode;
  template: ScriptTemplate;
  sourceTemplate?: ScriptTemplate | 'auto';
}

export interface ConversionOutput {
  bytes: Uint8Array;
  extension: 'js' | 'txt';
  preview: string;
  bpm: number;
  noteCount: number;
  groupCount: number;
  template: ScriptTemplate;
}

export interface DesktopConvertRequest extends ConversionOptions {
  inputPaths: string[];
  outputDirectory: string;
}

export interface DesktopConvertItem {
  inputPath: string;
  outputPath?: string;
  ok: boolean;
  error?: string;
  bpm?: number;
  noteCount?: number;
  elapsedMs: number;
}

export interface DesktopConvertResult {
  items: DesktopConvertItem[];
  success: number;
  failed: number;
  elapsedMs: number;
}

export interface HistoryItem {
  id: number;
  source_name: string;
  output_name: string;
  mode: string;
  template: string;
  status: number;
  error_message: string;
  note_count: number;
  bpm: number;
  elapsed_ms: number;
  created_at: string;
}

export interface DesktopApi {
  app: {
    version(): Promise<string>;
    paths(): Promise<Record<string, string>>;
  };
  dialogs: {
    chooseFiles(extensions: string[]): Promise<string[]>;
    chooseDirectory(): Promise<string | null>;
  };
  conversion: {
    run(request: DesktopConvertRequest): Promise<DesktopConvertResult>;
  };
  files: {
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    save(request: { suggestedName: string; data: Uint8Array }): Promise<string | null>;
    reveal(path: string): Promise<void>;
  };
  settings: {
    getAll(): Promise<Record<string, unknown>>;
    set(key: string, value: unknown): Promise<void>;
  };
  history: {
    list(limit?: number): Promise<HistoryItem[]>;
    clear(): Promise<void>;
  };
  secrets: {
    hasDeepSeekKey(): Promise<boolean>;
    setDeepSeekKey(value: string): Promise<void>;
    clearDeepSeekKey(): Promise<void>;
  };
  ai: {
    generateChords(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  legacy: {
    importProject(sourceRoot: string): Promise<Record<string, number | string[]>>;
  };
}

declare global {
  interface Window {
    skyforce: DesktopApi;
  }
}
