---
name: dsh-vision-bridge-skill
description: 当用户需要在 dsh web 中配置、修复或验证“图片 → 其他 VLM 识图 → 返回 DeepSeek 输出”的路由（视觉桥接）时使用。包含安装、配置、凭据、重启、验证与回滚的完整步骤。安全红线：严禁泄露、打印或提交任何 API Key。
---

# 视觉桥接安装/维护助手（Vision Bridge Skill）

把 dsh web 会话默认模型（deepseek-v4-flash，纯文本）变成“能看图”的模型：聊天里粘贴/拖拽的图片由 OpenAI 兼容的视觉 API（默认阿里云百炼 qwen-vl-max）转成文字描述，再把纯文本请求交给 DeepSeek 输出最终回答。图片描述按 sha256 缓存，同一张图只识别一次。

## 何时使用

- 用户要求配置/启用“VLM 识图 → DeepSeek 输出”的路由
- 用户报告发图失败、模型目录为空、模型选择器只剩一个模型、粘贴图片无法发送
- 用户要求验证桥接是否生效、更换识图 Key、回滚桥接

## 工作流（按序执行）

1. **读 README**：先读本技能目录下 `README.md`，它是安装/配置/验证/回滚的唯一权威手册；执行前先核对其中“安全红线”。
2. **检查现状**（只读）：确认 dsh web 是否运行（`http://127.0.0.1:3080`）、`llm-vision-bridge` 是否已安装（`<DSH_HOME>/profiles/node_modules/dsh-llm-vision-bridge`）、`cordis.patch.yml` 是否已打补丁。
3. **执行安装**：优先用 `scripts/install.ps1`（幂等）；不能运行脚本时，严格按 README“手动安装”章节操作，逐条执行。
4. **配置凭据**：`DASHSCOPE_API_KEY` 写入 `<DSH_HOME>/.credentials.yaml`（或注入环境变量）。Key 只允许：
   - 从环境变量 / 凭据文件 / 用户提供的 `.env` 读取；
   - 回显时只显示**末 4 位**（掩码）。
   任何情况下不得把完整 Key 写入本技能目录、输出到终端或提交到 git。
5. **重启并验证**：重启 `dsh web`（代码改动必须重启才生效），用 `scripts/verify.ps1` 或 README 的验证步骤确认：provider 为 “DeepSeek (视觉桥接)” 且 active、模型目录含 deepseek-v4-flash 与 deepseek-v4-pro、真实识图调用返回 200。
6. **交付**：告知用户改动清单与回档方法；把现象、验证结果、失败原因如实汇报。

## 安全红线（强制）

- **绝不**把真实 `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` 写入任何将被发布、提交或分发的文件（本技能只允许 `.env.example` 占位符）。
- **绝不**在终端、日志或回复里回显完整 Key；对比 Key 只允许用末 4 位。
- 安装脚本 `scripts/install.ps1` 已内置掩码逻辑，不要绕开它手写回显。
- 发布前必须检查：`.gitignore` 覆盖 `.env`、`*.key`、`.credentials.yaml`、`settings.yaml`、`*.log`；仓库里不允许出现真实 Key。

## 文件地图

| 路径 | 作用 |
|---|---|
| `README.md` | 权威手册：架构、安装、配置、验证、回滚、排错 |
| `plugin/` | 桥接插件源码（含两处关键修复），复制到 `<DSH_HOME>/profiles/node_modules/` |
| `scripts/install.ps1` | 一键安装（复制插件 + 打补丁 + 写凭据，掩码输出） |
| `scripts/verify.ps1` | 验证（provider/模型目录探测 + 真实识图调用，掩码输出） |
| `scripts/restart-dsh-web.ps1` | 脱离进程树重启 dsh web |
| `templates/cordis.patch.yml` | 配置文件补丁模板（替换 `[]`，不是追加） |
| `templates/settings.example.yaml` | `llm-vision-bridge:` 设置示例（均为默认值） |
| `.env.example` | 识图环境变量占位模板 |
