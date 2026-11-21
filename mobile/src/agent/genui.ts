// 生成式界面（GenUI）：模型在回答里输出 ```p2d-ui 代码块（JSON），手机把它渲染成原生组件。
// 只认白名单里的组件和字段，其余丢弃；不执行任何脚本。不依赖 React Native，可在 Node 中测试。
//
// 组件：
//   callout   提示框      { type, tone?: info|success|warning|error, title?, text }
//   stats     数据卡片    { type, items: [{ label, value, hint?, tone? }] }（最多 4 个）
//   progress  进度条      { type, label, value: 0~100, hint? }
//   steps     步骤列表    { type, items: [{ title, status?: done|current|todo|error, detail? }] }
//   kv        信息列表    { type, title?, items: [{ label, value }] }
//   buttons   后续操作    { type, items: [{ label, send, primary? }] }，点击后把 send 作为用户消息发给 Agent
// 顶层可以是单个组件、组件数组，或 { title?, items: [...] }。

export const GENUI_LANG = 'p2d-ui';

export type Tone = 'info' | 'success' | 'warning' | 'error';

export type GenuiNode =
  | { type: 'callout'; tone: Tone; title?: string; text: string }
  | { type: 'stats'; items: { label: string; value: string; hint?: string; tone?: Tone }[] }
  | { type: 'progress'; label: string; value: number; hint?: string }
  | { type: 'steps'; items: { title: string; status: 'done' | 'current' | 'todo' | 'error'; detail?: string }[] }
  | { type: 'kv'; title?: string; items: { label: string; value: string }[] }
  | { type: 'buttons'; items: { label: string; send: string; primary?: boolean }[] };

export interface GenuiSpec {
  title?: string;
  nodes: GenuiNode[];
}

const TONES: Tone[] = ['info', 'success', 'warning', 'error'];
const STEP_STATUS = ['done', 'current', 'todo', 'error'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const opt = (v: unknown, max?: number): string | undefined => str(v, max) || undefined;
const tone = (v: unknown): Tone | undefined => (TONES.includes(v as Tone) ? (v as Tone) : undefined);
const list = (v: unknown, max: number): Obj[] => (Array.isArray(v) ? v.filter(isObj).slice(0, max) : []);

function node(raw: Obj): GenuiNode | null {
  switch (raw.type) {
    case 'callout': {
      const text = str(raw.text, 2000);
      return text ? { type: 'callout', tone: tone(raw.tone) ?? 'info', title: opt(raw.title, 100), text } : null;
    }
    case 'stats': {
      const items = list(raw.items, 4)
        .map((i) => ({ label: str(i.label, 40), value: str(i.value, 40), hint: opt(i.hint, 60), tone: tone(i.tone) }))
        .filter((i) => i.label && i.value);
      return items.length ? { type: 'stats', items } : null;
    }
    case 'progress': {
      const n = typeof raw.value === 'number' ? raw.value : parseFloat(str(raw.value));
      const label = str(raw.label, 80);
      return label && Number.isFinite(n)
        ? { type: 'progress', label, value: Math.max(0, Math.min(100, n)), hint: opt(raw.hint, 80) }
        : null;
    }
    case 'steps': {
      const items = list(raw.items, 12)
        .map((i) => ({
          title: str(i.title, 120),
          status: (STEP_STATUS as readonly string[]).includes(i.status as string) ? (i.status as (typeof STEP_STATUS)[number]) : 'todo',
          detail: opt(i.detail, 300),
        }))
        .filter((i) => i.title);
      return items.length ? { type: 'steps', items } : null;
    }
    case 'kv': {
      const items = list(raw.items, 20)
        .map((i) => ({ label: str(i.label, 40), value: str(i.value, 300) }))
        .filter((i) => i.label && i.value);
      return items.length ? { type: 'kv', title: opt(raw.title, 100), items } : null;
    }
    case 'buttons': {
      const items = list(raw.items, 4)
        .map((i) => ({ label: str(i.label, 30), send: str(i.send, 500) || str(i.label, 30), primary: i.primary === true || undefined }))
        .filter((i) => i.label);
      return items.length ? { type: 'buttons', items } : null;
    }
    default:
      return null;
  }
}

/** 解析代码块内容；JSON 不合法或没有可显示的组件时返回 null（界面上按普通代码块显示） */
export function parseGenui(code: string): GenuiSpec | null {
  let data: unknown;
  try {
    data = JSON.parse(code);
  } catch {
    return null;
  }
  let title: string | undefined;
  let raws: unknown[];
  if (Array.isArray(data)) raws = data;
  else if (isObj(data) && Array.isArray(data.items) && typeof data.type !== 'string') {
    title = opt(data.title, 100);
    raws = data.items;
  } else raws = [data];
  const nodes = raws
    .filter(isObj)
    .slice(0, 12)
    .map(node)
    .filter((n): n is GenuiNode => n !== null);
  return nodes.length ? { title, nodes } : null;
}
