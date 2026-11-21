// 手机端联网工具：解析必应 RSS、网页、微软更新目录；下载到电脑时的哈希核对和工具分派。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSystemPrompt, type AgentTools } from '../src/agent/agent';
import type { FetchLike } from '../src/agent/llm';
import { combineTools, createPhoneTools, describeSignature, fileNameFromUrl, type PcFile } from '../src/agent/phoneTools';
import {
  base64ToHex,
  BOT_WALL_HINT,
  htmlToText,
  isBotChallenge,
  parseBingRss,
  parseCatalogDownload,
  parseCatalogSearch,
  preferHttps,
} from '../src/agent/web';
import type { ToolResult } from '../src/protocol/types';

const textOf = (r: ToolResult) => (r.content[0]?.type === 'text' ? r.content[0].text : '');

const RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>必应</title>
<item><title>Realtek &amp; 驱动</title><link>https://www.realtek.com/</link><description>官方 &lt;网站&gt;</description><pubDate>x</pubDate></item>
<item><title>第二条</title><link>https://example.com/2</link><description></description></item>
</channel></rss>`;

const CATALOG_ROW = `<tr id="55e4c288-1590-4fed-b4c1-248ebd64da45_R0" style="border-width:0px;">
<td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C0_R0"></td><td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C1_R0">
<a id='55e4c288-1590-4fed-b4c1-248ebd64da45_link' href= "javascript:void(0);" onclick='goToDetails("55e4c288-1590-4fed-b4c1-248ebd64da45");'>
    Realtek Driver Update (10.79.50.1003)
</a></td><td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C2_R0">
    Windows 11 Client,  version 24H2 and later,  Upgrade &amp; Servicing Drivers
</td><td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C3_R0">Drivers (Networking)</td>
<td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C4_R0">10/2/2025</td>
<td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C5_R0">10.79.50.1003</td>
<td class="x" id="55e4c288-1590-4fed-b4c1-248ebd64da45_C6_R0"><span id="55e4c288-1590-4fed-b4c1-248ebd64da45_size">584 KB</span>
<span class="noDisplay" id="55e4c288-1590-4fed-b4c1-248ebd64da45_originalSize">598115</span></td>
<td id="55e4c288-1590-4fed-b4c1-248ebd64da45_C7_R0"><input type="button" value='Download' /></td>
</tr>`;

const CATALOG_DOWNLOAD = `var downloadInformation = new Array();
downloadInformation[0].files[0].url = 'http://download.windowsupdate.com/d/msdownload/update/driver/drvs/2026/01/abc_63e362b5d90631a42779ff2986cd9e92eb2dc96f.cab';
downloadInformation[0].files[0].digest = 'Y+NitdkGMaQnef8phs2ekustyW8=';
downloadInformation[0].files[0].fileName = 'abc_63e362b5d90631a42779ff2986cd9e92eb2dc96f.cab';`;

/** 按地址返回固定内容的 fetch */
function fakeFetch(routes: Record<string, string>): FetchLike {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key ? routes[key] : '';
    return { ok: !!key, status: key ? 200 : 404, text: async () => body, body: null };
  };
}

describe('web 解析', () => {
  it('必应 RSS', () => {
    const r = parseBingRss(RSS);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { title: 'Realtek & 驱动', url: 'https://www.realtek.com/', snippet: '官方 <网站>' });
  });

  it('网页转文字：优先正文，提取可下载链接', () => {
    const filler = '正文内容。'.repeat(120);
    const html = `<html><head><title>下载 &amp; 支持</title><script>var x=1</script></head><body>
      <nav>导航栏</nav>
      <main><h1>驱动下载</h1><p>${filler}</p>
      <a href="/files/driver.zip">驱动 ZIP</a> <a href='https://cdn.example.com/setup.exe?v=2'>安装包</a>
      <a href="javascript:void(0)">无效</a><a href="mailto:a@b.c">邮件</a></main><footer>页脚</footer></body></html>`;
    const p = htmlToText(html, 'https://vendor.example.com/support/page');
    assert.equal(p.title, '下载 & 支持');
    assert.ok(p.text.startsWith('驱动下载'));
    assert.ok(!p.text.includes('导航栏') && !p.text.includes('页脚') && !p.text.includes('var x'));
    assert.deepEqual(
      p.links.map((l) => l.url),
      ['https://vendor.example.com/files/driver.zip', 'https://cdn.example.com/setup.exe?v=2'],
    );
  });

  it('微软更新目录：搜索结果和下载地址', () => {
    const items = parseCatalogSearch(`<table>${CATALOG_ROW}</table>`);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      id: '55e4c288-1590-4fed-b4c1-248ebd64da45',
      title: 'Realtek Driver Update (10.79.50.1003)',
      products: 'Windows 11 Client, version 24H2 and later, Upgrade & Servicing Drivers',
      classification: 'Drivers (Networking)',
      date: '10/2/2025',
      version: '10.79.50.1003',
      size: '584 KB',
    });
    const files = parseCatalogDownload(CATALOG_DOWNLOAD);
    assert.equal(files.length, 1);
    assert.equal(files[0].sha1, '63e362b5d90631a42779ff2986cd9e92eb2dc96f');
    assert.equal(files[0].fileName, 'abc_63e362b5d90631a42779ff2986cd9e92eb2dc96f.cab');
    assert.equal(base64ToHex('Y+NitdkGMaQnef8phs2ekustyW8='), '63e362b5d90631a42779ff2986cd9e92eb2dc96f');
  });

  it('windowsupdate.com 改用 https，其余地址不变', () => {
    assert.equal(preferHttps('http://download.windowsupdate.com/a.cab'), 'https://download.windowsupdate.com/a.cab');
    assert.equal(preferHttps('http://example.com/a.cab'), 'http://example.com/a.cab');
    assert.equal(fileNameFromUrl('https://x.com/dl/%E9%A9%B1%E5%8A%A8.zip?x=1'), '驱动.zip');
    assert.equal(fileNameFromUrl('https://x.com/'), 'download.bin');
  });

  it('签名说明', () => {
    assert.equal(describeSignature('Valid|CN=Microsoft Windows'), 'Valid（有效） · CN=Microsoft Windows');
    assert.equal(describeSignature('NotSigned|'), 'NotSigned（未签名）');
    assert.equal(describeSignature(undefined), null);
  });
});

describe('手机工具', () => {
  const catalog = 'https://www.catalog.update.microsoft.com';
  const fetch = fakeFetch({
    [`${catalog}/Search.aspx`]: `<table>${CATALOG_ROW}</table>`,
    [`${catalog}/DownloadDialog.aspx`]: CATALOG_DOWNLOAD,
  });

  function tools(file: Partial<PcFile>) {
    const calls: { url: string; name: string }[] = [];
    const t = createPhoneTools({
      fetch,
      downloadToPc: async (url, name) => {
        calls.push({ url, name });
        return { path: `C:\\Users\\u\\Downloads\\PhoneToDesktop\\${name}`, size: 598115, ...file };
      },
    });
    return { t, calls };
  }

  it('按更新编号下载：用 https 地址，核对微软提供的 SHA-1', async () => {
    const { t, calls } = tools({
      sha256: 'ab'.repeat(32),
      sha1: '63E362B5D90631A42779FF2986CD9E92EB2DC96F',
      signature: 'Valid|CN=Microsoft',
    });
    const r = await t.call('download_to_pc', { catalog_id: '55e4c288-1590-4fed-b4c1-248ebd64da45' });
    assert.equal(r.isError, false);
    assert.match(calls[0].url, /^https:\/\/download\.windowsupdate\.com\//);
    assert.equal(calls[0].name, 'abc_63e362b5d90631a42779ff2986cd9e92eb2dc96f.cab');
    const s = textOf(r);
    assert.match(s, /SHA-1：与微软更新目录提供的一致/);
    assert.match(s, /数字签名：Valid（有效）/);
  });

  it('哈希不一致时报错', async () => {
    const { t } = tools({ sha1: '0000000000000000000000000000000000000000' });
    const r = await t.call('download_to_pc', { catalog_id: '55e4c288-1590-4fed-b4c1-248ebd64da45' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /不一致/);

    const { t: t2 } = tools({ sha256: 'aa'.repeat(32) });
    const r2 = await t2.call('download_to_pc', { url: 'https://example.com/a.exe', sha256: 'bb'.repeat(32) });
    assert.equal(r2.isError, true);
  });

  it('未连接电脑时不能下载；地址不合法时报错', async () => {
    const t = createPhoneTools({ fetch, downloadToPc: null });
    assert.equal((await t.call('download_to_pc', { url: 'https://example.com/a.exe' })).isError, true);
    const { t: t2 } = tools({});
    assert.equal((await t2.call('download_to_pc', { url: 'ftp://x/a.exe' })).isError, true);
  });

  it('驱动搜索', async () => {
    const { t } = tools({});
    const s = textOf(await t.call('driver_search', { query: 'PCI\\VEN_10EC&DEV_8168' }));
    assert.match(s, /id=55e4c288-1590-4fed-b4c1-248ebd64da45/);
    assert.match(s, /Realtek Driver Update/);
  });

  it('合并工具：手机工具在手机上执行，其余交给电脑', async () => {
    const pcCalls: string[] = [];
    const pc: AgentTools = {
      list: () => [{ name: 'shell_exec' }],
      call: async (name) => {
        pcCalls.push(name);
        return { content: [{ type: 'text', text: 'pc' }] };
      },
    };
    const { t } = tools({});
    const all = combineTools(t, pc);
    const names = all.list().map((x) => x.name);
    assert.ok(names.includes('shell_exec') && names.includes('download_to_pc') && names.includes('web_search'));
    await all.call('shell_exec', { command: 'dir' });
    await all.call('driver_search', { query: 'x' });
    assert.deepEqual(pcCalls, ['shell_exec']);
  });

  it('系统提示：说明断网时用手机下载、管理员执行', () => {
    const p = buildSystemPrompt({
      computer: { host: 'PC', os: 'windows' },
      supportsVision: true,
      supportsTools: true,
      tools: { list: () => [], call: async () => ({ content: [] }) },
    });
    assert.match(p, /download_to_pc/);
    assert.match(p, /admin: true/);
    assert.match(p, /PCI\\VEN_10EC/);
    const linux = buildSystemPrompt({
      computer: { host: 'kylin', os: 'linux' },
      supportsVision: true,
      supportsTools: true,
      tools: { list: () => [], call: async () => ({ content: [] }) },
    });
    assert.match(linux, /apt-get --print-uris/);
  });
});

describe('人机验证', () => {
  const CF =
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

  it('识别 Cloudflare、reCAPTCHA 等验证页面，普通网页不误判', () => {
    assert.equal(isBotChallenge(CF), true);
    assert.equal(isBotChallenge('<div class="g-recaptcha" data-sitekey="x"></div>'), true);
    assert.equal(isBotChallenge('<script src="https://static.geetest.com/v4/gt4.js"></script>'), true);
    assert.equal(isBotChallenge('<html><title>Realtek 驱动下载</title><body>下载 captcha 说明</body></html>'), false);
  });

  it('读网页遇到验证页时给出换来源 / 手动下载的提示，不返回乱码', async () => {
    const t = createPhoneTools({ fetch: fakeFetch({ 'https://vendor.example.com/': CF }), downloadToPc: null });
    await assert.rejects(t.call('web_fetch', { url: 'https://vendor.example.com/driver' }), (e: Error) => e.message === BOT_WALL_HINT);
    assert.match(BOT_WALL_HINT, /不要尝试绕过/);
    assert.match(BOT_WALL_HINT, /＋ → 文件/);
  });
});
