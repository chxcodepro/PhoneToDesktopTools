// 检查更新：查询 GitHub 仓库最新发布（Release）的版本，有新版本时给出本机对应的安装包下载地址。
// 不自动下载安装：打开浏览器下载，用户自己覆盖安装（Windows 安装程序、deb 的安装方式不同，见 docs/INSTALL.md）。
// 仓库地址不写死在代码里：CI 打包时把 GITHUB_REPOSITORY 写进 package.json 的 p2d.updateRepo，
// 本地打包没有这个字段，检查更新会提示「这个版本没有配置更新地址」。
// 不能上网的电脑检查会失败，自动检查失败时不打扰用户。
import { app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { UpdateInfo } from '../shared/types';

const AUTO_DELAY = 15_000; // 启动后多久第一次自动检查
const AUTO_INTERVAL = 12 * 3600_000;
const TIMEOUT = 15_000;

/** 比较版本号（a > b 返回正数）。0.2.0 > 0.1.0；正式版 0.1.0 > 测试版 0.1.0-ci.5；ci.12 > ci.5 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, '').split('+')[0];
    const i = s.indexOf('-');
    const main = i < 0 ? s : s.slice(0, i);
    const pre = i < 0 ? '' : s.slice(i + 1);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined) return -1;
    if (yp[i] === undefined) return 1;
    const xn = /^\d+$/.test(xp[i]) ? Number(xp[i]) : NaN;
    const yn = /^\d+$/.test(yp[i]) ? Number(yp[i]) : NaN;
    const d = !isNaN(xn) && !isNaN(yn) ? xn - yn : xp[i].localeCompare(yp[i]);
    if (d) return d;
  }
  return 0;
}

/** 本机对应的安装包文件名结尾（和 electron-builder、scripts/package-linux.sh 的命名一致） */
export function assetSuffixes(platform: string, arch: string, appImage: boolean): string[] {
  // Windows 打包成安装程序（更早的版本是便携版 -portable.exe，从便携版检查更新时找不到对应文件，会打开发布页）
  if (platform === 'win32') return [arch === 'ia32' ? '-win-ia32-setup.exe' : '-win-x64-setup.exe'];
  if (platform !== 'linux') return [];
  if (appImage) return arch === 'arm64' ? ['-linux-arm64.AppImage'] : ['-linux-x86_64.AppImage', '-linux-x64.AppImage'];
  const deb: Record<string, string> = { x64: 'amd64', arm64: 'arm64', loong64: 'loongarch64' };
  return deb[arch] ? [`-linux-${deb[arch]}.deb`] : [];
}

function updateRepo(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { p2d?: { updateRepo?: string } };
    const repo = pkg.p2d?.updateRepo;
    return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

/** 本地打包的版本没有配置 updateRepo 时，「关于」里显示的项目主页 */
const HOME_REPO = 'chxcodepro/p2d';

/** 项目主页（GitHub 仓库）：优先用打包时写入的仓库，和检查更新一致 */
export function repoUrl(): string {
  return `https://github.com/${updateRepo() ?? HOME_REPO}`;
}

interface GhRelease {
  tag_name: string;
  html_url: string;
  assets?: { name: string; browser_download_url: string }[];
}

function getJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    // net 走 Chromium 的网络栈，会用系统代理设置
    const req = net.request({ url, method: 'GET' });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', 'p2d');
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('连接超时'));
    }, TIMEOUT);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ status: res.statusCode, body: undefined });
        }
      });
      res.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

let info: UpdateInfo = { state: 'idle', current: app.getVersion() };
let onChange: () => void = () => undefined;

export function getUpdate(): UpdateInfo {
  return info;
}

function set(next: UpdateInfo): UpdateInfo {
  info = next;
  onChange();
  return info;
}

/** 检查一次。quiet：自动检查，失败时不显示错误 */
export async function checkUpdate(quiet = false): Promise<UpdateInfo> {
  const current = app.getVersion();
  const repo = updateRepo();
  if (!repo) return quiet ? info : set({ state: 'error', current, message: '这个版本没有配置更新地址（本地打包的版本）' });
  if (info.state === 'checking') return info;
  const prev = info;
  if (!quiet) set({ state: 'checking', current });
  try {
    const { status, body } = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
    if (status === 404) throw new Error('还没有发布过正式版本');
    if (status === 403 || status === 429) throw new Error('检查太频繁，请过一小时再试');
    if (status !== 200 || !body) throw new Error(`更新服务器返回 ${status}`);
    const rel = body as GhRelease;
    const latest = rel.tag_name.replace(/^v/i, '');
    if (compareVersions(latest, current) <= 0) return set({ state: 'latest', current, latest });
    const suffixes = assetSuffixes(process.platform, process.arch, !!process.env.APPIMAGE);
    const asset = rel.assets?.find((a) => suffixes.some((x) => a.name.endsWith(x)));
    return set({ state: 'available', current, latest, url: asset?.browser_download_url, page: rel.html_url, file: asset?.name, hint: installHint() });
  } catch (e) {
    if (quiet) return set(prev);
    const msg = e instanceof Error ? e.message : String(e);
    return set({ state: 'error', current, message: `检查失败：${/net::|ENOTFOUND|ECONN|超时/.test(msg) ? '连不上更新服务器（这台电脑可能不能上网）' : msg}` });
  }
}

/** 启动后自动检查，之后每 12 小时一次 */
export function startAutoCheck(changed: () => void): void {
  onChange = changed;
  if (!updateRepo()) return;
  setTimeout(() => void checkUpdate(true), AUTO_DELAY);
  setInterval(() => void checkUpdate(true), AUTO_INTERVAL);
}

/** 平台说明：下载后怎么装 */
export function installHint(): string {
  if (process.platform === 'win32') return '下载完成后运行新的安装程序，它会关闭正在运行的旧版本并直接覆盖安装，配对记录和设置都保留';
  if (process.env.APPIMAGE) return '下载完成后退出本程序，给新文件加上执行权限后运行';
  return '下载完成后双击 .deb 安装（或运行 sudo dpkg -i 文件名），会直接覆盖旧版本，然后重新打开本程序';
}
