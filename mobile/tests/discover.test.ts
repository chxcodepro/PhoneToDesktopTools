// 自动发现电脑、系统图标的系列判断

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePing, subnetHosts } from '../src/state/discover';
import { osInfo } from '../src/state/osInfo';

describe('自动发现电脑', () => {
  it('扫描手机所在的 /24 网段，跳过手机自己', () => {
    const hosts = subnetHosts('192.168.31.120');
    assert.equal(hosts.length, 253);
    assert.equal(hosts[0], '192.168.31.1');
    assert.equal(hosts[hosts.length - 1], '192.168.31.254');
    assert.ok(!hosts.includes('192.168.31.120'));
  });

  it('不是有效的 IPv4 时不扫描', () => {
    for (const ip of ['', '0.0.0.0', '127.0.0.1', 'fe80::1', '300.1.1.1', 'abc']) assert.deepEqual(subnetHosts(ip), [], ip);
  });

  it('只认本软件电脑端的回应', () => {
    assert.deepEqual(parsePing('192.168.31.159', 39272, { app: 'p2d', pc: 'abc', name: 'PC-1', os: 'windows', osName: 'Windows 11' }), {
      host: '192.168.31.159',
      port: 39272,
      pcId: 'abc',
      name: 'PC-1',
      os: 'windows',
      osName: 'Windows 11',
    });
    // 旧版电脑端没有系统名
    assert.equal(parsePing('10.0.0.2', 39272, { app: 'p2d', pc: 'x', name: 'A' })?.osName, undefined);
    assert.equal(parsePing('10.0.0.2', 39272, { app: 'other', pc: 'x' }), null);
    assert.equal(parsePing('10.0.0.2', 39272, { app: 'p2d' }), null);
    assert.equal(parsePing('10.0.0.2', 39272, null), null);
  });
});

describe('系统图标', () => {
  it('按系统名区分系列', () => {
    const cases: [string, string | undefined, string, string][] = [
      ['windows', 'Windows 11', 'win11', 'Win11'],
      ['windows', 'Windows 10', 'win10', 'Win10'],
      ['windows', 'Windows 7', 'win7', 'Win7'],
      ['windows', 'Windows 8.1', 'win8', 'Win8.1'],
      ['windows', 'Windows XP', 'winxp', 'WinXP'],
      ['windows', undefined, 'windows', 'Windows'],
      ['linux', 'Kylin V10 SP1', 'kylin', '银河麒麟'],
      ['linux', '银河麒麟桌面操作系统 V10', 'kylin', '银河麒麟'],
      ['linux', 'UOS Desktop 20', 'uos', '统信 UOS'],
      ['linux', 'Ubuntu 22.04.4 LTS', 'ubuntu', 'Ubuntu'],
      ['linux', 'Debian GNU/Linux 12', 'linux', 'Debian'],
      ['linux', undefined, 'linux', 'Linux'],
    ];
    for (const [os, name, family, label] of cases) assert.deepEqual(osInfo(os, name), { family, label }, `${os} ${name}`);
  });
});
