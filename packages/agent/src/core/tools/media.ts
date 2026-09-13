// Copyright 2026 Michael P. Burgus <https://github.com/NeuralDrifter>
// SPDX-License-Identifier: Apache-2.0

/**
 * The capabilities worth immediate access: generate an image, a video or
 * speech; transcribe audio; describe an image; search the web; query a
 * knowledge base.
 *
 * These wrap specific platform commands with hand-written descriptions and a
 * curated argument set, because they are what the agent is for and the model
 * should not have to discover them. Everything else — and every flag omitted
 * here — stays reachable through `bl_describe_command` and `bl_run_command`.
 */
import type { Language, LocalizedText } from "bailian-cli-core";
import { localize } from "../i18n.ts";
import type { PlatformAccess } from "../platform.ts";
import { buildArgv } from "./bailian.ts";
import type { JsonSchemaProperty } from "./generate.ts";
import type { Tool } from "./registry.ts";

/**
 * Tools that consume media generation credits. Those are a finite,
 * non-renewing balance, so every one of them asks first and says so in the
 * preview — a user should never discover the cost after the fact.
 */
export const SPENDS_CREDITS = [
  "generate_image",
  "generate_video",
  "text_to_speech",
  "transcribe_audio",
] as const;

const COST_NOTE: LocalizedText = {
  "en-US": "spends media credits",
  "zh-CN": "将消耗媒体额度",
};

const FAILED: LocalizedText = {
  "en-US": "Command failed",
  "zh-CN": "命令执行失败",
};

type Props = Record<string, JsonSchemaProperty>;

/** One hot-set tool: a command path, a curated schema, and how to preview it. */
interface MediaSpec {
  name: string;
  path: string;
  description: LocalizedText;
  properties: Props;
  required: string[];
  /** Flags forced on every call, e.g. `--download` so the file lands locally. */
  fixed?: Record<string, unknown>;
  /** Which argument to show in the approval prompt. */
  previewArg: string;
}

const str = (en: string, zh: string): JsonSchemaProperty => ({
  type: "string",
  description: `${en} / ${zh}`,
});
const num = (en: string, zh: string): JsonSchemaProperty => ({
  type: "number",
  description: `${en} / ${zh}`,
});

const SPECS: MediaSpec[] = [
  {
    name: "generate_image",
    path: "image generate",
    description: {
      "en-US":
        "Generate an image from a text prompt and save it into the project. Spends media credits.",
      "zh-CN": "根据文本提示词生成图片并保存到项目中。会消耗媒体额度。",
    },
    properties: {
      prompt: str("What to draw", "要绘制的内容"),
      size: str("Pixel size, e.g. 1024*1024", "像素尺寸，如 1024*1024"),
      n: num("How many images", "生成数量"),
      negativePrompt: str("What to avoid", "需要避免的内容"),
      outDir: str("Directory to write into", "输出目录"),
      outPrefix: str("Filename prefix", "文件名前缀"),
    },
    required: ["prompt"],
    previewArg: "prompt",
  },
  {
    name: "generate_video",
    path: "video generate",
    description: {
      "en-US":
        "Generate a video from a text prompt, or animate a still image. Downloads the result into the project. Slow and spends media credits.",
      "zh-CN":
        "根据文本提示词生成视频，或让静态图片动起来。结果会下载到项目中。耗时较长且会消耗媒体额度。",
    },
    properties: {
      prompt: str("What should happen in the video", "视频内容描述"),
      image: str("Local path or URL of a first frame", "首帧图片的本地路径或 URL"),
      resolution: str("Output resolution", "输出分辨率"),
      ratio: str("Aspect ratio, e.g. 16:9", "画面比例，如 16:9"),
      duration: num("Length in seconds", "时长（秒）"),
    },
    required: ["prompt"],
    // Without this the command returns a URL and nothing reaches the project.
    fixed: { download: true },
    previewArg: "prompt",
  },
  {
    name: "text_to_speech",
    path: "speech synthesize",
    description: {
      "en-US": "Synthesize speech from text and save the audio file. Spends media credits.",
      "zh-CN": "将文本合成为语音并保存音频文件。会消耗媒体额度。",
    },
    properties: {
      text: str("Text to speak", "要朗读的文本"),
      voice: str("Voice name", "音色名称"),
      format: str("Audio format, e.g. mp3", "音频格式，如 mp3"),
      language: str("Language of the text", "文本语言"),
      out: str("Output file path", "输出文件路径"),
    },
    required: ["text"],
    previewArg: "text",
  },
  {
    name: "transcribe_audio",
    path: "speech recognize",
    description: {
      "en-US": "Transcribe an audio or video file to text. Spends media credits.",
      "zh-CN": "将音频或视频文件转写为文本。会消耗媒体额度。",
    },
    properties: {
      url: str("URL of the audio or video", "音频或视频的 URL"),
      language: str("Spoken language hint", "语种提示"),
      out: str("Output file path", "输出文件路径"),
    },
    required: ["url"],
    previewArg: "url",
  },
  {
    name: "describe_image",
    path: "vision describe",
    description: {
      "en-US":
        "Look at an image or video and answer a question about it. Use this whenever you need to see visual content.",
      "zh-CN": "查看图片或视频并回答相关问题。需要「看见」视觉内容时使用。",
    },
    properties: {
      image: str("Local path or URL of an image", "图片的本地路径或 URL"),
      video: str("Local path or URL of a video", "视频的本地路径或 URL"),
      prompt: str("What to ask about it", "想要询问的问题"),
    },
    required: [],
    previewArg: "prompt",
  },
  {
    name: "search_web",
    path: "search web",
    description: {
      "en-US": "Search the web for current information the model does not know.",
      "zh-CN": "联网搜索模型不掌握的最新信息。",
    },
    properties: {
      query: str("What to search for", "搜索内容"),
      count: num("How many results", "结果数量"),
    },
    required: ["query"],
    previewArg: "query",
  },
  {
    name: "retrieve_knowledge",
    path: "knowledge retrieve",
    description: {
      "en-US": "Retrieve passages from a knowledge base index.",
      "zh-CN": "从知识库索引中检索相关内容。",
    },
    properties: {
      indexId: str("Knowledge base index id", "知识库索引 ID"),
      query: str("What to look for", "检索内容"),
      topK: num("How many passages", "返回条数"),
    },
    required: ["indexId", "query"],
    previewArg: "query",
  },
];

const SPENDING = new Set<string>(SPENDS_CREDITS);

/** Drop arguments the model omitted, so absent stays absent. */
function present(args: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

/** The seven first-class capability tools, bound to a platform access. */
export function mediaTools(platform: PlatformAccess, language: Language): Tool[] {
  return SPECS.map((spec): Tool => {
    const allowed = Object.keys(spec.properties);
    const spends = SPENDING.has(spec.name);
    const defs = platform.commands[spec.path]?.flags ?? {};

    return {
      name: spec.name,
      tier: spends ? "ask" : "auto",
      description: spec.description,
      parameters: {
        type: "object",
        properties: spec.properties,
        ...(spec.required.length > 0 ? { required: spec.required } : {}),
      },
      preview: async (args) => {
        const subject = String(args[spec.previewArg] ?? "").slice(0, 200);
        const note = spends ? ` — ${localize(COST_NOTE, language)}` : "";
        return { summary: `${spec.path}: ${subject}${note}` };
      },
      run: async (args) => {
        const flags = { ...present(args, allowed), ...spec.fixed };
        const result = await platform.invoke(buildArgv(spec.path, flags, defs));

        const body = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n");
        if (!result.ok) {
          return `${localize(FAILED, language)} (exit ${result.exitCode})\n${body}`;
        }
        return body.trim() || "(no output)";
      },
    };
  });
}
