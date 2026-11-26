// 按电脑端告知的系统名（osName，如 Windows 11、Kylin V10 SP1、macOS 14）区分系统系列，用来显示系统图标。
// 旧版电脑端没有 osName 时只知道 windows / linux。

export type OsFamily =
  | 'win11'
  | 'win10'
  | 'win8'
  | 'win7'
  | 'winxp'
  | 'windows'
  | 'kylin'
  | 'uos'
  | 'ubuntu'
  | 'linux'
  | 'macos'
  | 'unknown';

/** 系统系列和简短名称（显示在图标下面） */
export function osInfo(os: string | undefined, osName?: string): { family: OsFamily; label: string } {
  const n = (osName ?? '').toLowerCase();
  if (n.includes('windows')) {
    if (n.includes('11')) return { family: 'win11', label: 'Win11' };
    if (n.includes('10')) return { family: 'win10', label: 'Win10' };
    if (n.includes('8')) return { family: 'win8', label: n.includes('8.1') ? 'Win8.1' : 'Win8' };
    if (n.includes(' 7')) return { family: 'win7', label: 'Win7' };
    if (n.includes('vista')) return { family: 'win7', label: 'Vista' };
    if (n.includes('xp')) return { family: 'winxp', label: 'WinXP' };
    return { family: 'windows', label: 'Windows' };
  }
  if (n.includes('macos') || n.includes('mac os') || os === 'darwin') return { family: 'macos', label: 'macOS' };
  if (/kylin|麒麟/.test(n)) return { family: 'kylin', label: '银河麒麟' };
  if (/uos|统信|deepin/.test(n)) return { family: 'uos', label: n.includes('deepin') ? 'Deepin' : '统信 UOS' };
  if (n.includes('ubuntu')) return { family: 'ubuntu', label: 'Ubuntu' };
  if (os === 'windows') return { family: 'windows', label: 'Windows' };
  if (os === 'linux' || n) return { family: 'linux', label: osName ? osName.split(' ')[0] : 'Linux' };
  return { family: 'unknown', label: '电脑' };
}

/**
 * 旧版电脑端没有 osName：从 sys_info 的 os_version 推出来。
 * Windows 的 os_version 形如「Windows 7 Ultimate Service Pack 1 (6.1.7601)」；Windows 11 的产品名仍写着 Windows 10，要看内部版本号（22000 起）。
 * Linux 是 /etc/os-release 的 PRETTY_NAME（如 Kylin V10 SP1），原样返回。
 */
export function osNameFromVersion(os: string | undefined, version: string | undefined): string | undefined {
  const v = (version ?? '').trim();
  if (!v) return undefined;
  if (os !== 'windows' && !/windows/i.test(v)) return v;
  const m = /\((\d+)\.(\d+)\.(\d+)\)/.exec(v);
  if (m) {
    const [major, minor, build] = m.slice(1).map(Number);
    if (major === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
    if (major === 6 && minor === 3) return 'Windows 8.1';
    if (major === 6 && minor === 2) return 'Windows 8';
    if (major === 6 && minor === 1) return 'Windows 7';
    if (major === 6 && minor === 0) return 'Windows Vista';
    if (major === 5) return 'Windows XP';
  }
  const named = /Windows (11|10|8\.1|8|7|Vista|XP)/i.exec(v);
  return named ? `Windows ${named[1]}` : 'Windows';
}
