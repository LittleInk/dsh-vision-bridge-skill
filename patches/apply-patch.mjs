#!/usr/bin/env node
/**
 * DSH local patch: allow image-bearing sessions to run on text-only models.
 *
 * What it changes (three runtime files under the installed dsh package):
 *   1. dsh-host-apiproxy/lib/index.js
 *      - selectModel: drop the "model-unavailable" gate that forbids switching to a
 *        text-only model while the session history contains images.
 *      - admit: drop the "MODEL_DOES_NOT_SUPPORT_IMAGES" rejection for new messages
 *        that carry images while a text-only model is selected.
 *   2. dsh-llm-pi-ai/lib/index.js
 *      - stream(): instead of throwing UNSUPPORTED_CONTENT when the active model is
 *        text-only but the conversation contains images, downconvert every image
 *        block (recursively, including nested tool results) into a text placeholder
 *        that names the durable object file under DSH_HOME/attachments/v1/objects.
 *   3. dsh-llm-deepseek/lib/index.js
 *      - serializeMessages(): same downconversion for this text-only wire route.
 *
 * Idempotent: re-running skips already-applied operations.
 * Safe: every result is syntax-checked (as ESM) BEFORE anything is written; on any
 * failure nothing touches disk. Pristine backups land in ./backups on first run.
 *
 * After patching, restart the dsh server (the `dsh web` process) to load the code.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Locate dsh's internal @deepseek-ai dir: env override, npm global root, then the Windows default. */
function findPkgRoot() {
	const candidates = [];
	if (process.env.DSH_PKG_ROOT) candidates.push(process.env.DSH_PKG_ROOT);
	try {
		const npm = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" });
		if (npm.status === 0 && npm.stdout) candidates.push(join(npm.stdout.trim(), "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
	} catch {}
	if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
	if (process.env.HOME) candidates.push(join(process.env.HOME, ".npm-global", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "dsh-host-apiproxy", "lib", "index.js"))) return candidate;
	}
	throw new Error(`dsh install not found.\n\nTried:\n  ${candidates.join("\n  ")}\n\nSet DSH_PKG_ROOT to the .../@deepseek-ai directory inside your dsh installation.`);
}
const PKG_ROOT = findPkgRoot();
const FILES = {
  apiproxy: join(PKG_ROOT, "dsh-host-apiproxy", "lib", "index.js"),
  piai: join(PKG_ROOT, "dsh-llm-pi-ai", "lib", "index.js"),
  deepseek: join(PKG_ROOT, "dsh-llm-deepseek", "lib", "index.js"),
};
/** Backups live next to this script (patches/backups), wherever the skill is installed. */
const BACKUP_DIR = fileURLToPath(new URL("./backups", import.meta.url));

const log = (m) => console.log(`[dsh-patch] ${m}`);
const fail = (m) => { throw new Error(m); };

function findLine(lines, needle) {
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) fail(`marker not found: ${JSON.stringify(needle.slice(0, 60))}...`);
  return idx;
}

/** Index of the line where the brace opened on `start` closes again (template-literal interpolations are balanced per line). */
function braceEnd(lines, start) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (opened && depth === 0) return i;
  }
  fail("brace balance not reached");
}

function syntaxOk(source, label) {
  const tmp = join(tmpdir(), `dsh-patch-check-${label}.mjs`);
  writeFileSync(tmp, source);
  const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  if (res.status !== 0) fail(`syntax check failed for ${label}:\n${res.stderr}`);
  log(`syntax OK: ${label}`);
}

const PIAI_HELPERS = [
  "/** Local patch (dsh-patches): placeholder text for one image block when the active model is text-only. */",
  "function imagePlaceholderText(ref, store) {",
  "\tconst id = ref === void 0 ? \"\" : String(ref.attachmentId ?? \"\");",
  "\tconst sha256 = /^sha256:([a-f0-9]{64})$/.exec(id)?.[1];",
  "\tconst described = [ref?.mediaType, ref?.width !== void 0 && ref?.height !== void 0 ? `${ref.width}x${ref.height}` : void 0, ref?.name].filter(Boolean).join(\", \");",
  "\tconst objectFile = sha256 !== void 0 && store?.root !== void 0 ? `${store.root}/objects/${sha256.slice(0, 2)}/${sha256}` : void 0;",
  "\treturn `[image not sent: the active model does not accept image input (${described}${objectFile === void 0 ? \"\" : `; durable object file: ${objectFile}`}; attachmentId ${id || \"unknown\"}). Image pixels are invisible to this model; run a vision helper on the object file to recover the content if needed.]`;",
  "}",
  "/** Local patch (dsh-patches): recursively replace image blocks with text placeholders. */",
  "async function downconvertImages(blocks, store) {",
  "\tconst out = [];",
  "\tfor (const block of blocks) {",
  "\t\tif (block.type === \"image\") out.push({ type: \"text\", text: imagePlaceholderText(block.attachment, store) });",
  "\t\telse if (block.type === \"tool-result\") out.push({ ...block, content: await downconvertImages(block.content, store) });",
  "\t\telse out.push(block);",
  "\t}",
  "\treturn out;",
  "}",
  "",
];

const DEEPSEEK_FN = [
  "/** Local patch (dsh-patches): placeholder for one image block on this text-only wire route. */",
  "function imagePlaceholderText(ref) {",
  "\tconst id = ref === void 0 ? \"\" : String(ref.attachmentId ?? \"\");",
  "\treturn `[image not sent: the active model does not accept image input (attachmentId ${id || \"unknown\"}).]`;",
  "}",
  "/** Local patch (dsh-patches): recursively replace image blocks with text placeholders. */",
  "function downconvertImages(blocks) {",
  "\treturn blocks.map((block) => block.type === \"image\" ? { type: \"text\", text: imagePlaceholderText(block.attachment) } : block.type === \"tool-result\" ? { ...block, content: downconvertImages(block.content) } : block);",
  "}",
  "function serializeMessages(messages) {",
  "\tconst wire = [];",
  "\tfor (const message of messages) {",
  "\t\tconst content = downconvertImages(message.content);",
  "\t\tassertTextOnly(content);",
  "\t\tif (message.role === \"system\") {",
  "\t\t\twire.push({ role: \"system\", content: flattenText(content) });",
  "\t\t\tcontinue;",
  "\t\t}",
  "\t\tif (message.role === \"assistant\") {",
  "\t\t\twire.push(serializeAssistant({ ...message, content }));",
  "\t\t\tcontinue;",
  "\t\t}",
  "\t\tconst toolResults = content.filter((block) => block.type === \"tool-result\");",
  "\t\tconst text = flattenText(content);",
  "\t\tif (text.length > 0 || toolResults.length === 0) wire.push({ role: \"user\", content: text });",
  "\t\tfor (const result of toolResults) wire.push({ role: \"tool\", tool_call_id: result.toolCallId, content: flattenText(result.content) || \"(no output)\" });",
  "\t}",
  "\treturn wire;",
  "}",
];

const operations = [
  {
    key: "apiproxy",
    desc: "selectModel: drop image-capability gate",
    applied: (s) => !s.includes("already contains images"),
    run(lines) {
      const start = findLine(lines, "if ([...found.agent.inbox.nextTurn");
      if (!lines[start].includes("messagesHaveImage")) fail("unexpected selectModel context");
      const end = braceEnd(lines, start);
      const indent = lines[start].match(/^\s*/)[0];
      lines.splice(start, end - start + 1,
        `${indent}// local patch (dsh-patches): image-bearing sessions may switch to text-only models;`,
        `${indent}// images are downconverted to placeholders at LLM request time instead of blocking the switch.`);
    },
  },
  {
    key: "apiproxy",
    desc: "admit: drop MODEL_DOES_NOT_SUPPORT_IMAGES rejection",
    applied: (s) => !s.includes("MODEL_DOES_NOT_SUPPORT_IMAGES"),
    run(lines) {
      const start = findLine(lines, "if (hasImage) {");
      const end = braceEnd(lines, start);
      const indent = lines[start].match(/^\s*/)[0];
      lines.splice(start, end - start + 1,
        `${indent}// local patch (dsh-patches): new images are admitted for text-only models too;`,
        `${indent}// they persist durably and are downconverted at LLM request time.`);
    },
  },
  {
    key: "piai",
    desc: "stream: downconvert instead of UNSUPPORTED_CONTENT throw",
    applied: (s) => s.includes("downconvertImages(message.content, store)"),
    run(lines) {
      const start = findLine(lines, "const containsImage = options.messages.some");
      if (!lines[start + 1].includes("does not support image input")) fail("unexpected stream context");
      const end = findLine(lines, "const context = attachments === void 0 ? toPiContext(options)", start);
      const base = lines[start].match(/^\s*/)[0];
      lines.splice(start, end - start + 1,
        `${base}let conversation = options.messages;`,
        `${base}let containsImage = conversation.some((message) => contentHasImage(message.content));`,
        `${base}if (containsImage && !model.input.includes("image")) {`,
        `${base}\t// local patch (dsh-patches): the session carries images but this model is text-only -`,
        `${base}\t// downconvert image blocks to durable-path text placeholders instead of failing the turn.`,
        `${base}\tconst store = this.config.resolveAttachments?.();`,
        `${base}\tconversation = [];`,
        `${base}\tfor (const message of options.messages) conversation.push({ ...message, content: await downconvertImages(message.content, store) });`,
        `${base}\tcontainsImage = false;`,
        `${base}}`,
        `${base}const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;`,
        `${base}if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");`,
        `${base}const context = attachments === void 0 ? toPiContext({ ...options, messages: conversation }) : await toPiContext({ ...options, messages: conversation }, attachments);`);
    },
  },
  {
    key: "piai",
    desc: "add downconvert helpers",
    applied: (s) => s.includes("function downconvertImages("),
    run(lines) {
      const anchor = findLine(lines, "function toPiContext(options, attachments) {");
      lines.splice(anchor, 0, ...PIAI_HELPERS);
    },
  },
  {
    key: "deepseek",
    desc: "serializeMessages: downconvert instead of reject",
    applied: (s) => s.includes("function downconvertImages("),
    run(lines) {
      const start = findLine(lines, "function serializeMessages(messages) {");
      const end = braceEnd(lines, start);
      if (!lines[end - 1].includes("return wire;")) fail("unexpected serializeMessages shape");
      lines.splice(start, end - start + 1, ...DEEPSEEK_FN);
    },
  },
];

mkdirSync(BACKUP_DIR, { recursive: true });
const sources = {};
for (const [key, file] of Object.entries(FILES)) sources[key] = readFileSync(file, "utf8");

for (const op of operations) {
  if (op.applied(sources[op.key])) { log(`skip (already applied): ${op.desc}`); continue; }
  const nl = sources[op.key].includes("\r\n") ? "\r\n" : "\n";
  const lines = sources[op.key].split(/\r?\n/);
  op.run(lines);
  sources[op.key] = lines.join(nl);
  log(`patched: ${op.desc}`);
}

for (const [key, source] of Object.entries(sources)) syntaxOk(source, key);

for (const [key, file] of Object.entries(FILES)) {
  const backup = join(BACKUP_DIR, `${key}.index.js.orig`);
  if (!existsSync(backup)) { copyFileSync(file, backup); log(`backup created: ${backup}`); }
}
for (const [key, file] of Object.entries(FILES)) {
  if (sources[key] !== readFileSync(file, "utf8")) { writeFileSync(file, sources[key]); log(`written: ${file}`); }
}
log("done - restart the dsh server (the `dsh web` process) to load the patched modules");
