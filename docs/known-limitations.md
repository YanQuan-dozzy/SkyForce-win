# 已知限制

- AutoJS 脚本依赖目标 Android 设备上的 Auto.js 兼容运行环境；桌面应用负责生成脚本，不模拟 Android 点击。
- MIDI 支持 Standard MIDI File Format 0/1 和 PPQN 时间，不支持 SMPTE 时间格式、Format 2 以及完整演奏控制器语义。
- MIDI 到 15/21 键使用音高折叠/裁剪策略，超出 SkyStudio 音域的乐句无法做到音色级等价。
- 简谱图片采用本地 Canvas 排版，不复刻旧网页的全部字体和主题。
- 旧版账户、管理员、邮件验证码和服务器多用户权限在单机版中没有意义，已替换为 Windows 用户级本地数据隔离。
- 自定义音色包目前通过旧项目资料归档导入；编辑器直接可选的是随包附带的两套音色和合成音。
- DeepSeek 是唯一需要网络的功能，接口可用性、费用、模型输出和区域网络由服务商决定。
- 当前 EXE 未做 Authenticode 签名，首次下载运行时 SmartScreen 可能提示未知发布者。
