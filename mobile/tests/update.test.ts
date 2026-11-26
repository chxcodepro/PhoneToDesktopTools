// 检查更新：版本号比较、解析 GitHub 最新发布。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkLatest, compareVersions } from '../src/lib/update';

describe('compareVersions', () => {
  it('数字部分逐段比较', () => {
    assert.ok(compareVersions('0.2.0', '0.1.0') > 0);
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
    assert.equal(compareVersions('v1.0.0', '1.0'), 0);
  });
  it('正式版比同号的测试版新；测试版序号按数字比较', () => {
    assert.ok(compareVersions('0.1.0', '0.1.0-ci.5') > 0);
    assert.ok(compareVersions('0.1.0-ci.12', '0.1.0-ci.5') > 0);
    assert.ok(compareVersions('0.1.0-ci', '0.1.0-ci.1') < 0);
  });
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const release = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/o/r/releases/tag/v0.2.0',
  assets: [
    { name: 'p2d-0.2.0-win-x64-portable.exe', browser_download_url: 'https://x/exe' },
    { name: 'p2d-0.2.0-android.apk', browser_download_url: 'https://x/apk' },
  ],
};

describe('checkLatest', () => {
  it('有新版本：给出 APK 地址', async () => {
    assert.deepEqual(await checkLatest('o/r', '0.1.0-ci.5', reply(200, release)), { state: 'available', latest: '0.2.0', url: 'https://x/apk', page: 'https://github.com/o/r/releases/tag/v0.2.0' });
  });
  it('已是最新', async () => {
    assert.deepEqual(await checkLatest('o/r', '0.2.0', reply(200, release)), { state: 'latest', latest: '0.2.0' });
  });
  it('没有配置仓库、没有发布、断网', async () => {
    assert.equal((await checkLatest(undefined, '0.1.0', reply(200, release))).state, 'error');
    assert.deepEqual(await checkLatest('o/r', '0.1.0', reply(404, {})), { state: 'error', message: '还没有发布过正式版本' });
    const offline = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    assert.deepEqual(await checkLatest('o/r', '0.1.0', offline), { state: 'error', message: '连不上更新服务器，请检查网络' });
  });
});
