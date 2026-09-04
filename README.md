# SkyForce Desktop

SkyForce 是对本地 `www.AuToJs.com` 项目核心乐谱业务的 Windows 桌面化迁移。它可以在 Windows 10/11 64 位系统上独立运行，不要求安装 phpStudy、PHP、MySQL、Node.js 或浏览器。

## 功能

- SkyStudio TXT/JSON、ABC 与 AutoJS JS 之间的转换
- `press`、`press_new`、`long_press` 三种脚本模板及模板互转
- 最多 500 个文件的批量转换、转换历史和错误记录
- 15/21 键乐谱编辑、和弦输入、三种试听音色、脚本与 UTF-16LE TXT 导出
- MIDI Format 0/1 转 SkyStudio JSON，支持速度变化、运行状态、量化与八度偏移
- 简谱 PNG 长图、本地规则和弦与可选 DeepSeek 和弦
- 从旧版项目目录迁移模板、下载文件、转换结果和音色资料

## 直接运行

最终用户从 `release` 目录选择：

- `SkyForce-1.0.0-x64-setup.exe`：安装程序
- `SkyForce-1.0.0-x64-portable.exe`：无需安装的便携版

首次启动会在 `%APPDATA%\SkyForce` 自动建立 SQLite 数据库和日志目录。转换和编辑功能默认完全离线；只有选择 DeepSeek AI 时才联网。

## 开发与构建

构建环境要求 Windows x64、Node.js 24.x 和 npm：

```powershell
npm ci --cache .npm-cache
npm run build
npm run dist:win
npm run verify:package
```

也可以执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
```

详细信息见：

- [架构说明](docs/architecture.md)
- [迁移说明](docs/migration.md)
- [构建与发布](docs/build.md)
- [配置和数据](docs/configuration.md)
- [测试报告](docs/test-report.md)
- [已知限制](docs/known-limitations.md)

## 源项目保护

原项目位于 `D:\phpstudy_pro\WWW\www.AuToJs.com`，本桌面项目独立位于 `F:\SkyForce-window`。迁移过程只读取原目录，没有向其中写入文件。
