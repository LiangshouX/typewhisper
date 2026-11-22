/**
 * 纠偏层验证脚本：用真实的 OpenAI 兼容端点验证
 *   1. 正常纠偏（词表能把同音错字改回来）；
 *   2. 超时保护（超过阈值立刻放弃纠偏，返回原文）；
 *   3. 关闭纠偏时直接返回原文；
 *   4. 幻觉防护（结果离谱时回退原文）。
 *
 * API Key 从 DSH 的凭据文件里取（DEEPSEEK_API_KEY），不会打印。
 *
 * 用法：node scripts/verify-llm.cjs [baseUrl] [model]
 */
const fs = require('node:fs');
const path = require('node:path');

const { Corrector } = require('../dist/main/corrector.cjs');

const CREDENTIALS = path.join(process.env.USERPROFILE, '.dsh', '.credentials.yaml');

function readApiKey() {
  try {
    const raw = fs.readFileSync(CREDENTIALS, 'utf8');
    const match = raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const baseUrl = process.argv[2] || 'https://api.deepseek.com/v1';
const model = process.argv[3] || 'deepseek-chat';
const apiKey = readApiKey();

if (!apiKey) {
  console.error('❌ 没找到 DEEPSEEK_API_KEY，跳过（可在 .dsh/.credentials.yaml 里配置）');
  process.exit(1);
}

const corrector = new Corrector();

const baseSettings = {
  enabled: true,
  baseUrl,
  apiKey,
  model,
  temperature: 0,
  timeoutMs: 3000,
  maxTotalLatencyMs: 3000,
  usePartialOnTimeout: false,
  streaming: true,
  disableThinking: true,
  extraSystemPrompt: '',
  terms: [{ term: '轻语' }, { term: '达摩院', replacement: '大模型' }],
};

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  console.log(`端点 ${baseUrl} · 模型 ${model}\n`);

  /* ---- 1. 正常纠偏 ---- */
  const raw = '今天用清语工具说了一句话，看看能不能改成轻语。';
  let outcome = await corrector.correct({ text: raw, budgetMs: 3000 }, baseSettings);
  console.log(`原文：${raw}`);
  console.log(`结果：${outcome.text}（${outcome.reason}，${outcome.ms}ms）`);
  check('纠偏生效', outcome.corrected, outcome.text);
  check('把「清语」改成了「轻语」', outcome.text.includes('轻语') && !outcome.text.includes('清语'));
  check('没有改写扩写', outcome.text.length <= raw.length + 8, `长度 ${outcome.text.length} vs ${raw.length}`);

  /* ---- 2. 超时保护：给 1 毫秒预算 ---- */
  const tight = { ...baseSettings, timeoutMs: 1 };
  const started = Date.now();
  outcome = await corrector.correct({ text: raw, budgetMs: 1 }, tight);
  const elapsed = Date.now() - started;
  console.log(`\n超时用例：${outcome.text}（${outcome.reason}，${outcome.ms}ms，墙钟 ${elapsed}ms）`);
  check('超时后返回原文', outcome.text === raw, outcome.text);
  check('超时原因正确', outcome.reason === 'timeout', outcome.reason);
  check('没有长时间阻塞', elapsed < 1500, `${elapsed}ms`);

  /* ---- 3. 关闭纠偏 ---- */
  const disabled = { ...baseSettings, enabled: false };
  outcome = await corrector.correct({ text: raw, budgetMs: 3000 }, disabled);
  check('\n关闭时返回原文', outcome.text === raw && outcome.reason === 'disabled', outcome.reason);

  /* ---- 4. 幻觉防护：原文很短但模型返回巨量内容 ---- */
  const outcome4 = await corrector.correct({ text: '测试。', budgetMs: 3000 }, baseSettings);
  check('短文本不会被扩写成大段', outcome4.text.length <= '测试。'.length * 3 + 24, `长度 ${outcome4.text.length}`);

  /* ---- 5. trace 可观测性 ---- */
  const trace = corrector.getLastTrace();
  check('trace 记录了请求地址', Boolean(trace?.url?.includes('/chat/completions')), trace?.url);
  check('trace 记录了响应状态码', trace?.status === 200, String(trace?.status));
  check('trace 里的 API Key 已打码', String(trace?.headers?.Authorization ?? '').includes('****'),
    String(trace?.headers?.Authorization));
  check('trace 里能看到纠偏结果', Boolean(trace?.correctedText), String(trace?.correctedText));
  check('trace 里能看到响应体', Boolean(trace?.responseBody), String(trace?.responseBody).slice(0, 40));

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项不通过`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('验证脚本出错：', error);
  process.exit(1);
});
