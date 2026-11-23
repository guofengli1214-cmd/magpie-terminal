// 第二 AI 审阅（PROTOCOL-AGENT.md §5.1）。
//
// 为什么用 generateText + 强制 toolChoice 而不是 generateObject：
// 本网关不支持 responseFormat，实测 generateObject 报 AI_NoObjectGeneratedError。
// 强制工具调用是唯一稳定拿到结构化结论的路径。
//
// 审阅是「决定要不要问用户」，不是「决定能不能跑」：
// 任何失败都返回 risk:null，由 judge() 落到 confirm（fail-closed）。

import { generateText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { DEFAULT_MODEL, gatewayBaseUrl } from "./gateway.mjs";

/** 单次审阅的超时（PROTOCOL §5：8s）。 */
export const REVIEW_TIMEOUT_MS = 8000;

/** 审阅提示词：逐字来自 PROTOCOL-AGENT.md §5.1，一个字符都不许改。 */
export const REVIEW_SYSTEM_PROMPT = [
  "你是命令安全审阅员。给你一条即将在用户电脑上执行的 shell 命令，你只做风险评估，不执行任何命令。",
  "判断标准：",
  "- safe：只读，或对系统状态没有任何改动（ls、cat、grep、find 只读形式、git status、pwd、stat、wc、head、tail、du、ps、df、which、echo）",
  "- caution：有改动但可以撤销，或改动范围明确且有限（mkdir、touch、cp 到新路径、mv 到明确目标、追加写入新文件、npm install、git add、git commit）",
  "- danger：不可逆、影响范围大、可能删数据、提权、改系统配置（rm -rf、dd、mkfs、chmod/chown -R、sudo、格式化、覆盖已有文件、git reset --hard、git push --force）",
  "reversible 表示「用户能不能自己轻松恢复」。删除未备份的文件、覆盖已有文件都不算可逆。",
  "命令里出现 sudo / su 一律 danger。",
  "不要因为命令看起来是用户要求的就放松标准。",
].join("\n");

/** 审阅工具的 schema（PROTOCOL §5.1，字段名逐字一致）。 */
const reviewTools = {
  review_command: tool({
    description: "给出这条 shell 命令的风险评估",
    inputSchema: z.object({
      risk: z.enum(["safe", "caution", "danger"]),
      why: z.string(),
      reversible: z.boolean(),
    }),
    // 不要写 execute：只需要模型填参数。
  }),
};

let cachedProvider = null;
let cachedProviderBase = null;

/** 指向 magpie 网关的 OpenAI 兼容 provider（网关不校验 key，但 SDK 要求非空）。 */
function providerFor(baseUrl) {
  if (cachedProvider && cachedProviderBase === baseUrl) return cachedProvider;
  cachedProviderBase = baseUrl;
  cachedProvider = createOpenAICompatible({
    name: "magpie",
    baseURL: `${baseUrl}/v1`,
    apiKey: "magpie",
  });
  return cachedProvider;
}

/** 选出审阅要用的模型 id。 */
export function resolveReviewModel(reviewModel) {
  if (typeof reviewModel === "string" && reviewModel.trim().length > 0) return reviewModel.trim();
  return process.env.MAGPIE_TERMINAL_MODEL || DEFAULT_MODEL;
}

/**
 * 审阅一条命令。
 *
 * @param {{command: string, model?: string|null, cwd?: string}} input
 * @returns {Promise<{risk:"safe"|"caution"|"danger"|null, why:string, reversible:boolean|null, model:string}>}
 *   失败不抛错：`{risk:null, why:"审阅服务不可用", reversible:null, model}`
 */
export async function reviewCommand({ command, model, cwd } = {}) {
  const reviewModel = resolveReviewModel(model);
  const fallback = { risk: null, why: "审阅服务不可用", reversible: null, model: reviewModel };
  if (typeof command !== "string" || command.trim().length === 0) return fallback;

  try {
    const provider = providerFor(gatewayBaseUrl());
    const result = await generateText({
      model: provider(reviewModel),
      system: REVIEW_SYSTEM_PROMPT,
      tools: reviewTools,
      toolChoice: { type: "tool", toolName: "review_command" },
      stopWhen: stepCountIs(1),
      abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      messages: [
        {
          role: "user",
          content: `命令：${command}\n当前目录：${typeof cwd === "string" && cwd.length > 0 ? cwd : "（未知）"}`,
        },
      ],
    });

    const verdict = result?.steps?.[0]?.toolCalls?.[0]?.input;
    if (!verdict || typeof verdict !== "object") return fallback;
    const risk = verdict.risk;
    if (risk !== "safe" && risk !== "caution" && risk !== "danger") return fallback;
    return {
      risk,
      why: typeof verdict.why === "string" && verdict.why.trim().length > 0 ? verdict.why : "（模型没有说明理由）",
      reversible: typeof verdict.reversible === "boolean" ? verdict.reversible : null,
      model: reviewModel,
    };
  } catch {
    return fallback;
  }
}
