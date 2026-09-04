# 测试报告

测试环境：Windows 11 x64，Node.js 24，Electron 43.2.0。

## 自动测试覆盖

- SkyStudio JSON 的同时音分组
- UTF-16LE BOM TXT 解码与导出
- ABC 音符解析
- `press`、`press_new`、`long_press` 三种模板语义往返
- 源模板自动识别
- 编辑器脚本反向解析
- 1075 音符长谱不跳过开头音符的回归测试
- TypeScript Renderer/Main 严格类型检查

执行：

```powershell
npm run build
```

包级验收：

```powershell
npm run verify:package
```

包级脚本使用全新临时数据目录启动正式便携 EXE，验证 8 个页面、Preload IPC、退出码、日志和 SQLite 初始化。

## 1.0.0 发布验收

执行日期：2026-07-25。

- TypeScript 类型检查：通过
- Vitest：1 个测试文件、9 项测试全部通过
- 生产构建：通过，42 个 WAV 音色文件已进入输出目录
- 便携版成品自检：通过，SQLite 和日志完成全新初始化
- NSIS：静默安装、已安装程序启动及静默卸载全部通过，卸载退出码 0
- `SkyForce-1.0.0-x64-portable.exe`：99,686,324 字节；SHA-256 `AE02C06A05139C66B3F2877BF0742DC51ECE2A175EC1455AFDF67755EAD3EA42`
- `SkyForce-1.0.0-x64-setup.exe`：99,979,263 字节；SHA-256 `95EA1229E77ADE7F57935EA0BAAC87AB1D07B50177CEACE12CCEFC77E1963077`
- Authenticode：未签名；功能验收通过，但正式外部分发可能触发 SmartScreen 提示
