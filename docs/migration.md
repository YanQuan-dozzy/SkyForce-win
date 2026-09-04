# 迁移说明

## 原项目梳理

源项目是 ThinkPHP/PHP Web 应用，依赖 phpStudy 或等价 Web/PHP 环境，主要目录包括：

- `app`、`route`、`view`：控制器、路由与页面
- `public/static/js`：转换器、编辑器、MIDI、制图与和弦前端逻辑
- `config`、`.env`、`sql`：运行配置和 MySQL 数据
- `downloads`、`converted`、`public/static/sound-packs`：用户结果与音色资源
- `SkyStudio2Autojs-main`：独立转换算法来源

主要流程为浏览器上传/录入乐谱，经 PHP 控制器或前端 JavaScript 处理后下载结果；用户、模板和部分记录由 MySQL 管理；AI 和弦通过 DeepSeek HTTP API。

## 桌面映射

| 原能力 | 桌面实现 |
| --- | --- |
| PHP 上传与下载 | Windows 原生打开/保存对话框，文件不经过服务器 |
| TXT/JS 转换接口 | TypeScript 纯本地转换核心 |
| MySQL 记录与设置 | 自动初始化的 SQLite |
| Web 编辑器 | 单窗口 15/21 键桌面编辑器 |
| 在线静态资源 | 随 EXE 打包的 HTML/CSS/音色 |
| DeepSeek 代理接口 | Main 进程 HTTPS 请求，DPAPI 密钥 |
| 用户登录/管理员后台 | 删除；单机数据以 Windows 用户隔离 |
| 邮件找回、验证码 | 删除；桌面端不再需要账户体系 |

## 行为兼容与修复

- 保留 1-based 键位、SkyStudio JSON、UTF-16LE BOM TXT 和三种 AutoJS 模板。
- 修正手势模板转换时意外跳过前 5 个音符的问题。
- 修正 JS 反向解析键位映射和 `press_new` 间隔补偿问题。
- 编辑器产生的 `var score = [...]` 脚本也可被反向解析。
- 单批转换使用逐文件错误隔离，避免一个坏文件导致整个批次失败。

## 旧数据导入

“设置与数据 → 导入旧项目资料”会检查所选目录是否具有旧项目特征，然后将 `downloads`、`converted`、`view/tpl` 和音色目录复制到当前用户数据目录的 `legacy-imports` 下，并生成清单。原目录不会被修改。
