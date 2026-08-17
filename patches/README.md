# dsh patches — 带图会话切换文本模型（图片降级桥接）

## 快速开始

```powershell
# 在 PowerShell 里执行（不是 dsh agent 里）
node .dsh\skills\dsh-vision-bridge-skill\patches\apply-patch.mjs
```

脚本会自动定位 dsh 安装目录（可通过 `$env:DSH_PKG_ROOT` 覆盖），先语法校验后写盘，失败不动磁盘。首次运行自动把原版备份到 `backups/`。

**生效需重启 `dsh web` 进程。**

## 回滚

```powershell
powershell -ExecutionPolicy Bypass -File .dsh\skills\dsh-vision-bridge-skill\patches\restore.ps1
```

## 问题

DSH 原版有三道"图片能力闸门"，导致**带图会话无法切换到纯文本模型**：

| 位置 | 行为 |
|---|---|
| `dsh-host-apiproxy` `selectModel` | 切换到不支持图片的模型时直接报 `model-unavailable: ... this session already contains images` |
| `dsh-host-apiproxy` `admit` | 当前模型不支持图片时，拒收带图的新消息（`MODEL_DOES_NOT_SUPPORT_IMAGES`） |
| `dsh-llm-pi-ai` `stream` | 请求前检查整段历史，含图且模型无图片能力就抛 `UNSUPPORTED_CONTENT` |

## 补丁行为

1. **apiproxy**：删除前两道闸门（切模型、收新图都放行）。
2. **pi-ai 适配器**：模型不支持图片时不再抛错，把历史中的图片块（含嵌套 tool-result）**降级为文字占位符**，占位符包含：
   - 图片元信息（媒体类型、尺寸、原始文件名）
   - 持久化对象文件路径：`<DSH_HOME>/attachments/v1/objects/<前两位>/<sha256>`
   - attachmentId
3. **deepseek 适配器**（text-only 线路）：同样降级处理。

配合 `dsh-vision-bridge-skill` 的 `vision.js`（SKILL.md / AGENTS.md 已注入识图指令），模型看到占位符里的对象路径后可主动运行
`node vision.js "<对象路径>" "<问题>"` 补看图片内容，形成完整桥接闭环。

副作用（正向）：会话标题生成、子代理等所有 pi-ai 线路在文本模型下也自动容忍图片历史。

## 文件

- `apply-patch.mjs`：幂等补丁脚本（先语法校验后写盘，失败不动磁盘；首次运行自动把原版备份到 `backups/`）
- `restore.ps1`：从 `backups/` 回滚三个文件
- `backups/*.index.js.orig`：原版备份（保持首版纯净，不随重复执行覆盖）

## 维护

- dsh 升级/重装后补丁被覆盖 → 重跑 `apply-patch.mjs` 并重启
- 补丁导致异常 → `restore.ps1` 回滚 + 重启，或 `npm install -g @deepseek-ai/dsh` 彻底重置
- 脚本找不到 dsh → 设 `$env:DSH_PKG_ROOT` 指向 `.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`

## 已知边界

- `read_image` 工具（dsh-tool-fs）仍按模型能力拦截，未改动——识图一律走 vision.js，与 AGENTS.md 约定一致。
- 降级只发生在"发给模型的请求"里，会话存储中的原始图片块不受影响；切回多模态模型即恢复原生读图。
- 本机 `dsh-llm-vision-bridge` 插件已替代 `llm-deepseek`，所以 deepseek 线路的降级补丁在本地是冗余无害的（插件在上层做了自动转述）；在其他没有该插件的部署上，补丁提供等效降级。