import type { LlmSettings, LlmTrace, TermEntry } from '../../shared/contract.js';
import { log } from '../logger.js';

export type CorrectionReason =
  | 'ok'
  | 'timeout'
  | 'disabled'
  | 'error'
  | 'empty'
  | 'rejected'
  | 'unchanged';

export interface CorrectionOutcome {
  /** 最终应该写入的文本 */
  text: string;
  /** 是否用上了纠偏结果 */
  corrected: boolean;
  /** 没纠偏的原因 */
  reason: CorrectionReason;
  /** 本次纠偏耗时 ms */
  ms: number;
  /** 是否是超时后拿到的部分结果 */
  partial: boolean;
  /** 失败时的详细信息 */
  error?: string;
}

export interface CorrectionRequest {
  /** 原始识别文本 */
  text: string;
  /** 本次纠偏的可用时间（毫秒），从调用时刻算起 */
  budgetMs: number;
}

/** 请求的硬上限：超过就真的断开连接（软阈值只影响「等多久」）。 */
const HARD_CAP_MS = 30_000;

/**
 * 关闭「深度思考」用到的参数。
 *
 * 不同厂商的叫法不一样，OpenAI 兼容协议没有统一字段，
 * 所以这里把两种最常见的约定都带上：
 *   - `enable_thinking: false`   —— 通义千问 / DashScope / Kimi
 *   - `thinking: {type:'disabled'}` —— 豆包 / 智谱 GLM
 *
 * 严格校验的服务会因为不认这些字段报 400，
 * 那时候会自动去掉它们重试一次（见 fetchWithFallback）。
 */
const THINKING_OFF_PARAMS: Record<string, unknown> = {
  enable_thinking: false,
  thinking: { type: 'disabled' },
};

/* ------------------------------------------------------------------ */
/* 提示词                                                               */
/* ------------------------------------------------------------------ */

/** 把用户词表整理成提示词里的参考段落。 */
function renderTerms(terms: TermEntry[]): string {
  const lines: string[] = [];
  for (const entry of terms) {
    const term = (entry.term ?? '').trim();
    if (!term) continue;
    const replacement = (entry.replacement ?? '').trim();
    const note = (entry.note ?? '').trim();
    if (replacement) {
      lines.push(`- ${term} → 应写作「${replacement}」${note ? `（${note}）` : ''}`);
    } else {
      lines.push(`- ${term}${note ? `（${note}）` : ''}`);
    }
  }
  return lines.join('\n');
}

function buildSystemPrompt(settings: LlmSettings): string {
  const base = [
    '你是一个语音识别纠错引擎。输入是语音识别引擎转写出的文本，可能存在同音字错别字、专有名词识别错误、数字与符号错误、标点缺失。',
    '',
    '规则：',
    '1. 只修正明确的识别错误，不要改写句式、扩写、缩写、补充或删除任何信息。',
    '2. 保持原文的长度与语序。',
    '3. 原文本没有明显错误时，原样输出。',
    '4. 只输出修正后的文本本身，不要加引号、markdown、解释或任何前后缀。',
  ].join('\n');

  const terms = renderTerms(settings.terms ?? []);
  const parts = [base];
  if (terms) {
    parts.push(
      '',
      '以下是用户自定义的个性化常用词。识别文本里如果出现了它们或它们的同音写法，请优先采用正确写法：',
      terms,
    );
  }
  if (settings.extraSystemPrompt?.trim()) {
    parts.push('', settings.extraSystemPrompt.trim());
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* 结果清洗                                                             */
/* ------------------------------------------------------------------ */

/** 去掉大模型爱加的 markdown 包裹、引号和前后缀。 */
function sanitize(raw: string): string {
  let text = (raw ?? '').trim();
  if (!text) return '';
  text = text.replace(/^```[a-zA-Z]*\s*/g, '').replace(/\s*```$/g, '');
  const quoted = text.match(/^["'“”‘’「『]([\s\S]*)["'“”‘’」』]$/);
  if (quoted) text = quoted[1].trim();
  return text;
}

/**
 * 结果合理性检查：大模型幻觉或者大段扩写时，宁可用原文。
 */
function isPlausible(raw: string, corrected: string): boolean {
  if (!corrected) return false;
  if (corrected.length > raw.length * 3 + 24) return false;
  if (raw.length > 12 && corrected.length < raw.length * 0.3) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 请求                                                                 */
/* ------------------------------------------------------------------ */

/** 拼出 chat/completions 的地址，容忍用户填 /v1 或不填 /v1。 */
function buildEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 把 API Key 打码，留在请求头里也能安全展示。 */
function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

interface StreamResult {
  content: string;
  /** 原始 SSE 文本，留给 trace 看 */
  raw: string;
}

/** 解析 SSE 流，边收边拼 content。 */
async function readStream(response: Response): Promise<StreamResult> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应没有可读的流');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let raw = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string }; text?: string }>;
        };
        const choice = parsed.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.text ?? '';
        if (piece) content += piece;
      } catch {
        /* 忽略无法解析的分片 */
      }
    }
  }
  return { content, raw };
}

/** 一次性读完整个 JSON 响应。 */
async function readJson(response: Response): Promise<string> {
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };
  const choice = json.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? '';
}

/** 判断 400 是不是因为「不认我们多带的参数」。 */
function isUnknownParamError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = bodyText.toLowerCase();
  const mentionsUnknown =
    text.includes('unrecognized') ||
    text.includes('unknown parameter') ||
    text.includes('unknown field') ||
    text.includes('unexpected keyword') ||
    text.includes('not permitted') ||
    text.includes('unsupported parameter') ||
    text.includes('extra fields not permitted');
  if (!mentionsUnknown) return false;
  // 至少点名了我们多带的那两个参数之一，才认定是它的问题
  return text.includes('enable_thinking') || text.includes('thinking');
}

/* ------------------------------------------------------------------ */
/* 纠偏主流程                                                           */
/* ------------------------------------------------------------------ */

/**
 * 纠偏器。
 *
 * 关键设计：**软阈值只决定「等多久」，不掐断请求**。
 * 超时后我们不等了、直接录入原文，但请求还在后台跑，
 * 响应回来后补进 trace —— 这样「为什么超时」「对端到底返回了什么」都能看见。
 */
export class Corrector {
  private trace: LlmTrace | null = null;
  private traceListeners: Array<(trace: LlmTrace) => void> = [];

  /** 取上一次调用的完整记录。 */
  getLastTrace(): LlmTrace | null {
    return this.trace;
  }

  /** 订阅 trace 更新。 */
  onTrace(listener: (trace: LlmTrace) => void): () => void {
    this.traceListeners.push(listener);
    return () => {
      this.traceListeners = this.traceListeners.filter((item) => item !== listener);
    };
  }

  clearTrace(): void {
    this.trace = null;
  }

  private setTrace(trace: LlmTrace): void {
    this.trace = trace;
    for (const listener of this.traceListeners) {
      try {
        listener(trace);
      } catch {
        /* 单个订阅者出错不影响其它人 */
      }
    }
  }

  /**
   * 在给定的时间预算内纠偏。
   *
   * 预算耗尽时**不会**阻塞调用方：直接返回原始文本与 reason='timeout'，
   * 由上层立刻录入。请求本身继续在后台跑，响应会补进 trace。
   */
  async correct(request: CorrectionRequest, settings: LlmSettings): Promise<CorrectionOutcome> {
    const started = Date.now();
    const raw = request.text ?? '';

    if (!settings.enabled) {
      return { text: raw, corrected: false, reason: 'disabled', ms: 0, partial: false };
    }
    if (!raw.trim()) {
      return { text: raw, corrected: false, reason: 'empty', ms: 0, partial: false };
    }
    if (!settings.baseUrl.trim() || !settings.model.trim()) {
      return {
        text: raw,
        corrected: false,
        reason: 'error',
        ms: 0,
        partial: false,
        error: '未配置大模型地址或模型名',
      };
    }

    const budget = Math.max(1, request.budgetMs);

    try {
      const outcome = await this.run(raw, settings, budget);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('llm', `纠偏失败：${message}`);
      return {
        text: raw,
        corrected: false,
        reason: 'error',
        ms: Date.now() - started,
        partial: false,
        error: message,
      };
    }
  }

  /** 发请求 + 等结果。 */
  private async run(
    raw: string,
    settings: LlmSettings,
    budget: number,
  ): Promise<CorrectionOutcome> {
    const started = Date.now();
    const endpoint = buildEndpoint(settings.baseUrl);
    const useThinkingOff = settings.disableThinking !== false;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

    const baseBody: Record<string, unknown> = {
      model: settings.model.trim(),
      messages: [
        { role: 'system', content: buildSystemPrompt(settings) },
        { role: 'user', content: raw },
      ],
      temperature: settings.temperature,
      stream: settings.streaming,
    };
    const requestBody: Record<string, unknown> = useThinkingOff
      ? { ...baseBody, ...THINKING_OFF_PARAMS }
      : { ...baseBody };

    const trace: LlmTrace = {
      at: started,
      url: endpoint,
      headers: { ...headers, Authorization: headers.Authorization ? maskKey(settings.apiKey) : '' },
      requestBody,
      waitedMs: 0,
      timedOut: false,
    };
    this.setTrace(trace);

    const hardAbort = new AbortController();
    const hardCap = setTimeout(() => hardAbort.abort(), HARD_CAP_MS);

    // 请求本身不被软阈值掐断
    const pending = this.fetchWithFallback(endpoint, headers, requestBody, useThinkingOff, hardAbort.signal)
      .then(async (result) => {
        trace.status = result.status;
        trace.responseBody = result.bodyText;
        trace.respondedAt = Date.now();
        this.setTrace(trace);
        return result;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        trace.error = message;
        trace.respondedAt = Date.now();
        this.setTrace(trace);
        throw error;
      });

    // 软阈值：我们等多久
    const softTimer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), budget);
    });

    let result: Awaited<typeof pending>;
    try {
      const raced = await Promise.race([pending, softTimer]);
      if (raced === 'timeout') {
        trace.timedOut = true;
        trace.waitedMs = Date.now() - started;
        this.setTrace(trace);
        log.info('llm', `纠偏超过 ${budget}ms 阈值，已放弃等待（请求仍在后台）`);
        // 后台把响应补进 trace，不影响用户
        void pending
          .catch(() => undefined)
          .finally(() => clearTimeout(hardCap));
        return {
          text: raw,
          corrected: false,
          reason: 'timeout',
          ms: trace.waitedMs,
          partial: false,
          error: `纠偏超过 ${budget}ms 阈值，已放弃`,
        };
      }
      result = raced;
    } finally {
      if (trace.timedOut) clearTimeout(hardCap);
    }

    clearTimeout(hardCap);
    trace.waitedMs = Date.now() - started;
    this.setTrace(trace);

    const content = result.content;
    const cleaned = sanitize(content);
    // 无论最终用不用它，都记进 trace —— 「模型到底返回了什么」是最该被看见的
    trace.correctedText = cleaned;
    this.setTrace(trace);

    if (!cleaned) {
      return {
        text: raw,
        corrected: false,
        reason: 'empty',
        ms: trace.waitedMs,
        partial: false,
      };
    }
    if (!isPlausible(raw, cleaned)) {
      log.warn('llm', '纠偏结果与原文差异过大，判定为不可信，改用原文');
      trace.error = '纠偏结果异常，已回退到原始文本';
      this.setTrace(trace);
      return {
        text: raw,
        corrected: false,
        reason: 'rejected',
        ms: trace.waitedMs,
        partial: false,
        error: '纠偏结果异常，已回退到原始文本',
      };
    }
    if (cleaned === raw.trim()) {
      return {
        text: cleaned,
        corrected: false,
        reason: 'unchanged',
        ms: trace.waitedMs,
        partial: false,
      };
    }

    trace.correctedText = cleaned;
    this.setTrace(trace);
    log.info('llm', `纠偏完成 ${trace.waitedMs}ms：${cleaned}`);
    return { text: cleaned, corrected: true, reason: 'ok', ms: trace.waitedMs, partial: false };  }

  /**
   * 发一次请求；如果对端不认「关闭深度思考」那些参数，就去掉它们重试一次。
   */
  private async fetchWithFallback(
    endpoint: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    usedThinkingParams: boolean,
    signal: AbortSignal,
  ): Promise<{ status: number; bodyText: string; content: string }> {
    const attempt = async (payload: Record<string, unknown>): Promise<Response> => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
      if (response.ok) return response;
      const detail = await response.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` · ${detail.slice(0, 400)}` : ''}`), {
        status: response.status,
        bodyText: detail,
      });
    };

    let response: Response;
    try {
      response = await attempt(body);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      const bodyText = (error as { bodyText?: string }).bodyText ?? '';
      const canRetry =
        usedThinkingParams && isUnknownParamError(status, bodyText) && !signal.aborted;
      if (!canRetry) throw error;

      log.warn('llm', '对端不认「关闭深度思考」的参数，去掉它们重试一次');
      const stripped: Record<string, unknown> = { ...body };
      delete stripped.enable_thinking;
      delete stripped.thinking;
      response = await attempt(stripped);
    }

    const status = response.status;
    if (body.stream === true) {
      const result = await readStream(response);
      return { status, bodyText: result.raw, content: result.content };
    }
    const text = await readJson(response);
    return { status, bodyText: text, content: text };
  }
}

export const corrector = new Corrector();
