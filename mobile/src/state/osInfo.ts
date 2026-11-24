// 按电脑端告知的系统名（osName，如 Windows 11、Kylin V10 SP1）区分系统系列，用来显示系统图标。
// 旧版电脑端没有 osName 时只知道 windows / linux。

export type OsFamily = 'win11' | 'win10' | 'win8' | 'win7' | 'winxp' | 'windows' | 'kylin' | 'uos' | 'ubuntu' | 'linux' | 'unknown';

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
  if (/kylin|麒麟/.test(n)) return { family: 'kylin', label: '银河麒麟' };
  if (/uos|统信|deepin/.test(n)) return { family: 'uos', label: n.includes('deepin') ? 'Deepin' : '统信 UOS' };
  if (n.includes('ubuntu')) return { family: 'ubuntu', label: 'Ubuntu' };
  if (os === 'windows') return { family: 'windows', label: 'Windows' };
  if (os === 'linux' || n) return { family: 'linux', label: osName ? osName.split(' ')[0] : 'Linux' };
  return { family: 'unknown', label: '电脑' };
}
