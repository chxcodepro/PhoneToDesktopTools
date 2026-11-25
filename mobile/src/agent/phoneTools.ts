// 在手机上执行的 Agent 工具（不经过电脑）：联网搜索、读网页、查微软驱动目录、下载文件并传到电脑、把对话里的图片存到电脑，
// 以及在对话里弹出选择卡片、等用户做决定（ask_user）。
// 和电脑工具合并后一起交给模型。下载到电脑的那一步依赖 React Native，由调用方注入，便于在 Node 中测试。

import type { ToolInfo, ToolResult } from '../protocol/types';
import type { AgentTools } from './agent';
import type { FetchLike } from './llm';
import { describeSchedule, formatDateTime, parseScheduleArgs, type ScheduledTask, type ScheduleInput } from './schedule';
import { catalogFiles, catalogSearch, clip, fileLinks, preferHttps, webFetch, webSearch } from './web';

export interface PcFile {
  path: string;
  size: number;
  sha256?: string;
  sha1?: string;
  signature?: string;
}

export interface PhoneToolDeps {
  fetch: FetchLike;
  /** 下载文件并传到电脑；电脑未连接时为 null */
  downloadToPc:
    ((url: string, name: string, opts: { signal?: AbortSignal; onProgress?: (text: string) => void }) => Promise<PcFile>) | null;
  /** 把用户在对话里发的图片附件传到电脑（ref 为附件编号或文件名，空表示最近一张）；电脑未连接时为 null */
  saveAttachment?: ((ref: string, opts: { signal?: AbortSignal }) => Promise<PcFile & { name: string }>) | null;
  /** 下载进度（显示在实时画面小窗等处） */
  onProgress?: (text: string) => void;
  /** 在对话里显示选择卡片，等用户选完再返回；不提供时 ask_user 不可用 */
  askUser?: (q: AskQuestion, signal?: AbortSignal) => Promise<AskAnswer>;
  /** 定时任务；不提供时 schedule_* 不可用 */
  schedules?: ScheduleApi;
}

export interface ScheduleApi {
  list(): ScheduledTask[];
  create(input: ScheduleInput): ScheduledTask;
  update(id: string, patch: SchedulePatch): ScheduledTask | null;
  remove(id: string): boolean;
  /** 记住的所有电脑的名字（可以指定定时任务在哪几台上执行）；不提供时不能指定电脑 */
  pcNames?(): string[];
  /** 电脑名 → pcId；有找不到的返回错误说明 */
  resolvePcs?(names: string[]): string[] | string;
  /** pcId → 显示的名字 */
  pcLabel?(id: string): string;
}

export interface SchedulePatch {
  enabled?: boolean;
  name?: string;
  prompt?: string;
  /** 空数组表示不再指定电脑（到时的当前电脑） */
  pcs?: string[];
}

/** 定时任务的电脑参数说明 */
function pcsSchema(names: string[]) {
  return {
    type: 'array',
    items: { type: 'string', enum: names },
    description: '在哪几台电脑上执行（可以多台，到点后会自动连上它们）；不填就是到时手机连着的当前电脑',
  };
}

const STATUS_TEXT: Record<string, string> = { running: '执行中', ok: '成功', error: '失败', missed: '错过' };

/** 定时任务的一行说明（给模型看） */
export function describeTask(t: ScheduledTask, now = Date.now(), pcLabel?: (id: string) => string): string {
  const parts = [
    `id=${t.id}`,
    t.name,
    describeSchedule(t),
    ...(t.pcs?.length ? [`电脑：${t.pcs.map((id) => (pcLabel ? pcLabel(id) : id)).join('、')}`] : []),
    t.enabled ? `下次：${t.nextRunAt ? formatDateTime(t.nextRunAt, now) : '无'}` : '已停用',
  ];
  if (t.lastRunAt) parts.push(`上次：${formatDateTime(t.lastRunAt, now)} ${STATUS_TEXT[t.lastStatus ?? ''] ?? ''}`.trim());
  return `- ${parts.join(' | ')}\n  指令：${t.prompt}`;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  options: AskOption[];
  /** 允许多选 */
  multiple: boolean;
  /** 允许用户自己输入（「其他」） */
  allowCustom: boolean;
}

export interface AskAnswer {
  /** 选中的选项文字 */
  selected: string[];
  /** 用户自己输入的内容 */
  custom?: string;
}

/** 选择卡片最多几个选项 */
export const MAX_OPTIONS = 6;

/** 把模型给的参数整理成问题；不合法时返回错误说明 */
export function parseAskArgs(args: Record<string, unknown>): AskQuestion | string {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return 'question 不能为空';
  const raw = Array.isArray(args.options) ? args.options : [];
  const options: AskOption[] = [];
  for (const o of raw) {
    const label =
      typeof o === 'string'
        ? o.trim()
        : o && typeof o === 'object' && typeof (o as AskOption).label === 'string'
          ? (o as AskOption).label.trim()
          : '';
    if (!label || options.some((x) => x.label === label)) continue;
    const description =
      o && typeof o === 'object' && typeof (o as AskOption).description === 'string' ? (o as AskOption).description!.trim() : '';
    options.push(description ? { label, description } : { label });
  }
  if (options.length < 2) return '至少需要 2 个不同的选项';
  return { question, options: options.slice(0, MAX_OPTIONS), multiple: args.multiple === true, allowCustom: args.allow_custom !== false };
}

export function formatAnswer(a: AskAnswer): string {
  const parts: string[] = [];
  if (a.selected.length) parts.push(`用户选择了：${a.selected.join('、')}`);
  if (a.custom) parts.push(`用户输入：${a.custom}`);
  return parts.join('\n') || '用户没有选择';
}

/** 定时任务的 pcs 参数（电脑名）转成 pcId；没传返回空数组 */
function resolveTaskPcs(api: ScheduleApi, raw: unknown): string[] | string {
  const names = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [])
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map((x) => x.trim());
  if (!names.length) return [];
  if (!api.resolvePcs) return '当前不能指定电脑';
  return api.resolvePcs(names);
}

export const PHONE_TOOLS: ToolInfo[] = [
  {
    name: 'schedule_create',
    description:
      '创建定时任务：到点后 App 会新建对话，把 prompt 当作用户指令交给你执行（例如每天早上体检电脑、每周五清理下载目录）。时间按手机本地时间，参考用户消息末尾的发送时间换算。' +
      '执行时需要手机上的 App 开着（或用户点了到点通知）；指定了电脑（pcs）时到点会自动连上它们，否则用到时连着的当前电脑。无人值守时只会做查询和低风险操作。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称，简短，如「每日体检」' },
        prompt: { type: 'string', description: '到点后要执行的完整指令，写清楚要做什么、怎么汇报' },
        kind: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'interval'],
          description: 'once 一次；daily 每天；weekly 每周几；interval 每隔 N 分钟',
        },
        datetime: { type: 'string', description: 'once 用：执行时间 "YYYY-MM-DD HH:MM"' },
        time: { type: 'string', description: 'daily / weekly 用：每天几点 "HH:MM"' },
        weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly 用：周几，1 = 周一 … 7 = 周日' },
        interval_minutes: { type: 'integer', description: 'interval 用：间隔分钟，不少于 15' },
      },
      required: ['name', 'prompt', 'kind'],
    },
  },
  {
    name: 'schedule_list',
    description: '列出所有定时任务：编号、周期、下次执行时间、上次执行结果。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_update',
    description: '修改定时任务：启用 / 停用、改名称、指令或执行的电脑（pcs 传空数组表示改回当前电脑）。要改执行时间请删除后重新创建。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'schedule_list 返回的编号' },
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schedule_delete',
    description: '删除定时任务。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ask_user',
    description:
      '在手机对话里显示一张选择卡片，等用户点选后返回结果。需要用户做决定时使用（例如用手机下载还是让电脑下载、多个驱动版本选哪个、是否安装 / 重启、几种修复方案选哪种），不要在文字里让用户回复。' +
      '选项写清楚区别，推荐项放第一个并在 description 里说明理由。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要用户决定的问题，一句话' },
        options: {
          type: 'array',
          description: '2～6 个选项',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项文字，简短' },
              description: { type: 'string', description: '补充说明（可选）' },
            },
            required: ['label'],
          },
        },
        multiple: { type: 'boolean', description: '允许多选，默认 false' },
        allow_custom: { type: 'boolean', description: '允许用户自己输入其他答案，默认 true' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'web_search',
    description:
      '用手机的网络搜索网页（必应），返回标题、链接和摘要。电脑断网时查报错原因、找驱动或安装包的官方下载页都用它。查到链接后用 web_fetch 读取页面。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词。报错信息可原样搜索，可加 site:microsoft.com 等限定官方网站' },
        count: { type: 'integer', description: '返回条数，默认 8，最多 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '用手机的网络读取网页，返回正文文字和页面上的可下载文件链接（exe/msi/cab/zip/deb 等）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页地址（http/https）' },
        max_chars: { type: 'integer', description: '正文最多返回多少字，默认 8000' },
        all_links: { type: 'boolean', description: '同时返回页面上的全部链接（默认只返回可下载文件的链接）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'driver_search',
    description:
      '在微软更新目录（Microsoft Update Catalog，微软官方）搜索驱动和系统补丁。用硬件 ID 搜索驱动，如 "PCI\\VEN_10EC&DEV_8168"（去掉 SUBSYS 等后缀更容易搜到）；也可搜补丁编号，如 "KB2999226"。' +
      '返回更新编号（id）、标题、适用系统、日期、版本、大小；选好后用 download_to_pc 的 catalog_id 下载。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '硬件 ID、驱动名称或 KB 编号' } },
      required: ['query'],
    },
  },
  {
    name: 'save_attachment_to_pc',
    description:
      '把用户在对话里发来的图片保存到电脑的「下载/PhoneToDesktop」目录，返回电脑上的路径。发来的图片默认只给你看、不会存到电脑；' +
      '只在用户要求把图片放到电脑上（保存、放到桌面、插进文档等）时调用，之后用电脑工具复制或移动到目标位置。',
    inputSchema: {
      type: 'object',
      properties: {
        attachment: { type: 'string', description: '附件编号或文件名（见用户消息里的附件列表）；不填表示最近发来的那张图片' },
      },
    },
  },
  {
    name: 'download_to_pc',
    description:
      '用手机的网络下载文件，经连接通道（数据线或 WiFi）传到电脑的「下载/PhoneToDesktop」目录（电脑本身不需要联网）。返回电脑上的保存路径、SHA-256，Windows 上还会返回数字签名状态。' +
      '只从官方来源下载（微软、硬件厂商官网、系统官方软件源）。最大 1 GB。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '下载地址（http/https）。与 catalog_id 二选一' },
        catalog_id: { type: 'string', description: 'driver_search 返回的更新编号，自动获取微软官方下载地址并校验 SHA-1' },
        filename: { type: 'string', description: '保存的文件名，默认取下载地址中的文件名' },
        sha256: { type: 'string', description: '已知的 SHA-256（官网公布时填写），下载后自动核对' },
      },
    },
  },
];

const PHONE_NAMES = new Set(PHONE_TOOLS.map((t) => t.name));

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 从下载地址取文件名 */
export function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const name = decodeURIComponent(last).replace(/[\\/:*?"<>|]/g, '_');
    return name || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 签名结果「Valid|CN=...」转成给模型看的一行 */
export function describeSignature(sig: string | undefined): string | null {
  if (!sig) return null;
  const [status, ...rest] = sig.split('|');
  const signer = rest.join('|').trim();
  const meaning: Record<string, string> = {
    Valid: '有效',
    NotSigned: '未签名',
    HashMismatch: '文件已被篡改（哈希不匹配）',
    NotTrusted: '签名证书不受信任',
    UnknownError: '无法验证（可能是证书链不完整，如 Win7 缺少新根证书）',
  };
  return `${status}（${meaning[status] ?? '未知状态'}）${signer ? ` · ${signer}` : ''}`;
}

export function createPhoneTools(deps: PhoneToolDeps): AgentTools {
  return {
    list: () => {
      // 记住了电脑时，定时任务可以指定在哪几台上执行
      const names = deps.schedules?.pcNames?.() ?? [];
      if (!names.length) return PHONE_TOOLS;
      return PHONE_TOOLS.map((t) =>
        t.name === 'schedule_create' || t.name === 'schedule_update'
          ? {
              ...t,
              inputSchema: {
                ...t.inputSchema,
                properties: { ...((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}), pcs: pcsSchema(names) },
              },
            }
          : t,
      );
    },
    async call(name, args, signal) {
      switch (name) {
        case 'web_search': {
          const q = str(args.query);
          if (!q) return text('query 不能为空', true);
          const r = await webSearch(deps.fetch, q, typeof args.count === 'number' ? args.count : 8, signal);
          if (!r.length) return text(`没有搜索到「${q}」的结果`);
          return text(r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n'));
        }
        case 'web_fetch': {
          const url = str(args.url);
          if (!/^https?:\/\//i.test(url)) return text('url 需要以 http:// 或 https:// 开头', true);
          const page = await webFetch(deps.fetch, url, signal);
          const max = typeof args.max_chars === 'number' && args.max_chars > 0 ? Math.min(args.max_chars, 30000) : 8000;
          const links = args.all_links ? page.links.slice(0, 150) : fileLinks(page.links).slice(0, 60);
          const parts = [`标题：${page.title || '（无）'}`, clip(page.text, max)];
          if (links.length) {
            parts.push(
              `${args.all_links ? '页面链接' : '可下载文件链接'}：\n${links.map((l) => `- ${l.text || '(无文字)'}：${l.url}`).join('\n')}`,
            );
          }
          return text(parts.join('\n\n'));
        }
        case 'driver_search': {
          const q = str(args.query);
          if (!q) return text('query 不能为空', true);
          const items = await catalogSearch(deps.fetch, q, signal);
          if (!items.length) {
            return text(`微软更新目录中没有找到「${q}」。可以去掉硬件 ID 中的 SUBSYS / REV 部分再试，或用 web_search 到厂商官网查找。`);
          }
          return text(
            `找到 ${items.length} 个结果（按相关度排序，只列前 25 个）：\n` +
              items
                .slice(0, 25)
                .map(
                  (x) =>
                    `- id=${x.id}\n  ${x.title} | 版本 ${x.version} | ${x.date} | ${x.size}\n  适用：${x.products} | 分类：${x.classification}`,
                )
                .join('\n'),
          );
        }
        case 'schedule_create': {
          if (!deps.schedules) return text('当前无法创建定时任务', true);
          const input = parseScheduleArgs(args);
          if (typeof input === 'string') return text(input, true);
          const pcs = resolveTaskPcs(deps.schedules, args.pcs);
          if (typeof pcs === 'string') return text(pcs, true);
          const t = deps.schedules.create(pcs.length ? { ...input, pcs } : input);
          return text(`已创建定时任务：\n${describeTask(t, Date.now(), deps.schedules.pcLabel)}`);
        }
        case 'schedule_list': {
          if (!deps.schedules) return text('当前无法查看定时任务', true);
          const list = deps.schedules.list();
          const label = deps.schedules.pcLabel;
          return text(
            list.length ? `共 ${list.length} 个定时任务：\n${list.map((t) => describeTask(t, Date.now(), label)).join('\n')}` : '还没有定时任务',
          );
        }
        case 'schedule_update': {
          if (!deps.schedules) return text('当前无法修改定时任务', true);
          const patch: SchedulePatch = {};
          if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
          if (str(args.name)) patch.name = str(args.name).slice(0, 40);
          if (str(args.prompt)) patch.prompt = str(args.prompt).slice(0, 2000);
          if (Array.isArray(args.pcs)) {
            const pcs = resolveTaskPcs(deps.schedules, args.pcs);
            if (typeof pcs === 'string') return text(pcs, true);
            patch.pcs = pcs;
          }
          const t = deps.schedules.update(str(args.id), patch);
          return t
            ? text(`已更新：\n${describeTask(t, Date.now(), deps.schedules.pcLabel)}`)
            : text(`没有找到定时任务 ${str(args.id)}`, true);
        }
        case 'schedule_delete': {
          if (!deps.schedules) return text('当前无法删除定时任务', true);
          return deps.schedules.remove(str(args.id)) ? text('已删除') : text(`没有找到定时任务 ${str(args.id)}`, true);
        }
        case 'ask_user': {
          if (!deps.askUser) return text('当前无法向用户提问', true);
          const q = parseAskArgs(args);
          if (typeof q === 'string') return text(q, true);
          return text(formatAnswer(await deps.askUser(q, signal)));
        }
        case 'save_attachment_to_pc': {
          if (!deps.saveAttachment) return text('电脑未连接，无法保存到电脑', true);
          const r = await deps.saveAttachment(str(args.attachment), { signal });
          return text(`已把 ${r.name} 保存到电脑：${r.path}
大小：${formatBytes(r.size)}`);
        }
        case 'download_to_pc': {
          if (!deps.downloadToPc) return text('电脑未连接，无法传输文件', true);
          let url = str(args.url);
          let expectedSha1: string | null = null;
          const catalogId = str(args.catalog_id);
          if (catalogId) {
            const files = await catalogFiles(deps.fetch, catalogId, signal);
            if (!files.length) return text(`没有获取到更新 ${catalogId} 的下载地址`, true);
            url = files[0].url;
            expectedSha1 = files[0].sha1;
            if (!str(args.filename)) args = { ...args, filename: files[0].fileName };
          }
          if (!/^https?:\/\//i.test(url)) return text('需要提供 url（http/https）或 catalog_id', true);
          url = preferHttps(url);
          const fileName = str(args.filename) || fileNameFromUrl(url);
          const r = await deps.downloadToPc(url, fileName, { signal, onProgress: deps.onProgress });

          const lines = [`已传到电脑：${r.path}`, `大小：${formatBytes(r.size)}（${r.size} 字节）`, `来源：${new URL(url).host}`];
          let bad = false;
          if (r.sha256) {
            const want = str(args.sha256).toLowerCase();
            if (want && want !== r.sha256.toLowerCase()) {
              bad = true;
              lines.push(`SHA-256：${r.sha256}（与提供的 ${want} 不一致！文件可能损坏或被篡改，不要使用）`);
            } else lines.push(`SHA-256：${r.sha256}${want ? '（与提供的一致）' : ''}`);
          }
          if (expectedSha1 && r.sha1) {
            if (expectedSha1.toLowerCase() !== r.sha1.toLowerCase()) {
              bad = true;
              lines.push(`SHA-1：${r.sha1}（与微软更新目录提供的 ${expectedSha1} 不一致！不要使用）`);
            } else lines.push('SHA-1：与微软更新目录提供的一致');
          }
          const sig = describeSignature(r.signature);
          if (sig) lines.push(`数字签名：${sig}`);
          return text(lines.join('\n'), bad);
        }
      }
      return text(`未知的手机工具：${name}`, true);
    },
  };
}

/** 是否是手机端工具 */
export function isPhoneTool(name: string): boolean {
  return PHONE_NAMES.has(name);
}

/** 合并手机工具和电脑工具：按名称分派 */
export function combineTools(phone: AgentTools, pc: AgentTools): AgentTools {
  return {
    list: () => [...pc.list(), ...phone.list()],
    call: (name, args, signal) => (PHONE_NAMES.has(name) ? phone.call(name, args, signal) : pc.call(name, args, signal)),
  };
}
