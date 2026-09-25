// 页面可访问检查：
//   node scripts/check-page.mjs <url>        检查已部署站点
//   node scripts/check-page.mjs --serve <dir> 临时静态托管目录后自检
// 校验：首页 200 且含标题；引用的模块脚本可 200 拉取且语法可解析。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let baseUrl;
let cleanup = () => {};

function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirects < 5) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, url).href, redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function startStaticServer(dir) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const fp = path.normalize(path.join(root, p));
    if (!fp.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(fp);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  cleanup = () => server.close();
  return `http://127.0.0.1:${port}/`;
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (args[0] === '--serve') {
  if (!args[1]) fail('缺少待托管目录');
  baseUrl = await startStaticServer(args[1]);
} else if (args[0]) {
  baseUrl = args[0];
} else {
  fail('用法: check-page.mjs <url> | --serve <dir>');
}

try {
  console.log(`  GET ${baseUrl}`);
  const home = await fetchUrl(baseUrl);
  if (home.status !== 200) fail(`首页 HTTP 状态 ${home.status}`);
  const html = home.body.toString('utf8');
  if (!html.includes('紫外灯光联动复核')) fail('首页缺少预期标题内容');

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  if (!scripts.length) fail('首页未引用任何脚本');
  for (const src of scripts) {
    const u = new URL(src, baseUrl);
    console.log(`  GET ${u.href}`);
    const js = await fetchUrl(u.href);
    if (js.status !== 200) fail(`脚本 ${src} HTTP 状态 ${js.status}`);
    const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), `.check-bundle.mjs`);
    fs.writeFileSync(tmp, js.body);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) fail(`脚本 ${src} 语法解析失败:\n${r.stderr}`);
  }

  // 关联的 CSS 也应可访问
  const css = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  for (const href of css) {
    const u = new URL(href, baseUrl);
    const res = await fetchUrl(u.href);
    if (res.status !== 200) fail(`样式 ${href} HTTP 状态 ${res.status}`);
  }

  console.log('✓ 首页可访问（HTTP 200，标题正确），模块脚本与样式均可拉取且脚本语法有效');
} finally {
  cleanup();
}
