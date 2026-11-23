// 检查手机端更新：查询 GitHub 仓库最新发布（Release），有新版本时给出 APK 下载地址（用浏览器下载安装）。
// 仓库地址不写死：CI 打包时写进 app.json 的 extra.updateRepo（见 .github/workflows/build.yml），本地打包没有。
// 插数据线连接已更新的电脑时，电脑端也会自动给手机更新，这里是给只用 WiFi / Tailscale 连接的手机用的。
// 这个文件不依赖 Expo，方便测试（tests/update.test.ts）。

/** 比较版本号（a > b 返回正数）。0.2.0 > 0.1.0；正式版 0.1.0 > 测试版 0.1.0-ci.5；ci.12 > ci.5。和电脑端 update.ts 相同 */
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

export type UpdateResult =
  | { state: 'latest'; latest: string }
  | { state: 'available'; latest: string; url: string }
  | { state: 'error'; message: string };

interface GhRelease {
  tag_name?: string;
  html_url?: string;
  assets?: { name: string; browser_download_url: string }[];
}

/** 查询最新版本。fetchFn 方便测试时替换 */
export async function checkLatest(
  repo: string | undefined,
  current: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<UpdateResult> {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { state: 'error', message: '这个版本没有配置更新地址（本地打包的版本）' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    if (res.status === 404) return { state: 'error', message: '还没有发布过正式版本' };
    if (res.status === 403 || res.status === 429) return { state: 'error', message: '检查太频繁，请过一小时再试' };
    if (!res.ok) return { state: 'error', message: `更新服务器返回 ${res.status}` };
    const rel = (await res.json()) as GhRelease;
    const latest = (rel.tag_name ?? '').replace(/^v/i, '');
    if (!latest) return { state: 'error', message: '更新服务器返回的数据不对' };
    if (compareVersions(latest, current) <= 0) return { state: 'latest', latest };
    const apk = rel.assets?.find((a) => a.name.endsWith('-android.apk'));
    const url = apk?.browser_download_url ?? rel.html_url;
    if (!url) return { state: 'error', message: '没有找到安装包' };
    return { state: 'available', latest, url };
  } catch {
    return { state: 'error', message: '连不上更新服务器，请检查网络' };
  } finally {
    clearTimeout(timer);
  }
}
