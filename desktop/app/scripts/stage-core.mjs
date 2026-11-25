// 打包前把 Go 编译出的 Core 复制到 core-bin/<electron-builder 的 os>-<arch>/，供 extraResources 使用。
// 需要先在仓库根目录运行 bash scripts/build-core.sh。
import { copyFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(app, '..', '..');
const map = [
  ['windows-amd64', 'win-x64', 'p2d-core.exe'],
  ['windows-386', 'win-ia32', 'p2d-core.exe'],
  ['linux-amd64', 'linux-x64', 'p2d-core'],
  ['linux-arm64', 'linux-arm64', 'p2d-core'],
  ['linux-loong64', 'linux-loong64', 'p2d-core'],
];
// 手机端安装包，放在 desktop/vendor/ 下（见 desktop/vendor/README.md）。电脑端自己经 USB 连接手机，不再带 adb。
const vendor = join(repo, 'desktop', 'vendor');
function stageVendor(coreDir) {
  const apk = join(vendor, 'app', 'p2d.apk');
  if (existsSync(apk)) {
    mkdirSync(join(coreDir, 'vendor', 'app'), { recursive: true });
    copyFileSync(apk, join(coreDir, 'vendor', 'app', 'p2d.apk'));
  } else {
    console.warn(`提示：没有找到手机端安装包 ${apk}，打包后无法自动给手机安装 App`);
  }
}

rmSync(join(app, 'core-bin'), { recursive: true, force: true });
let n = 0;
for (const [goDir, ebDir, exe] of map) {
  const src = join(repo, 'dist', 'core', goDir, exe);
  if (!existsSync(src)) {
    console.warn(`跳过 ${goDir}：没有找到 ${src}`);
    continue;
  }
  const dst = join(app, 'core-bin', ebDir, exe);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  if (!exe.endsWith('.exe')) chmodSync(dst, 0o755);
  stageVendor(dirname(dst));
  n++;
}
if (n === 0) {
  console.error('没有找到任何 Core，请先运行 bash scripts/build-core.sh');
  process.exit(1);
}
console.log(`已复制 ${n} 个平台的 Core 到 core-bin/`);
