#!/usr/bin/env node
/**
 * 独立识图脚本 — 调用 OpenAI 兼容格式的 vision 模型（默认千问 VL），按量付费。
 *
 * 用法:
 *   node vision.js <图片路径> [问题]
 *   node vision.js --url <图片链接> [问题]
 *   node vision.js --clipboard [问题]
 *
 * 依赖:
 *   无（自带极简 .env 解析；如已安装 dotenv 也会使用）
 *   DASHSCOPE_API_KEY 环境变量 或 同目录 .env 文件
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");
const { execFileSync } = require("child_process");

// 尝试加载 .env（先找当前目录，再找脚本所在目录）
try { require("dotenv").config(); } catch {}
try { require("dotenv").config({ path: path.resolve(__dirname, ".env") }); } catch {}
// 极简内置 .env 解析（无 dotenv 依赖也能用；不覆盖已存在的环境变量）
try {
  const envText = fs.readFileSync(path.resolve(__dirname, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY = process.env.DASHSCOPE_API_KEY || "sk-xxx";
const MODEL = process.env.VISION_MODEL || "xxx";
const MAX_TOKENS = Number.parseInt(process.env.VISION_MAX_TOKENS || "1024", 10) || 1024;

function parseArgs() {
  const argv = process.argv.slice(2);
  let imageSource = "", prompt = "", isUrl = false, useClipboard = false, noFallback = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--clipboard") {
      useClipboard = true;
    } else if (argv[i] === "--no-fallback") {
      noFallback = true;
    } else if (argv[i] === "--url" && argv[i + 1]) {
      isUrl = true;
      imageSource = argv[++i];
    } else if (useClipboard && !argv[i].startsWith("--")) {
      prompt = prompt ? prompt + " " + argv[i] : argv[i];
    } else if (!imageSource && !argv[i].startsWith("--")) {
      imageSource = argv[i];
    } else if (imageSource && !argv[i].startsWith("--")) {
      prompt = prompt ? prompt + " " + argv[i] : argv[i];
    }
  }
  if (/^https?:\/\//i.test(imageSource)) {
    isUrl = true;
  }
  if (!prompt) prompt = "请详细描述这张图片的内容。";
  return { imageSource, prompt, isUrl, useClipboard, noFallback };
}

function getClipboardReader() {
  // 注意：stdio 用 "ignore" 而非 "pipe"——DSH 沙箱环境禁止子进程的管道捕获（EPERM），
  // 而剪贴板脚本把图片写入文件、不依赖 stdout，所以 "ignore" 完全够用。
  if (process.platform === "darwin") {
    return (outPath) => {
      execFileSync("/usr/bin/swift", [path.join(__dirname, "clipboard.swift"), outPath], {
        stdio: "ignore",
      });
      return outPath;
    };
  }
  if (process.platform === "win32") {
    return (outPath) => {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Sta",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "clipboard.ps1"),
          "-OutFile",
          outPath,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      return outPath;
    };
  }
  return null;
}

function readClipboardImage() {
  const reader = getClipboardReader();
  if (!reader) {
    throw new Error(
      `剪贴板读取暂不支持当前平台: ${process.platform}（目前支持 macOS / Windows）`,
    );
  }
  const outPath = path.join(os.tmpdir(), `vision-clipboard-${Date.now()}.png`);
  return reader(outPath);
}

/** 按文件头魔数识别图片格式（用于无扩展名的文件，如 DSH 附件对象）。 */
function sniffMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return null;
}

function resolveImageUrl(source, isUrl) {
  if (isUrl) return source;
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase().replace(".", "");
  const mimeMap = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };
  const data = fs.readFileSync(resolved);
  const mime = mimeMap[ext] || sniffMime(data) || "jpeg";
  return `data:image/${mime};base64,${data.toString("base64")}`;
}

function request(payload) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${data.slice(0, 300)}`));
        try {
          resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    // 防止识图请求长时间挂起（DSH 工具调用场景下超时挂死不可接受）
    req.setTimeout(90000, () => req.destroy(new Error("请求超时（90 秒）")));
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY || API_KEY === "sk-xxx") {
    console.error("请先配置 API Key：编辑脚本同目录的 .env 文件，设置 DASHSCOPE_API_KEY。");
    console.error("阿里云百炼申请 Key: https://bailian.console.aliyun.com/ （新用户有免费额度）");
    process.exit(1);
  }
  if (!MODEL || MODEL === "xxx") {
    console.error("请先配置模型名：编辑脚本同目录的 .env 文件，设置 VISION_MODEL（如 qwen-vl-max）。");
    process.exit(1);
  }
  const { imageSource, prompt, isUrl, useClipboard, noFallback } = parseArgs();
  let source = imageSource;

  const tryClipboard = () => {
    try {
      source = readClipboardImage();
      console.error("（未提供可用图片路径，已自动回退读取系统剪贴板）");
      return true;
    } catch (err) {
      console.error("剪贴板读取失败:", err.message);
      return false;
    }
  };

  const showUsage = () => {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js --url <图片链接> [问题]");
    console.error("      node vision.js --clipboard [问题]");
  };

  if (useClipboard) {
    if (imageSource || isUrl) {
      console.error("--clipboard 不能和图片路径或 --url 同时使用。");
      process.exit(1);
    }
    if (!tryClipboard()) process.exit(1);
  } else if (source && !isUrl) {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) {
      if (noFallback) {
        console.error(`文件不存在: ${resolved}`);
        process.exit(1);
      }
      if (!tryClipboard()) process.exit(1);
    }
  } else if (!source) {
    if (noFallback) {
      showUsage();
      process.exit(1);
    }
    if (!tryClipboard()) process.exit(1);
  }

  if (!source) {
    showUsage();
    process.exit(1);
  }
  try {
    const imageUrl = resolveImageUrl(source, isUrl);
    const result = await request({
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: prompt },
      ]}],
      stream: false,
      max_tokens: MAX_TOKENS,
    });
    console.log(result);
  } catch (err) {
    console.error("识图失败:", err.message);
    process.exit(1);
  }
}

main();
