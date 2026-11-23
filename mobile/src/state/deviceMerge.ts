// 识别「同一台电脑的重复记录」。设备记录按电脑端的 pcId 保存；旧版电脑端在 lan.json 丢失或换了位置时
// （比如从别的程序里启动、被系统重定向到另一个目录）会生成新的 pcId，手机上就多出一条同名记录。
// 新版电脑端会额外告诉手机机器指纹 mid（同一台电脑始终相同），据此合并。
// 纯函数，不依赖 React Native，方便在 Node 里测试。

export interface MergeFields {
  pcId: string;
  name: string;
  os: string;
  alias?: string;
  /** 电脑端的机器指纹（新版电脑端才有） */
  mid?: string;
  lastConnectedAt?: number;
}

const DEFAULT_NAME = '电脑';

/**
 * 列表里和 cur 是同一台电脑、但 pcId 不同的记录。只有 cur 带机器指纹（刚从新版电脑端拿到）时才判断：
 * - 对方也有指纹：指纹相同才算；
 * - 对方没有指纹（升级前留下的记录）：电脑名和系统都相同才算。
 */
export function findSameMachine<T extends MergeFields>(cur: MergeFields, list: readonly T[]): T[] {
  if (!cur.mid) return [];
  const name = cur.name.trim().toLowerCase();
  return list.filter((d) => {
    if (d.pcId === cur.pcId) return false;
    if (d.mid) return d.mid === cur.mid;
    return !!name && name !== DEFAULT_NAME && d.name.trim().toLowerCase() === name && d.os === cur.os;
  });
}

/** 把重复记录里有用的信息并到 cur：用户起的名字（cur 没有时取最近连过的那条） */
export function mergeInto<T extends MergeFields>(cur: T, dups: readonly T[]): T {
  if (cur.alias || !dups.length) return cur;
  const withAlias = [...dups].filter((d) => d.alias).sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
  return withAlias.length ? { ...cur, alias: withAlias[0].alias } : cur;
}
