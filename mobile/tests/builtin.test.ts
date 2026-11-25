// 内置 Skill 和 MCP：SKILL.md 能解析、两个系统的脚本都在、PowerShell 脚本带 BOM（PowerShell 2.0 才能读对中文）。
// 运行：npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN_MCPS, BUILTIN_SKILLS, builtinSkillMd } from '../src/agent/builtinExtensions';
import { parseSkillMd } from '../src/agent/extensions';

describe('内置扩展', () => {
  it('每个 Skill 的 SKILL.md 都能解析，名称和描述一致', () => {
    for (const s of BUILTIN_SKILLS) {
      const p = parseSkillMd(builtinSkillMd(s));
      assert.notEqual(typeof p, 'string', `${s.name}：${String(p)}`);
      if (typeof p === 'string') continue;
      assert.equal(p.name, s.name);
      assert.equal(p.description, s.description);
    }
  });
  it('每个 Skill 都有 Windows 和 Linux 脚本，SKILL.md 里提到的脚本都存在', () => {
    for (const s of BUILTIN_SKILLS) {
      const names = Object.keys(s.files);
      assert.ok(names.some((n) => n.endsWith('.ps1')), `${s.name} 缺 .ps1`);
      assert.ok(names.some((n) => n.endsWith('.sh')), `${s.name} 缺 .sh`);
      for (const m of s.body.matchAll(/`([\w-]+\.(?:ps1|sh))`/g)) assert.ok(names.includes(m[1]), `${s.name} 提到的 ${m[1]} 不存在`);
    }
  });
  it('PowerShell 脚本带 UTF-8 BOM，bash 脚本不带', () => {
    for (const s of BUILTIN_SKILLS)
      for (const [n, c] of Object.entries(s.files)) {
        if (n.endsWith('.ps1')) assert.ok(c.startsWith('\ufeff'), `${s.name}/${n} 没有 BOM`);
        if (n.endsWith('.sh')) assert.ok(c.startsWith('#!/bin/bash'), `${s.name}/${n} 开头不是 #!/bin/bash`);
      }
  });
  it('key 不重复；MCP 都是免登录的 https 远程服务', () => {
    const keys = [...BUILTIN_SKILLS, ...BUILTIN_MCPS].map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const m of BUILTIN_MCPS) {
      assert.equal(m.draft.kind, 'remote');
      assert.match(m.draft.url ?? '', /^https:\/\//);
      assert.deepEqual(m.draft.headers, {});
    }
  });
});
