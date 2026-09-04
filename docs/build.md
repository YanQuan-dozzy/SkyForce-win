# 构建与发布

## 环境

- Windows 10/11 x64
- Node.js 24.x
- npm
- 构建时可访问 npm/Electron 下载源

最终用户不需要这些环境。

## 命令

```powershell
npm ci --cache .npm-cache
npm run typecheck
npm test
npm run build
npm run dist:win
```

`npm run dist:win` 会产生 NSIS 安装程序、便携 EXE 和 `win-unpacked` 目录。若依赖已安装，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipInstall
```

## 包验收

```powershell
npm run verify:package
npm run verify:installer
```

便携版验收脚本以隔离的临时用户数据目录启动程序，等待页面加载和程序正常退出，并检查日志及 SQLite 自动初始化，最后输出 SHA-256。安装包验收脚本执行静默安装、启动已安装程序的自检，再运行卸载程序。

## 发布建议

当前产物未做 Authenticode 代码签名，Windows SmartScreen 可能显示未知发布者。正式分发时应配置受信任代码签名证书；签名不改变应用业务逻辑。
