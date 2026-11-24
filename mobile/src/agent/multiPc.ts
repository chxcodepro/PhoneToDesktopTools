// 同时操作多台电脑时，把几台电脑的工具合成一套交给 Agent。不依赖 React Native，可在 Node 中测试（tests/multiPc.test.ts）。
//
// - 只连一台：工具原样交出，不加任何参数（不多占 token）。
// - 连多台：每个电脑工具多一个必填参数 pc（电脑名），按它找到对应的电脑执行；结果开头标上电脑名。
//   某台电脑没有的工具（如麒麟没有 ui_tree），说明里注明哪几台有。
// - group()：同一台电脑上的调用按顺序执行，不同电脑之间可以同时执行（Agent 循环据此并行）。

import type { ToolContent, ToolInfo, ToolResult } from '../protocol/types';
import type { AgentTools } from './agent';

export interface PcTarget {
  /** 电脑标识（pcId） */
  id: string;
  /** 给模型看的电脑名（已去重） */
  name: string;
  os: string;
  tools: ToolInfo[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface PcToolSet extends AgentTools {
  /** 并发分组：同组按顺序执行 */
  group(name: string, args: Record<string, unknown>): string;
  /** 按 pc 参数找电脑（多台时）；只有一台时就是它 */
  resolve(args: Record<string, unknown>): PcTarget | undefined;
}

/** 电脑名去重：同名的加「(2)」「(3)」 */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const n = raw.trim() || '电脑';
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} (${k})`;
  });
}

/** 按模型给的 pc 参数找电脑：电脑名、标识，不分大小写，或者唯一的部分匹配 */
export function resolvePc<T extends { id: string; name: string }>(targets: readonly T[], value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().replace(/^[「『"]|[」』"]$/g, '');
  if (!v) return undefined;
  const lower = v.toLowerCase();
  const exact =
    targets.find((t) => t.name === v) ?? targets.find((t) => t.id === v) ?? targets.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact;
  const partial = targets.filter((t) => t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase()));
  return partial.length === 1 ? partial[0] : undefined;
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** 给结果开头标上电脑名 */
function tagResult(r: ToolResult, name: string): ToolResult {
  const tag = `【${name}】`;
  const i = r.content.findIndex((c) => c.type === 'text');
  if (i < 0) return { ...r, content: [{ type: 'text', text: tag }, ...r.content] };
  const content: ToolContent[] = r.content.map((c, j) => (j === i && c.type === 'text' ? { ...c, text: `${tag}${c.text}` } : c));
  return { ...r, content };
}

/** 给工具参数加上必填的 pc */
function withPcParam(t: ToolInfo, names: string[], owners: string[]): ToolInfo {
  const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  const pcProp = {
    type: 'string',
    enum: owners,
    description: '在哪台电脑上执行（电脑名）。多台都要做时每台各调用一次，可以在同一轮里一起调用，会同时执行。',
  };
  return {
    ...t,
    description: owners.length < names.length ? `${t.description ?? ''}（只有 ${owners.join('、')} 有这个工具）` : t.description,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: { pc: pcProp, ...(schema.properties ?? {}) },
      required: ['pc', ...(schema.required ?? []).filter((r) => r !== 'pc')],
    },
  };
}

export function createPcTools(targets: () => PcTarget[]): PcToolSet {
  const resolve = (args: Record<string, unknown>): PcTarget | undefined => {
    const ts = targets();
    return ts.length === 1 ? ts[0] : resolvePc(ts, args.pc);
  };
  return {
    list() {
      const ts = targets();
      if (ts.length === 0) return [];
      if (ts.length === 1) return ts[0].tools;
      const names = ts.map((t) => t.name);
      const byName = new Map<string, { tool: ToolInfo; owners: string[] }>();
      for (const t of ts) {
        for (const tool of t.tools) {
          const e = byName.get(tool.name);
          if (e) e.owners.push(t.name);
          else byName.set(tool.name, { tool, owners: [t.name] });
        }
      }
      return [...byName.values()].map((e) => withPcParam(e.tool, names, e.owners));
    },
    async call(name, args, signal) {
      const ts = targets();
      if (!ts.length) throw new Error('电脑未连接');
      const { pc, ...rest } = args;
      if (ts.length === 1) return ts[0].call(name, typeof pc === 'string' ? rest : args, signal);
      const target = resolvePc(ts, pc);
      if (!target) {
        return errorResult(
          `${pc === undefined ? '没有指定' : `找不到电脑「${String(pc)}」，`}请用 pc 参数指定在哪台电脑上执行：${ts.map((t) => t.name).join('、')}`,
        );
      }
      if (!target.tools.some((t) => t.name === name)) return errorResult(`【${target.name}】这台电脑没有 ${name} 这个工具`);
      return tagResult(await target.call(name, rest, signal), target.name);
    },
    group(_name, args) {
      const ts = targets();
      if (ts.length <= 1) return 'pc';
      return `pc:${resolvePc(ts, args.pc)?.id ?? '?'}`;
    },
    resolve,
  };
}
