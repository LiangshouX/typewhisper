import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { protocol } from 'electron';

import { log } from './logger.js';

/** 自定义协议，用来安全地加载本地页面（避免 file:// 的一堆限制）。 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'typewhisper';

/** dist 目录：打包后在 app.asar 里，开发时是项目下的 dist。 */
export const DIST_DIR = path.join(__dirname, '..');

/** 必须在 app ready 之前调用。 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        // 必须是 standard：**非标准 scheme 下渲染进程不执行 ES module**，
        // 页面里的 <script type="module"> 会被直接忽略（实测声波条一个都没创建）。
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 注册协议处理器（app ready 之后调用）。 */
export function serveAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // 非标准 scheme 下，Chromium 可能把 host 算进 pathname
    if (!relative && url.host) relative = `${url.host}/${url.search.replace(/^\?/, '')}`;
    log.debug('protocol', `请求 ${request.url} → ${relative}`);
    const target = path.resolve(DIST_DIR, relative);

    // 防目录穿越
    if (!target.startsWith(path.resolve(DIST_DIR))) {
      return new Response('Forbidden', { status: 403 });
    }

    // 直接读文件返回。
    // 之前用 net.fetch(file://…) 绕了一圈，Electron 的 net 模块处理 file:// 很慢
    // （实测单页要几秒），窗口全靠它加载时首屏会被拖住。
    // fs 在 Electron 里是支持 asar 的，打包后读 app.asar 里的文件也没问题。
    try {
      const data = await readFile(target);
      const extension = path.extname(target).toLowerCase();
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': MIME[extension] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (error) {
      log.warn('protocol', `${relative} 读取失败：${String(error)}`);
      return new Response('Not Found', { status: 404 });
    }
  });
}

/** 构造页面 URL。 */
export function appUrl(relativePath: string): string {
  return `${APP_SCHEME}://${APP_HOST}/${relativePath.replace(/^\/+/, '')}`;
}
