// Agent 循环：模型 ↔ 电脑工具（MCP）。不依赖 React Native，可在 Node 中测试。
//
// 流程：调用模型 → 有工具调用就经 USB 让电脑执行 → 把结果交回模型 → 直到模型给出最终回答。
// 同时连着多台电脑时，同一轮里不同电脑的工具调用同时执行（AgentTools.group 分组），同一台按顺序。
// 截图：模型支持图片时作为图片发给模型（只保留最近一张）；不支持时改用文字识别结果（describeImage）。

import type { ToolContent, ToolInfo, ToolResult } from '../protocol/types';
import { chat, LlmError, type ChatMessage, type ContentPart, type FetchLike, type LlmConfig, type ToolSpec, type UsageStats } from './llm';

export interface AgentTools {
  list(): ToolInfo[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  /** 并发分组：同一轮的工具调用，同组按顺序执行、不同组同时执行。不提供时全部按顺序 */
  group?(name: string, args: Record<string, unknown>): string;
}

export interface ComputerInfo {
  host: string;
  os: string;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown>; summary: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      summary: string;
      image?: { data: string; mimeType: string };
    }
  | { type: 'notice'; text: string }
  /** 每次请求模型后的用量与速度 */
  | { type: 'usage'; stats: UsageStats };

export interface AgentOptions {
  llm: LlmConfig;
  fetch: FetchLike;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 可用的工具；不支持工具时为 null */
  tools: AgentTools | null;
  /** 电脑是否已连接（tools 里是否含电脑工具），默认 true；为 false 时只有手机端工具和扩展 */
  pcConnected?: boolean;
  /** 扩展（Skill / MCP）的说明；传函数时每一步重新获取（刚安装的扩展立即生效） */
  extensionPrompt?: string[] | (() => string[]);
  computer?: ComputerInfo | null;
  /** 同时连着的多台电脑（两台及以上时才传；host 是工具 pc 参数里的电脑名） */
  computers?: ComputerInfo[];
  /** 用户为当前模型填写的系统提示词，加在内置提示词之后 */
  customPrompt?: string;
  signal?: AbortSignal;
  /** 最多执行多少轮工具调用，默认 40 */
  maxSteps?: number;
  /**
   * 模型不支持图片时，把截图转成文字（手机端 OCR）。返回 null 表示无法识别。
   * context 是同一个工具返回的说明文字（screen_capture 的说明里有截图→屏幕坐标的换算公式）。
   */
  describeImage?: (data: string, mimeType: string, context?: string) => Promise<string | null>;
  onEvent?: (e: AgentEvent) => void;
}

const OLD_IMAGE_TEXT = '[较早的截图已省略]';
const NO_VISION_TEXT = '[图片：当前模型无法识别图片]';
/** 工具截图消息的开头，用来与用户上传的图片区分 */
export const SCREENSHOT_MARKER = '以下是工具返回的截图：';

function osName(os?: string): string {
  if (os === 'windows') return 'Windows';
  if (os === 'linux') return 'Linux（银河麒麟等）';
  return os || '未知系统';
}

export function buildSystemPrompt(
  opts: Pick<
    AgentOptions,
    'computer' | 'computers' | 'supportsVision' | 'tools' | 'supportsTools' | 'customPrompt' | 'pcConnected' | 'extensionPrompt'
  >,
): string {
  const lines: string[] = [];
  const toolsOn = !!opts.tools && opts.supportsTools;
  const connected = toolsOn && opts.pcConnected !== false;
  const multi = opts.computers && opts.computers.length > 1 ? opts.computers : null;
  const oses = multi ? [...new Set(multi.map((c) => c.os))] : [opts.computer?.os ?? ''];
  if (connected) {
    const c = opts.computer;
    if (multi) {
      lines.push(
        `你是运行在用户手机上的 AI 助手，同时连接着用户的 ${multi.length} 台电脑：${multi.map((m) => `「${m.host}」（${osName(m.os)}）`).join('、')}。`,
        '多台电脑：',
        '- 每个电脑工具都有 pc 参数，填电脑名，指定在哪台电脑上执行。用户说了在哪台就只操作那台；说「都」「每台」「同时」「两台」时每台各做一次。',
        '- 同一轮里调用不同电脑的工具会同时执行：几台电脑做同样的事时，在同一轮里把每台的调用一起发出；同一台电脑上的操作按顺序执行。',
        '- 用户没说在哪台、也不能从上下文判断时，先用 ask_user 问清楚，不要猜。',
        '- 工具结果开头的【电脑名】表示结果来自哪台电脑；汇报时分别说明每台电脑的情况。',
        '- 在两台电脑之间传文件用 pc_copy_file（经手机中转，保存到目标电脑的「下载/PhoneToDesktop」目录，需要时再用命令移动）。',
        '工作方式：',
      );
    } else {
      lines.push(
        `你是运行在用户手机上的 AI 助手，通过 USB 数据线或局域网 WiFi 连接并操作用户的电脑${c ? `（${c.host}，${osName(c.os)}）` : ''}。`,
        '工作方式：',
      );
    }
    lines.push(
      '- 直接使用工具完成任务，不要只给建议。每一步只做必要的操作，根据结果再决定下一步。',
      '- 不了解电脑环境时先调用 sys_info（可获得桌面路径、显示器等信息）。',
      '- 文件：使用绝对路径；修改已有文件优先用 fs_edit；fs_delete 会把文件移到回收站。',
    );
    const linuxCmd = '使用 bash 语法。需要 root 的命令设置 shell_exec 的 admin: true（不要写 sudo），电脑上会弹出密码框，提醒用户在电脑上输入密码。';
    const winCmd =
      '使用 cmd 语法（Win7 自带 PowerShell 2.0，功能有限）。需要管理员权限的命令设置 shell_exec 的 admin: true，电脑上会弹出 UAC 授权框，提醒用户在电脑上点「是」。';
    const hasLinux = oses.includes('linux');
    const hasWin = oses.some((o) => o !== 'linux');
    if (hasLinux && hasWin) lines.push(`- 命令：Windows 电脑${winCmd}`, `- 命令：Linux 电脑${linuxCmd}`);
    else lines.push(`- 命令：${hasLinux ? linuxCmd : winCmd}`);
    lines.push(
      '- 操作界面优先用控件树：ui_tree 读出窗口里的按钮、输入框、菜单等（名称和屏幕坐标，没有文字的图标也有名称），ui_act 按名称直接点击、填写、展开，比按坐标点更准；读不到元素的程序（游戏、远程桌面、自绘界面）再用截图 + input_mouse。',
    );
    if (opts.supportsVision) {
      lines.push(
        '- 看屏幕：screen_capture 截图，按返回的 scale 和偏移把截图坐标换算成屏幕坐标，再用 input_mouse / input_keyboard 操作；操作后再截图确认结果。',
      );
    } else {
      lines.push(
        '- 当前模型看不到图片：优先用命令和文件工具完成任务。必须操作界面时，screen_capture 会返回截图的文字识别结果：每行「(x, y) 文字」，坐标已换算成屏幕坐标，可直接用 input_mouse 点击；图标、颜色等没有文字的内容识别不到。操作后再截图确认结果。',
      );
    }
    lines.push(...repairGuide(oses));
    lines.push(
      '- 删除或覆盖重要文件、结束进程、关机重启等不可逆操作前，先用一句话说明你要做什么。',
      '- 工具返回「没有权限」时，告诉用户需要在手机「设置 → 电脑权限」里开启哪一项，不要反复重试。',
    );
  } else if (toolsOn) {
    lines.push(
      '你是运行在用户手机上的 AI 助手，可以通过 USB 数据线或局域网 WiFi 操作用户的电脑。',
      '电脑当前未连接，电脑上的工具（命令、文件、屏幕、键鼠）暂不可用；可以用手机端的工具（联网搜索、读网页、MCP 服务、Skill 说明、定时任务）完成不需要电脑的事。需要操作电脑时，提醒用户用数据线连接电脑（连过一次后，在同一 WiFi 下也会自动连上）。',
    );
  } else {
    lines.push(
      '你是运行在用户手机上的 AI 助手，可以通过 USB 数据线或局域网 WiFi 操作用户的电脑。',
      opts.tools
        ? '当前模型不支持工具调用，无法操作电脑，只能回答问题。'
        : '电脑当前未连接，无法操作电脑。需要操作电脑时，请提醒用户用数据线连接电脑并允许 USB 调试。',
    );
  }
  if (toolsOn) {
    lines.push(
      '',
      '和用户交互：',
      '- 需要用户做决定时（用手机下载还是让电脑下载、多个驱动 / 版本选哪个、是否安装或重启、几种方案选哪种），调用 ask_user 给出 2～6 个选项，等用户点选后再继续；不要在文字里列选项让用户回复。',
      '- 用户要求定期或在某个时间做某事时（如「每天早上 8 点体检」「明天提醒我清理磁盘」），用 schedule_create 创建定时任务，创建后说明下次执行时间；查看、停用、删除用 schedule_list / schedule_update / schedule_delete。',
    );
  }
  lines.push(
    '- 回答中可以用 ```p2d-ui 代码块（内容为 JSON）显示可视化组件，手机会渲染成卡片。只在比纯文字更清楚时使用，普通说明仍用文字。可用组件：',
    '  callout {"type":"callout","tone":"info|success|warning|error","title":"标题","text":"内容"}；',
    '  stats {"type":"stats","items":[{"label":"C 盘可用","value":"172 GB","hint":"共 476 GB","tone":"success"}]}（最多 4 个）；',
    '  progress {"type":"progress","label":"磁盘已用","value":64}；',
    '  steps {"type":"steps","items":[{"title":"下载驱动","status":"done|current|todo|error","detail":"说明"}]}；',
    '  kv {"type":"kv","title":"系统信息","items":[{"label":"系统","value":"Windows 10"}]}；',
    '  buttons {"type":"buttons","items":[{"label":"安装驱动","send":"点击后发给你的话"}]}（任务结束后给出后续操作建议：最多 3 个，手机上排成一行显示，label 简短（一般 4～8 个字），如「查看详情」「清理磁盘」，具体要求写在 send 里）。',
    '  多个组件放进数组：[{...},{...}]。',
  );
  lines.push('- 用户消息末尾的［发送时间 …］是系统附加的手机本地时间，用来理解「今天」「明天」「下周一」，不要在回答里提起它。');
  const ext = typeof opts.extensionPrompt === 'function' ? opts.extensionPrompt() : opts.extensionPrompt;
  if (toolsOn && ext?.length) lines.push(...ext, '');
  lines.push('用简体中文回答，简洁明了。任务完成后简要说明结果。');
  const custom = opts.customPrompt?.trim();
  if (custom) {
    // 放在最后，优先级最高；但不能用来绕过上面的安全规则
    lines.push('', '以下是用户设置的要求（与上面的规则冲突时，安全相关规则仍然优先）：', custom);
  }
  return lines.join('\n');
}

/** 电脑断网、缺驱动 / 缺运行库时的处理办法（手机有网，电脑可能完全没网）。oses：连着的电脑的系统（多台时可能有两种） */
function repairGuide(oses: string[]): string[] {
  const common = [
    '',
    '电脑可能完全没有网络（网卡驱动坏了、没有可用 WiFi、USB 网络共享也用不了），但手机有网。修复规则：',
    '- 不要让电脑自己联网下载。查资料用 web_search / web_fetch，查驱动用 driver_search，下载用 download_to_pc（手机下载后经连接通道传到电脑的「下载/PhoneToDesktop」目录）。',
    '- 只从官方来源下载：微软（microsoft.com、windowsupdate.com、aka.ms）、硬件厂商官网、系统官方软件源。不要从第三方「DLL 下载站」下载单个 DLL。',
    '- 网站有人机验证（Cloudflare 等）时不要尝试绕过：先换其他官方来源；只能从那里下载时，用 ask_user 请用户在手机浏览器手动下载，再在对话里点「＋ → 文件」把文件发过来（会自动传到电脑）。',
    '- Windows 安装前看 download_to_pc 返回的数字签名，应为 Valid 且签名者可信；哈希不一致或签名异常时不要安装。',
    '- 安装驱动、替换系统文件、改系统服务启动方式前，先说明要做什么并等用户同意；替换文件前先备份原文件。',
    '- 先排查能在本地解决的原因（服务没启动、设备被禁用、驱动库里已有驱动、协议栈损坏），确实缺文件时再下载。',
  ];
  const linux = [
    '- 网络排查：ip link、nmcli device status、systemctl status NetworkManager、rfkill list、lspci -nnk / lsusb（看网卡型号和驱动）、dmesg | grep -iE "firmware|eth|wlan"。',
    '- 缺软件包：cat /etc/os-release、dpkg --print-architecture 确认系统和架构；apt-get --print-uris -y install 包名 可离线列出该包及缺失依赖的官方下载地址，逐个 download_to_pc 后用 dpkg -i 安装（admin: true）。',
  ];
  const windows = [
    '- 网络排查：ipconfig /all；netsh interface show interface；sc query 查看 Dhcp、Dnscache、NlaSvc、netprofm、Netman、nsi、WlanSvc 等服务；有问题的设备用 wmic path Win32_PnPEntity where "ConfigManagerErrorCode<>0" get Name,DeviceID,ConfigManagerErrorCode（Win7 也可用）。',
    '- 驱动：从 DeviceID 取硬件 ID（如 PCI\\VEN_10EC&DEV_8168）→ driver_search → download_to_pc（catalog_id）→ 解压 .cab：expand -F:* 文件.cab 目标目录 → 安装：Win10 用 pnputil /add-driver 目录\\*.inf /subdirs /install，Win7 用 pnputil -i -a 目录\\*.inf（都要 admin: true）。先用 pnputil -e（Win7）/ pnputil /enum-drivers 看驱动库里是否已有可用驱动。',
    '- 协议栈损坏：netsh winsock reset、netsh int ip reset（admin: true，需重启生效，重启前征得用户同意）。',
    '- 缺 DLL 先判断属于哪个运行库：vcruntime140*.dll、msvcp140*.dll、mfc140*.dll → VC++ 2015-2022 运行库（微软官方地址 https://aka.ms/vc14/vc_redist.x64.exe 或 https://aka.ms/vc14/vc_redist.x86.exe，按程序位数选；Win7 装不上时用 web_search 查仍支持 Win7 的版本）；msvcr120/msvcp120 → VC++ 2013；msvcr110 → VC++ 2012；api-ms-win-crt-*.dll（Win7）→ 补丁 KB2999226（用 driver_search 搜 KB 编号）；d3dx9_*、xinput1_3、d3dcompiler_43 → DirectX 9.0c 运行库（June 2010）；mscoree / .NET 报错 → .NET Framework 离线安装包。安装程序用静默参数（如 vc_redist /install /quiet /norestart）。',
  ];
  const hasLinux = oses.includes('linux');
  const hasWin = oses.some((o) => o !== 'linux');
  if (hasLinux && hasWin) return [...common, '- Linux 电脑：', ...linux, '- Windows 电脑：', ...windows];
  return [...common, ...(hasLinux ? linux : windows)];
}

export function toToolSpecs(tools: ToolInfo[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

/** 给界面显示的参数摘要 */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  // 多台电脑时参数里有 pc（电脑名）：摘要前面标上
  if (typeof args.pc === 'string' && args.pc) {
    const { pc, ...rest } = args;
    return `[${pc}] ${summarizeArgs(name, rest)}`;
  }
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (name) {
    case 'shell_exec':
      return args.admin ? `[管理员] ${s(args.command)}` : s(args.command);
    case 'input_mouse': {
      const pos = args.x !== undefined ? ` (${args.x}, ${args.y})` : '';
      return `${s(args.action)}${pos}`;
    }
    case 'input_keyboard':
      return args.action === 'key' ? s(args.keys) : `输入「${s(args.text).slice(0, 40)}」`;
    case 'screen_capture':
      return `显示器 ${args.display ?? 0}`;
    case 'ui_tree':
      if (args.list_windows) return '所有窗口';
      return [s(args.window) || '前台窗口', s(args.name) && `「${s(args.name)}」`, s(args.type)].filter(Boolean).join(' · ');
    case 'ui_act': {
      const verb: Record<string, string> = {
        click: '点击',
        set_value: '填写',
        focus: '聚焦',
        toggle: '切换',
        expand: '展开',
        collapse: '收起',
      };
      return `${verb[s(args.action)] ?? s(args.action)}「${s(args.name)}」`;
    }
    case 'sys_info':
      return '系统信息';
    case 'web_search':
    case 'driver_search':
      return s(args.query);
    case 'web_fetch':
      return s(args.url);
    case 'ask_user':
      return s(args.question);
    case 'schedule_create':
    case 'schedule_update':
      return s(args.name) || s(args.id);
    case 'schedule_delete':
      return s(args.id);
    case 'schedule_list':
      return '定时任务列表';
    case 'download_to_pc':
      return args.catalog_id ? `微软更新目录 ${s(args.catalog_id)}` : s(args.url);
    case 'skill_read':
      return `${s(args.name)}${args.path ? ` / ${s(args.path)}` : ''}`;
    case 'skill_run':
      return `${s(args.name)} / ${s(args.script)}${args.admin ? ' [管理员]' : ''}`;
    case 'ext_add_mcp':
      return s(args.name) || s(args.url) || 'JSON 配置';
    case 'ext_install_skill':
      return s(args.url);
    case 'ext_create_skill':
    case 'ext_toggle':
    case 'ext_remove':
      return s(args.name);
    case 'ext_list':
      return '扩展列表';
    default:
      if (typeof args.path === 'string') return args.path;
      return Object.values(args).map(s).join(' ').slice(0, 80);
  }
}

/** 给界面显示的结果摘要 */
function summarizeResult(name: string, text: string): string {
  if (name === 'sys_info') {
    try {
      const j = JSON.parse(text);
      return [j.hostname, j.os_version].filter(Boolean).join(' · ') || firstLine(text);
    } catch {
      // 不是 JSON 时按普通文字处理
    }
  }
  return firstLine(text);
}

function firstLine(text: string, max = 160): string {
  const t =
    text
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function isScreenshotMessage(m: ChatMessage): boolean {
  return Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === SCREENSHOT_MARKER;
}

/**
 * 控制发给模型的图片数量：工具截图只保留最近 keep 条消息里的；用户上传的图片保留最近 keepUser 条消息里的。
 * 其余图片替换为文字，避免上下文越来越大。
 */
export function pruneImages(messages: ChatMessage[], keep = 1, keepUser = 3): ChatMessage[] {
  let shots = 0;
  let uploads = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!Array.isArray(m.content)) continue;
    if (!m.content.some((p) => p.type === 'image_url')) continue;
    const screenshot = isScreenshotMessage(m);
    if (screenshot ? shots++ < keep : uploads++ < keepUser) continue;
    out[i] = {
      ...m,
      content: m.content.map((p): ContentPart => (p.type === 'image_url' ? { type: 'text', text: OLD_IMAGE_TEXT } : p)),
    };
  }
  return out;
}

/** 去掉全部图片（模型不支持图片时） */
function stripAllImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
      ? { ...m, content: m.content.map((p): ContentPart => (p.type === 'image_url' ? { type: 'text', text: NO_VISION_TEXT } : p)) }
      : m,
  );
}

const hasImages = (messages: ChatMessage[]) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

/** 400 错误是否表示模型不接受图片输入 */
function isVisionUnsupported(e: unknown): boolean {
  return (
    e instanceof LlmError &&
    (e.status === 400 || e.status === 422) &&
    /image|vision|multimodal|多模态|图片|图像|unknown variant|content.*(type|array)|expected.*string/i.test(e.message)
  );
}

class AbortedError extends Error {
  constructor() {
    super('已停止');
    this.name = 'AbortError';
  }
}

/**
 * 运行 Agent。history 为完整对话（含刚发出的用户消息，不含系统提示）。
 * 返回本次新增的消息（助手消息、工具结果、截图消息），即使中途停止或出错，返回的消息也保持合法顺序。
 */
export async function runAgent(history: ChatMessage[], opts: AgentOptions): Promise<{ added: ChatMessage[]; error?: Error }> {
  const added: ChatMessage[] = [];
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  const maxSteps = opts.maxSteps ?? 40;
  const useTools = !!opts.tools && opts.supportsTools;
  // 模型实际不支持图片时（接口返回 400），本次运行改为不带图片
  let visionOk = true;

  try {
    for (let step = 0; ; step++) {
      if (opts.signal?.aborted) throw new AbortedError();
      if (step >= maxSteps) {
        emit({ type: 'notice', text: `已连续执行 ${maxSteps} 步，先停下来。可以回复「继续」让我接着做。` });
        break;
      }
      // 每一步重新取工具和系统提示词：本次运行中刚安装的 MCP / Skill 下一步就能用
      const tools = useTools ? toToolSpecs(opts.tools!.list()) : undefined;
      // 模型实际不接受图片时，提示词和截图处理都按「看不到图片」来（改用文字识别）
      const canSee = opts.supportsVision && visionOk;
      const system: ChatMessage = { role: 'system', content: buildSystemPrompt({ ...opts, supportsVision: canSee }) };
      const pruned = pruneImages([...history, ...added]);
      const callModel = (msgs: ChatMessage[]) =>
        chat(
          opts.llm,
          [system, ...msgs],
          opts.fetch,
          {
            onText: (delta) => emit({ type: 'text', delta }),
            onReasoning: (delta) => emit({ type: 'reasoning', delta }),
          },
          { tools, signal: opts.signal },
        );
      let result;
      if (!visionOk) {
        result = await callModel(stripAllImages(pruned));
      } else {
        try {
          result = await callModel(pruned);
        } catch (e) {
          if (!hasImages(pruned) || !isVisionUnsupported(e)) throw e;
          visionOk = false;
          emit({ type: 'notice', text: '当前模型不支持图片输入，已改为不带图片继续。可在「设置 → 模型」关闭「支持图片」。' });
          result = await callModel(stripAllImages(pruned));
        }
      }
      const { message, stats } = result;
      emit({ type: 'usage', stats });
      added.push(message);
      const calls = message.tool_calls ?? [];
      if (!calls.length) break;

      // 执行工具：同一台电脑上的操作有先后顺序，按顺序执行；同时连着多台电脑时，不同电脑的操作同时执行
      const canSeeNow = () => opts.supportsVision && visionOk;
      const parsed = calls.map((call) => {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const p = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          args = p && typeof p === 'object' ? p : {};
        } catch {
          parseError = '参数不是合法的 JSON，请重新生成参数';
        }
        return { call, name, args, parseError };
      });
      type Done = { text: string; imgs: { data: string; mimeType: string }[]; isError: boolean };
      const done: Done[] = new Array(calls.length);

      const runOne = async (i: number): Promise<void> => {
        const { call, name, args, parseError } = parsed[i];
        emit({ type: 'tool_start', id: call.id, name, args, summary: summarizeArgs(name, args) });
        if (opts.signal?.aborted) {
          done[i] = { text: '用户已停止', imgs: [], isError: true };
          emit({ type: 'tool_end', id: call.id, name, isError: true, summary: '已停止' });
          return;
        }
        if (parseError || !opts.tools) {
          const text = parseError ?? '电脑未连接';
          done[i] = { text, imgs: [], isError: true };
          emit({ type: 'tool_end', id: call.id, name, isError: true, summary: text });
          return;
        }

        // 看不到图片的模型靠文字识别：截图只传到手机、不发给模型，用更高的分辨率和画质识别更准
        const callArgs =
          name === 'screen_capture' && !canSeeNow() && opts.describeImage
            ? { ...args, max_width: Math.max(Number(args.max_width) || 0, 2560), quality: Math.max(Number(args.quality) || 0, 85) }
            : args;
        let result: ToolResult;
        try {
          result = await opts.tools.call(name, callArgs, opts.signal);
        } catch (e) {
          result = { content: [{ type: 'text', text: `调用失败：${(e as Error).message}` }], isError: true };
        }
        const texts = result.content.filter((c): c is Extract<ToolContent, { type: 'text' }> => c.type === 'text').map((c) => c.text);
        const imgs = result.content.filter((c): c is Extract<ToolContent, { type: 'image' }> => c.type === 'image');
        let text = texts.join('\n');
        const toModel: { data: string; mimeType: string }[] = [];

        for (const img of imgs) {
          // 本步刚发现模型不接受图片时，这一步的截图也改用文字识别
          if (canSeeNow()) {
            toModel.push({ data: img.data, mimeType: img.mimeType });
          } else {
            let described: string | null = null;
            try {
              described = opts.describeImage ? await opts.describeImage(img.data, img.mimeType, texts.join('\n')) : null;
            } catch {
              described = null;
            }
            text += described
              ? `\n截图的文字识别结果：\n${described}`
              : '\n（当前模型看不到图片，且未能识别截图文字。请改用命令、文件等文字类工具获取信息。）';
          }
        }
        done[i] = { text, imgs: toModel, isError: !!result.isError };
        emit({
          type: 'tool_end',
          id: call.id,
          name,
          isError: !!result.isError,
          summary: summarizeResult(name, texts.join('\n')) || (imgs.length ? '已截图' : '完成'),
          image: imgs[0] ? { data: imgs[0].data, mimeType: imgs[0].mimeType } : undefined,
        });
      };

      const groups = new Map<string, number[]>();
      parsed.forEach((p, i) => {
        const key = p.parseError || !opts.tools?.group ? 'main' : opts.tools.group(p.name, p.args);
        groups.set(key, [...(groups.get(key) ?? []), i]);
      });
      await Promise.all(
        [...groups.values()].map(async (idxs) => {
          for (const i of idxs) {
            try {
              await runOne(i);
            } catch (e) {
              done[i] = { text: `调用失败：${(e as Error).message}`, imgs: [], isError: true };
            }
          }
        }),
      );

      // 按调用顺序写回结果；截图统一放在下一条消息里，按顺序编号
      const images: { data: string; mimeType: string }[] = [];
      parsed.forEach(({ call }, i) => {
        const d = done[i] ?? { text: '用户已停止', imgs: [], isError: true };
        let text = d.text;
        for (const img of d.imgs) {
          images.push(img);
          text += `\n（截图见下一条消息${images.length > 1 || parsed.length > 1 ? `的第 ${images.length} 张图` : ''}）`;
        }
        added.push({ role: 'tool', tool_call_id: call.id, content: text || (d.isError ? '失败' : '完成') });
      });
      if (images.length) {
        added.push({
          role: 'user',
          content: [
            { type: 'text', text: SCREENSHOT_MARKER },
            ...images.map((img): ContentPart => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
          ],
        });
      }
    }
    return { added };
  } catch (e) {
    // 补齐缺失的工具结果，保证对话历史合法（每个 tool_call 都要有对应的 tool 消息）
    const last = added[added.length - 1];
    if (last?.role === 'assistant' && last.tool_calls?.length) {
      for (const c of last.tool_calls) added.push({ role: 'tool', tool_call_id: c.id, content: '用户已停止' });
    } else {
      const answered = new Set(added.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      const lastAssistant = [...added].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length);
      for (const c of lastAssistant?.tool_calls ?? []) {
        if (!answered.has(c.id)) added.push({ role: 'tool', tool_call_id: c.id, content: '用户已停止' });
      }
    }
    const err = e as Error;
    const aborted = err?.name === 'AbortError' || opts.signal?.aborted;
    return { added, error: aborted ? new AbortedError() : err };
  }
}
