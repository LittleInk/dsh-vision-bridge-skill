import z from "@deepseek-ai/schemastery";
import {
	LlmAdapter,
	LlmError,
	RetryPolicySchema,
	assertUsableApiKey,
	attributionHeaders,
	contentHasImage
} from "@deepseek-ai/dsh-llm";
import {
	DeepSeekAdapter,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	resolveAdapterOptions
} from "@deepseek-ai/dsh-llm-deepseek";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `llm-vision-bridge` — DeepSeek adapter wrapper with automatic image
 * description. Registers the same `deepseek-official` provider route the
 * stock `llm-deepseek` plugin owns (that row must be disabled in the profile
 * patch), so the default session model `deepseek-v4-flash` keeps working
 * unchanged. Every model request first flattens image blocks (including
 * images nested inside tool results) into text descriptions produced by an
 * OpenAI-compatible vision API, then delegates the text-only request to the
 * real DeepSeek adapter, whose connection facts (baseURL, catalog, thinking,
 * retry policy) are resolved through the same `resolveAdapterOptions` the
 * stock plugin uses — zero drift.
 *
 * Descriptions are cached by attachment sha256 (in-memory plus
 * `$DSH_HOME/attachments/v1/descriptions/<sha256>.json`), so each image is
 * described once and every later turn (retry, compaction) hits the cache.
 * @module dsh-llm-vision-bridge
 */

const name = "llm-vision-bridge";
const inject = ["llm"];
const NS = settingsNamespace("llm-vision-bridge");
const PROVIDER = "deepseek-official";
const DEFAULT_DESCRIPTION_PROMPT = "请用中文详细描述这张图片的内容，包括其中的文字、布局、颜色和所有可辨识的细节，供一个只能阅读文字的模型理解。";
const VISION_CONCURRENCY = 4;

const VisionConfig = z.object({
	apiKeyEnv: z.string().role("credential-ref").default("DASHSCOPE_API_KEY"),
	baseURL: z.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
	model: z.string().default("qwen-vl-max"),
	maxTokens: z.number().step(1).min(1).default(1024),
	timeoutMs: z.number().min(1).default(60000),
	descriptionPrompt: z.string().default(DEFAULT_DESCRIPTION_PROMPT)
});

/** Advisory model catalog identical to the stock `llm-deepseek` plugin. */
const DEFAULT_MODELS = [{
	id: "deepseek-v4-flash",
	name: "DeepSeek-V4-Flash",
	contextWindow: DEFAULT_CONTEXT_WINDOW
}, {
	id: "deepseek-v4-pro",
	name: "DeepSeek-V4-Pro",
	contextWindow: DEFAULT_CONTEXT_WINDOW
}];

const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1)
});

const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY"),
	baseURL: z.string(),
	thinking: z.union(["enabled", "disabled"]),
	reasoningEffort: z.union(["off", "high", "max"]),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema,
	dshHome: z.string(),
	vision: VisionConfig.default({})
});

/** Resolve the vision half of the raw config with defaults and validation. */
function resolveVisionOptions(config) {
	const vision = config.vision ?? {};
	const apiKeyEnv = credentialRef(vision.apiKeyEnv ?? "DASHSCOPE_API_KEY");
	const baseURL = vision.baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
	const model = vision.model ?? "qwen-vl-max";
	const maxTokens = vision.maxTokens ?? 1024;
	const timeoutMs = vision.timeoutMs ?? 60000;
	const descriptionPrompt = vision.descriptionPrompt ?? DEFAULT_DESCRIPTION_PROMPT;
	const home = resolveDshHome(config.dshHome);
	return {
		apiKeyEnv,
		baseURL,
		model,
		maxTokens,
		timeoutMs,
		descriptionPrompt,
		cacheDir: join(home, "attachments", "v1", "descriptions")
	};
}

function cacheFileName(attachmentId) {
	return `${String(attachmentId).replace(/^sha256:/, "")}.json`;
}

/** Best-effort disk cache read; any failure is treated as a miss. */
async function loadCachedDescription(cacheDir, attachmentId) {
	try {
		const raw = await readFile(join(cacheDir, cacheFileName(attachmentId)), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.text === "string" && parsed.text.length > 0) return parsed.text;
	} catch {}
	return void 0;
}

/** Best-effort disk cache write; a failure must never fail the request. */
async function storeCachedDescription(cacheDir, attachmentId, text) {
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(join(cacheDir, cacheFileName(attachmentId)), JSON.stringify({ text }), "utf8");
	} catch {}
}

/**
 * One OpenAI-compatible vision call: one image plus the description prompt.
 * @returns the model's trimmed text description.
 */
async function callVision(vision, resolveKey, data, mediaType, prompt, signal) {
	const apiKey = await resolveKey();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), vision.timeoutMs);
	const wireSignal = signal === void 0 ? controller.signal : AbortSignal.any([signal, controller.signal]);
	try {
		const response = await fetch(`${vision.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				...attributionHeaders()
			},
			body: JSON.stringify({
				model: vision.model,
				messages: [{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: `data:${mediaType};base64,${Buffer.from(data).toString("base64")}` } }
					]
				}],
				max_tokens: vision.maxTokens,
				stream: false
			}),
			signal: wireSignal
		});
		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.json()).error?.message ?? "";
			} catch {}
			throw new LlmError(`vision bridge: vision API error (HTTP ${response.status})${detail !== "" ? `: ${detail}` : ""}`, "VISION_FAILED", { status: response.status });
		}
		const payload = await response.json();
		const text = payload?.choices?.[0]?.message?.content;
		if (typeof text !== "string" || text.length === 0) throw new LlmError("vision bridge: vision API returned no text content", "VISION_FAILED");
		return text.trim();
	} catch (error) {
		if (error instanceof LlmError) throw error;
		if (signal?.aborted) throw new LlmError("vision bridge: vision request aborted by the caller", "ABORTED", { cause: error });
		if (controller.signal.aborted) throw new LlmError(`vision bridge: vision API timed out after ${vision.timeoutMs}ms`, "TIMEOUT", { cause: error });
		throw new LlmError("vision bridge: vision API request failed", "VISION_FAILED", { cause: error });
	} finally {
		clearTimeout(timer);
	}
}

/** Describe one attachment ref: memory cache, disk cache, then a vision call. */
async function describeImage(ref, deps, signal) {
	const id = String(ref.attachmentId);
	const memory = deps.memory.get(id);
	if (memory !== void 0) return memory;
	const disk = await loadCachedDescription(deps.cacheDir, id);
	if (disk !== void 0) {
		deps.memory.set(id, disk);
		return disk;
	}
	const stored = await deps.attachments.readImage(ref, signal);
	const text = await callVision(deps.vision, deps.resolveKey, stored.data, ref.mediaType, deps.vision.descriptionPrompt, signal);
	deps.memory.set(id, text);
	void storeCachedDescription(deps.cacheDir, id, text);
	return text;
}

/** Describe a list of refs with bounded concurrency, preserving order. */
async function describeAll(refs, deps, signal) {
	const results = new Array(refs.length);
	let cursor = 0;
	const worker = async () => {
		while (true) {
			const index = cursor++;
			if (index >= refs.length) return;
			results[index] = await describeImage(refs[index], deps, signal);
		}
	};
	const workers = Array.from({ length: Math.min(VISION_CONCURRENCY, refs.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * Replace every image block (top-level and nested inside tool results) with
 * an in-place `【图片N：描述】` text block. Returns the original array when
 * nothing changed.
 */
async function flattenBlocks(blocks, deps, signal) {
	const refs = [];
	const collect = (list) => {
		for (const block of list) {
			if (block.type === "image") refs.push(block.attachment);
			else if (block.type === "tool-result" && Array.isArray(block.content)) collect(block.content);
		}
	};
	collect(blocks);
	if (refs.length === 0) return blocks;
	const descriptions = new Map();
	const texts = await describeAll(refs, deps, signal);
	refs.forEach((ref, index) => descriptions.set(String(ref.attachmentId), texts[index]));
	let seen = 0;
	const map = (list) => list.map((block) => {
		if (block.type === "image") {
			const text = descriptions.get(String(block.attachment?.attachmentId)) ?? "";
			seen += 1;
			return { type: "text", text: `【图片${seen}：${text}】` };
		}
		if (block.type === "tool-result" && Array.isArray(block.content)) {
			const nested = map(block.content);
			return nested === block.content ? block : { ...block, content: nested };
		}
		return block;
	});
	return map(blocks);
}

/** Flatten every message that carries images; others pass through untouched. */
async function flattenMessages(messages, deps, signal) {
	if (!messages.some((message) => Array.isArray(message.content) && contentHasImage(message.content))) return messages;
	const out = [];
	for (const message of messages) {
		if (!Array.isArray(message.content) || !contentHasImage(message.content)) {
			out.push(message);
			continue;
		}
		const content = await flattenBlocks(message.content, deps, signal);
		out.push(content === message.content ? message : { ...message, content });
	}
	return out;
}

/** `LlmAdapter` wrapper: delegate metadata queries, preprocess then delegate stream. */
var VisionBridgeAdapter = class extends LlmAdapter {
	constructor(inner, flatten) {
		super();
		this.inner = inner;
		this.flatten = flatten;
	}
	providerInfo(provider) {
		return this.inner.providerInfo(provider);
	}
	providerRetryPolicy(provider) {
		return this.inner.providerRetryPolicy(provider);
	}
	listModels(provider) {
		return this.inner.listModels(provider);
	}
	async resolveModel(provider, model, signal) {
		const resolved = await this.inner.resolveModel(provider, model, signal);
		// The bridge accepts image input — every image block is flattened into
		// a text description before the request reaches DeepSeek — so advertise
		// image support here. The gateway's admission checks (session.prompt /
		// selectModel) reject image content for models that do not declare it,
		// which would otherwise block pasting an image even though the bridge
		// could handle it.
		const modalities = resolved.inputModalities === void 0
			? ["text", "image"]
			: [...new Set([...resolved.inputModalities, "image"])];
		return { ...resolved, inputModalities: modalities };
	}
	async *stream(options) {
		const messages = await this.flatten(options.messages, options.signal);
		yield* this.inner.stream({ ...options, messages });
	}
};

function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-vision-bridge: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	let visionLastRaw;
	let visionLastGood;
	const visionOptions = () => {
		const raw = current();
		if (raw === visionLastRaw && visionLastGood !== void 0) return visionLastGood;
		const next = resolveVisionOptions(raw);
		visionLastRaw = raw;
		visionLastGood = next;
		return next;
	};
	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-vision-bridge", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-vision-bridge", ref);
		}
		throw new LlmError(`llm-vision-bridge: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
	};
	let visionKeyCache;
	const resolveVisionKey = async () => {
		if (visionKeyCache !== void 0) return visionKeyCache;
		const ref = visionOptions().apiKeyEnv;
		const credentials = ctx.get("credentials");
		let key;
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) key = assertUsableApiKey(hit.value, "llm-vision-bridge", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) key = assertUsableApiKey(ambient.value, "llm-vision-bridge", ref);
		}
		if (key === void 0) throw new LlmError(`llm-vision-bridge: no API key for the vision route; store ${ref} through the credentials service, or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
		visionKeyCache = key;
		return key;
	};
	let userId;
	const resolveUserId = () => userId ??= getOrCreateAnonymousUserId();
	const inner = new DeepSeekAdapter({
		options,
		resolveApiKey,
		resolveUserId
	});
	const memory = new Map();
	const flatten = (messages, signal) => {
		const attachments = ctx.get("attachments");
		if (attachments === void 0) throw new LlmError("llm-vision-bridge: the durable attachment service is not mounted", "VISION_FAILED");
		const deps = {
			attachments,
			vision: visionOptions(),
			resolveKey: resolveVisionKey,
			memory,
			cacheDir: visionOptions().cacheDir
		};
		return flattenMessages(messages, deps, signal);
	};
	const bridge = new VisionBridgeAdapter(inner, flatten);
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "DeepSeek (视觉桥接)",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], bridge);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}

export { Config, PROVIDER, VisionBridgeAdapter, apply, flattenBlocks, flattenMessages, inject, name, resolveVisionOptions };
