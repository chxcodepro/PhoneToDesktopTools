// 打 Windows 安装包：64 位、32 位各打一个（一次打两个架构会合成一个体积翻倍的安装包）。
// 命令行上多余的参数原样传给 electron-builder，例如 npm run dist:win -- --publish never
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');

const extra = process.argv.slice(2);
const archs = extra.includes('--x64-only') ? ['--x64'] : ['--x64', '--ia32'];
const args = extra.filter((a) => a !== '--x64-only');
for (const arch of archs) {
  const r = spawnSync(process.execPath, [cli, '--win', 'nsis', arch, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
