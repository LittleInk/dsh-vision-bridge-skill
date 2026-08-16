# dsh-vision-bridge-skill

把 **DeepSeek Harness（dsh）web** 会话变成“能看图”的路由：聊天里粘贴/拖拽的图片先由**其他 VLM**（默认阿里云百炼 `qwen-vl-max`，OpenAI 兼容接口）识别成文字描述，再把纯文本请求交给 **DeepSeek**（`deepseek-v4-flash`）输出最终回答。会话模型保持不变，无需切换模型即可发图。

```
聊天框粘贴图片
   │
   ▼
dsh web 网关（校验模型 inputModalities，本桥接声明支持图片）
   │
   ▼
llm-vision-bridge 插件 ── 图片块 ──▶ qwen-vl-max（DashScope）──▶ 文字描述
   │                                                            │
   └──────────── 纯文本请求（含【图片N：描述】） ────────────────┘
   │
   ▼
DeepSeek（deepseek-v4-flash）──▶ 最终回答
```

- 描述按附件 sha256 缓存（内存 + `<DSH_HOME>/attachments/v1/descriptions/`），同一张图只识别一次。
- 顶层图片块和工具结果里嵌套的图片块都会处理。

---

## ⚠️ 安全红线（先读）

本技能**绝不包含、不打印、不提交任何真实 API Key**：

1. Key 只存在于运行环境：`<DSH_HOME>/.credentials.yaml`（凭据服务）、环境变量、或用户自己的 `.env`（已被 `.gitignore` 忽略）。
2. 脚本/文档**只允许掩码回显** Key 的**末 4 位**用于核对，禁止回显完整 Key。
3. 发布到 GitHub 前，用下面命令全目录扫描，确认没有真实 Key：

```powershell
# 在本技能目录内执行；只应命中 .env.example 里的占位符
Get-ChildItem -Recurse -File | Select-String -Pattern "sk-[A-Za-z0-9]{20,}" | Select-Object Path, LineNumber
```

4. `.env`、`*.key`、`.credentials.yaml`、`settings.yaml`、`*.log` 已加入 `.gitignore`，不要手动 `git add -f`。

---

## 前置条件

| 项目 | 要求 |
|---|---|
| dsh web | 已安装并运行（默认 `http://127.0.0.1:3080`），profile 名 `web` |
| Node.js | ≥ 22（dsh 运行环境自带） |
| 识图 Key | `DASHSCOPE_API_KEY`（阿里云百炼：<https://bailian.console.aliyun.com/>） |
| 对话 Key | `DEEPSEEK_API_KEY`（dsh 原有配置，如已有可跳过；全新环境见下方 ③ 的配置方法） |
| 依赖 | `<DSH_HOME>/profiles/node_modules/@deepseek-ai/` 下需有 rc.6 系列包（dsh 自带） |

---

## 安装

### 方式 A：一键脚本（推荐）

```powershell
# 需要“管理员/更高权限”写入 DSH_HOME 时按提示确认
powershell -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
# 可选参数：-DshHome "C:\Users\xxx\.dsh"  -ProfileName web  -SkipCredentials
```

脚本会（全程掩码，不打印 Key）：
1. 复制 `plugin/` → `<DSH_HOME>/profiles/node_modules/dsh-llm-vision-bridge/`
2. 备份并写入 `profiles/web/cordis.patch.yml`（用 `templates/cordis.patch.yml` 整文件替换）
3. 把 `DASHSCOPE_API_KEY` 写入 `<DSH_HOME>/.credentials.yaml`（自动从环境变量或已有 `.env` 读取；都没有则提示你手动提供，绝不要求你贴进脚本参数里被记录）
4. 提示重启

### 方式 B：手动安装（逐条执行）

**① 复制插件**

```powershell
$dest = Join-Path $env:DSH_HOME "profiles\node_modules\dsh-llm-vision-bridge"
# 目标已存在时先删除，避免新旧文件混在一起（重新安装前务必执行）
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item ".\plugin" $dest -Recurse
# 示例：$env:DSH_HOME 未设置时默认 C:\Users\<你的用户名>\.dsh
```

**② 打补丁（关键：整文件替换，不是追加）**

把 `<DSH_HOME>/profiles/web/cordis.patch.yml` 的**全部内容**替换为（即 `templates/cordis.patch.yml`）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

# Vision bridge: image blocks in chat are flattened into text descriptions by
# an OpenAI-compatible vision API (DashScope qwen-vl-max, key DASHSCOPE_API_KEY)
# and the text-only request is delegated to DeepSeek, which produces the final
# answer. The stock llm-deepseek row is disabled because this bridge registers
# the same `deepseek-official` provider route.
- id: llm-deepseek
  disabled: true
- insert:
    - id: llm-vision-bridge
      name: 'dsh-llm-vision-bridge'
```

> ⚠️ **最常见的坑**：原文件末尾有一行 `[]`（空数组）。必须**删掉这行**再写入上面的内容。如果保留 `[]` 把新条目接在后面，会报
> `YAMLException: missed comma between flow collection entries`。
> 正确结果：文件中**不存在 `[]`**，第一个 `- id:` 条目就是补丁数组的第一项。

> 💾 **先备份**：手动替换前先执行 `Copy-Item "$patchFile" "$patchFile.bak"`，回滚时可还原；若原补丁里有你自己的自定义条目，替换后它们会失效，备份是你恢复的唯一途径。

**③ 配置 Key**

- 识图 Key：把 `DASHSCOPE_API_KEY` 写入 `<DSH_HOME>/.credentials.yaml`（普通 YAML，`键: 值` 一行一条），或导出为环境变量：

```powershell
# 只追加一行（不要覆盖已有内容），值不要贴在文档/聊天里
$cred = Join-Path $env:DSH_HOME ".credentials.yaml"   # 未设置 DSH_HOME 时为 $HOME\.dsh\.credentials.yaml
Add-Content -Path $cred -Value "DASHSCOPE_API_KEY: <你的Key>"
```

- 对话 Key：桥接的 DeepSeek 连接默认引用 `DEEPSEEK_API_KEY`。**全新环境若还没配置对话 Key**，用同样方式在 `.credentials.yaml` 追加一行 `DEEPSEEK_API_KEY: <你的Key>`（或在该环境的 dsh web「模型设置 / Models」页面填写，页面写入的就是这份凭据文件）。

> 不改任何 Key 时可用默认值：识图走 `qwen-vl-max`、`https://dashscope.aliyuncs.com/compatible-mode/v1`；对话走 `DEEPSEEK_API_KEY`、官方端点。需要自定义时参考 `templates/settings.example.yaml`，在 `<DSH_HOME>/settings.yaml` 加 `llm-vision-bridge:` 段（可热加载，无需重启）。

**④ 重启 dsh web**（见下）

---

## 重启

- **插件代码**（`plugin/lib/index.js`、`package.json`）改动：**必须重启进程**才能加载。
- **补丁文件**（`cordis.patch.yml`）与 **`settings.yaml`** 改动：dsh web 启动时注册了 HMR 监听，通常会**热加载生效**，无需重启；但拿不准或想确保干净状态时，一律重启最稳妥。
- 手动：停掉当前 `dsh web` 进程，重新执行启动命令（保持 `DSH_HOME` 与工作目录不变）。
- 脚本：`scripts/restart-dsh-web.ps1` 会杀掉监听端口的进程并拉起新实例（该脚本会**杀死当前托管会话的服务器**，需以脱离进程树的方式运行，例如计划任务，见脚本头部注释）。

重启后**刷新浏览器页面**再继续。

---

## 验证

### ① 网关探测（确认 provider 与模型目录）

```powershell
$body = @{ type = "client-request"; rpcId = "v1"; method = "llm.providers"; payload = @{} } | ConvertTo-Json -Compress
(Invoke-WebRequest -Uri "http://127.0.0.1:3080/api/llm.providers" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing).Content
```

预期：`deepseek-official` 的 `displayName` 为 **DeepSeek (视觉桥接)**、`active` 为 `true`。

```powershell
$body = @{ type = "client-request"; rpcId = "v2"; method = "llm.models"; payload = @{} } | ConvertTo-Json -Compress
(Invoke-WebRequest -Uri "http://127.0.0.1:3080/api/llm.models" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing).Content
```

预期：`groups` 里 provider `deepseek-official` 的 `models` 含 `deepseek-v4-flash` 与 `deepseek-v4-pro`，`failures` 为空。

### ② 真实识图调用（验证 Key 与端点，掩码输出）

用 `scripts/verify.ps1`（自动生成测试图 → 调用 qwen-vl-max → 只回显末 4 位与返回文字）：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\verify.ps1"
```

预期输出形如：`HTTP 200` + 一句图片描述 + `key ...xxxx (masked)`。

> 退出码语义：`0` = 全部通过；`2` = `VERIFY PARTIAL`（provider/目录 OK，但缺少凭据跳过了识图调用，输出会明确标注 SKIP）；其他非 0 = 失败。自动化 agent 务必检查退出码，不要把 `VERIFY PARTIAL` 当成功。

### ③ 界面验证

- 模型设置页：provider 显示“DeepSeek (视觉桥接)”。
- 聊天框粘贴一张图片 → 可直接发送 → DeepSeek 基于识图描述回答。
- 同一张图再发一次：描述走缓存，秒回（可查看 `<DSH_HOME>/attachments/v1/descriptions/` 下的缓存文件）。

---

## 已知问题与排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报 `missed comma between flow collection entries` | 补丁文件保留了 `[]` 行并追加了新条目 | 整文件替换为 `templates/cordis.patch.yml` 内容 |
| 模型选择器只剩一个模型 / 目录为空 | 插件 `Config` 的 `models` 缺默认值（本包已修复：`plugin/lib/index.js` 中 `models: z.array(catalogModel).default(DEFAULT_MODELS)`） | 使用本包 `plugin/` 源码，重启 |
| 粘贴图片发送被拒：`Model does not support image input` | 网关按模型 `inputModalities` 拦截（deepseek 是 `["text"]`） | 本包已修复：`resolveModel` 声明 `["text","image"]`，重启 |
| 识图调用 HTTP 400 / 401 | Key 无效、模型名错、Base URL 错 | 检查 `.credentials.yaml` 中的 `DASHSCOPE_API_KEY`（只核对末 4 位）；参考 `.env.example` |
| 图片尺寸过小（<10px） | qwen-vl-max 限制 | 换正常尺寸图片 |
| 改了插件代码（`plugin/lib/index.js`）后不生效 | 插件模块在启动时加载，HMR 不重载模块代码 | 重启 dsh web |
| 改了 `settings.yaml` / 补丁文件后不生效 | 通常 HMR 会热加载；个别情况（进程未注册监听）未生效 | 重启 dsh web 最稳妥 |
| 换了 `DASHSCOPE_API_KEY` 后识图仍报 401 | 插件在内存中缓存了 Key（每次请求解析一次，进程内只取一次） | 重启 dsh web 或重启进程后生效 |
| 想换识图模型 | 改 `llm-vision-bridge.vision.model`（如 `qwen-vl-ocr`） | 写 `<DSH_HOME>/settings.yaml`，热加载生效 |

---

## 回滚

**完全移除桥接**：

```powershell
# 1. 删除插件
$dest = Join-Path $env:DSH_HOME "profiles\node_modules\dsh-llm-vision-bridge"
Remove-Item $dest -Recurse -Force
# 2. 还原补丁：把 profiles\<ProfileName>\cordis.patch.yml 还原为原内容（或备份文件 .bak-*）
# 3. 删除凭据里追加的 DASHSCOPE_API_KEY 行（.credentials.yaml）
# 4. 如写了 settings.yaml 的 llm-vision-bridge: 段，一并删除
# 5. 重启 dsh web
```

恢复官方 DeepSeek 路由后，`deepseek-v4-flash` 照常工作，但**聊天框不再支持直接发图**。

---

## 发布到 GitHub 检查清单

- [ ] `.env.example` 是唯一含 `sk-` 字样的文件（占位符）
- [ ] `.gitignore` 生效：`.env`、`*.key`、`.credentials.yaml`、`settings.yaml`、`*.log`、`node_modules/`
- [ ] 全目录扫描无真实 Key（见“安全红线”第 3 条命令）
- [ ] `plugin/lib/index.js` 含两处修复（`DEFAULT_MODELS` 默认值与 `inputModalities` 声明）
- [ ] README 的补丁内容与 `templates/cordis.patch.yml` 一致
- [ ] 已在干净环境按 README 走通一次安装 → 验证 → 回滚

---

## 相关

- 运行时识图（把单张图片转文字，与聊天路由无关）：可搭配已有的 `claude-vision-skill`（`vision.js`）使用；注意该技能目录里的 `.env` 含真实 Key，**不要**一起提交。
