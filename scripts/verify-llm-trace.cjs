/**
 * 纠偏层的行为验证（用本地 mock 服务，不碰真实 API）。
 *
 * 覆盖用户实测反馈里最关键的几点：
 *   1. 超时后**立刻**返回原文，不阻塞；
 *   2. 但请求本身还在后台跑，响应回来后**补进 trace**（可观测）；
 *   3. trace 里有完整的请求头/请求体/响应体；
 *   4. 「关闭深度思考」的参数会被带上；
 *   5. 对端不认这些参数时，自动去掉重试一次。
 *
 * 用法：node scripts/verify-llm-trace.cjs
 */
const http = require('node:http');
const { Corrector } = require('../dist/main/corrector.cjs');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 严格模式的服务：见到 enable_thinking / thinking 就报 400。 */
function startStrictServer(state) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests.push(JSON.parse(body || '{}'));
      const parsed = JSON.parse(body || '{}');
      if (parsed.enable_thinking !== undefined || parsed.thinking !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Unrecognized request argument supplied: enable_thinking',
              type: 'invalid_request_error',
            },
          }),
        );
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '轻语工具已经纠正好了。' } }],
          }),
        );
      }, 300);
    });
  });
}

/** 慢服务：故意延迟，用来测超时。 */
function startSlowServer(state, delayMs) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests.push(JSON.parse(body || '{}'));
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '这是迟到的回答。' } }],
          }),
        );
      }, delayMs);
    });
  });
}

const baseSettings = (baseUrl) => ({
  enabled: true,
  baseUrl,
  apiKey: 'sk-test-1234567890',
  model: 'test-model',
  temperature: 0,
  timeoutMs: 5000,
  maxTotalLatencyMs: 5000,
  usePartialOnTimeout: false,
  streaming: false,
  disableThinking: true,
  extraSystemPrompt: '',
  terms: [{ term: '轻语' }],
});

(async () => {
  /* ---------------- 1. 超时：立刻返回原文，响应后补进 trace ---------------- */
  {
    const state = { requests: [] };
    const server = startSlowServer(state, 1500);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const corrector = new Corrector();
    const started = Date.now();
    const outcome = await corrector.correct(
      { text: '清语工具说了一句话。', budgetMs: 200 },
      baseSettings(`http://127.0.0.1:${port}/v1`),
    );
    const waited = Date.now() - started;

    check('超时后返回原文', outcome.text === '清语工具说了一句话。', outcome.text);
    check('原因标记为 timeout', outcome.reason === 'timeout', outcome.reason);
    check('没有长时间阻塞', waited < 900, `${waited}ms`);

    let trace = corrector.getLastTrace();
    check('trace 已记录请求地址', Boolean(trace && trace.url.includes('/chat/completions')), trace?.url);
    check('trace 标记了超时', trace?.timedOut === true);
    check('trace 里的 API Key 已打码', String(trace?.headers?.Authorization ?? '').includes('****'),
      String(trace?.headers?.Authorization));
    check('响应还没回来时 trace 没有响应体', trace?.responseBody === undefined);

    // 等后台把响应补回来
    await sleep(2000);
    trace = corrector.getLastTrace();
    check('后台把响应补进了 trace', Boolean(trace?.responseBody?.includes('这是迟到的回答')),
      String(trace?.responseBody).slice(0, 60));
    check('trace 补上了状态码', trace?.status === 200, String(trace?.status));

    server.close();
  }

  /* ---------------- 2. 请求体带上了「关闭深度思考」 ---------------- */
  {
    const state = { requests: [] };
    const server = startStrictServer(state);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const corrector = new Corrector();
    const outcome = await corrector.correct(
      { text: '清语工具说了一句话。', budgetMs: 5000 },
      baseSettings(`http://127.0.0.1:${port}/v1`),
    );

    check('带参时对端 400 → 自动去掉参数重试成功', outcome.corrected === true,
      `${outcome.reason} · ${outcome.error ?? ''}`);
    check('一共发了两次请求', state.requests.length === 2, String(state.requests.length));
    check('第一次带上了 enable_thinking', state.requests[0]?.enable_thinking === false);
    check('重试时去掉了 enable_thinking', state.requests[1]?.enable_thinking === undefined);
    check('重试时去掉了 thinking', state.requests[1]?.thinking === undefined);

    const trace = corrector.getLastTrace();
    check('trace 记录了请求体', Boolean(trace?.requestBody), '');
    check('trace 记录了响应状态码', trace?.status === 200, String(trace?.status));
    check('trace 记录了纠偏结果', trace?.correctedText === '轻语工具已经纠正好了。',
      String(trace?.correctedText));

    server.close();
  }

  /* ---------------- 3. 关闭该开关时不带参数 ---------------- */
  {
    const state = { requests: [] };
    const server = startStrictServer(state);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const corrector = new Corrector();
    const settings = { ...baseSettings(`http://127.0.0.1:${port}/v1`), disableThinking: false };
    const outcome = await corrector.correct(
      { text: '清语工具说了一句话。', budgetMs: 5000 },
      settings,
    );
    check('关掉开关时不带额外参数', outcome.corrected === true, outcome.reason);
    check('只发了一次请求', state.requests.length === 1, String(state.requests.length));

    server.close();
  }

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项不通过`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('验证脚本出错：', error);
  process.exit(1);
});
