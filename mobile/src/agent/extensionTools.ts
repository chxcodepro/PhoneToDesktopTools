// 扩展相关的 Agent 工具：已安装 MCP 的工具（改名后合并）、skill_read / skill_run，以及在对话里管理扩展的 ext_*。
// 安装类操作先在对话里弹出确认卡片，用户点「安装」才生效。
// 保存、连接、读写文件由 extensionStore.ts 通过 ExtensionApi 注入，本文件不依赖 React Native，可在 Node 中测试。

import type { ToolInfo, ToolResult } from '../protocol/types';
import type { AgentTools } from './agent';
import { parseMcpConfig, wrapTool, type McpDraft, type McpServer, type Skill } from './extensions';
import type { AskAnswer, AskQuestion } from './phoneTools';

export interface ServerStatus {
  state: 'idle' | 'connecting' | 'ready' | 'error' | 'offline';
  error?: string;
  tools: ToolInfo[];
}

/** 准备安装、等用户确认的 Skill 包 */
export interface SkillPackage {
  skills: { name: string; description: string; files: string[] }[];
  source: string;
  commit(): Promise<Skill[]>;
}

export interface ExtensionApi {
  servers(): McpServer[];
  skills(): Skill[];
  status(id: string): ServerStatus | undefined;
  /** 每个服务的工具前缀 */
  prefixes(): Map<string, string>;
  callMcp(serverId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  readSkill(skillId: string, path?: string): Promise<string>;
  runSkill(
    skillId: string,
    script: string,
    args: string,
    opts: { cwd?: string; timeoutSec?: number; admin?: boolean },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  addServers(drafts: McpDraft[], createdBy: 'user' | 'agent'): Promise<McpServer[]>;
  prepareSkillFromUrl(url: string, signal?: AbortSignal): Promise<SkillPackage>;
  prepareSkill(input: { name: string; description: string; instructions: string; files: Record<string, string> }): SkillPackage | string;
  setEnabled(kind: 'mcp' | 'skill', id: string, enabled: boolean): void;
  remove(kind: 'mcp' | 'skill', id: string): Promise<void>;
}

export interface ExtensionToolDeps {
  api: ExtensionApi;
  askUser?: (q: AskQuestion, signal?: AbortSignal) => Promise<AskAnswer>;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], isError });
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const SKILL_TOOLS: ToolInfo[] = [
  {
    name: 'skill_read',
    description: '读取已安装 Skill 的说明（SKILL.md）或其中的附带文件。用某个 Skill 之前先读它的 SKILL.md。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称' },
        path: { type: 'string', description: '附带文件的相对路径，默认 SKILL.md' },
      },
      required: ['name'],
    },
  },
  {
    name: 'skill_run',
    description:
      '在电脑上执行 Skill 附带的脚本（.ps1 / .bat / .sh / .py / .js 等，按系统自动选择解释器）。文件会先同步到电脑的缓存目录（只传一次），默认在该目录下执行。受「执行命令」权限控制。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill 名称' },
        script: { type: 'string', description: '脚本在 Skill 里的相对路径，如 scripts/merge.ps1' },
        args: { type: 'string', description: '传给脚本的参数（按命令行写法，自行加引号）' },
        cwd: { type: 'string', description: '工作目录，默认 Skill 目录' },
        timeout_sec: { type: 'integer', description: '超时秒数，默认 120，最大 600' },
        admin: { type: 'boolean', description: '以管理员 / root 身份执行' },
      },
      required: ['name', 'script'],
    },
  },
];

const EXT_TOOLS: ToolInfo[] = [
  {
    name: 'ext_list',
    description: '列出已安装的扩展：MCP 服务（状态、工具数）和 Skill。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ext_add_mcp',
    description:
      '添加 MCP 服务。可以给地址（远程 MCP，手机直连），或粘贴 mcpServers 格式的 JSON 配置（含 command 的会在电脑上运行）。会先弹出确认卡片，用户确认后才安装。不要让用户把令牌发在对话里：需要令牌的，安装后提醒用户到「扩展」页填写。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '远程 MCP 地址（http/https）' },
        name: { type: 'string', description: '显示名称' },
        config: { type: 'string', description: 'JSON 配置（{"mcpServers":{...}} 或单个服务对象）' },
        headers: { type: 'object', description: '请求头（如需要令牌，可只写名称、值留空）', additionalProperties: { type: 'string' } },
      },
    },
  },
  {
    name: 'ext_install_skill',
    description:
      '从网址安装 Skill：GitHub 仓库或子目录地址、.zip 下载地址、或 SKILL.md 的原始地址。会先弹出确认卡片，显示 Skill 名称和包含的脚本。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'ext_create_skill',
    description:
      '根据对话内容新建 Skill（例如把刚完成的流程固化下来以后复用）。instructions 是 SKILL.md 的正文（什么时候用、步骤是什么），files 是附带文件（相对路径 → 文本内容，如脚本）。会先弹出确认卡片。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '英文短横线命名，如 excel-report' },
        description: { type: 'string', description: '一句话说明这个 Skill 做什么、什么时候用' },
        instructions: { type: 'string', description: 'SKILL.md 正文（Markdown）' },
        files: { type: 'object', description: '附带文件：相对路径 → 文本内容', additionalProperties: { type: 'string' } },
      },
      required: ['name', 'description', 'instructions'],
    },
  },
  {
    name: 'ext_toggle',
    description: '启用或停用某个 MCP 服务或 Skill。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'MCP 或 Skill 的名称' }, enabled: { type: 'boolean' } },
      required: ['name', 'enabled'],
    },
  },
  {
    name: 'ext_remove',
    description: '卸载某个 MCP 服务或 Skill（会弹出确认卡片）。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

const FIXED_NAMES = new Set([...SKILL_TOOLS, ...EXT_TOOLS].map((t) => t.name));

/** 按名称（或 id）找扩展 */
function findExt(api: ExtensionApi, key: string): { kind: 'mcp'; item: McpServer } | { kind: 'skill'; item: Skill } | null {
  const k = key.trim().toLowerCase();
  const s = api.servers().find((x) => x.id === key || x.name.toLowerCase() === k);
  if (s) return { kind: 'mcp', item: s };
  const sk = api.skills().find((x) => x.id === key || x.name.toLowerCase() === k);
  return sk ? { kind: 'skill', item: sk } : null;
}

export function describeDraft(d: McpDraft): string {
  if (d.kind === 'remote') {
    const secret = Object.keys(d.headers);
    return `远程 MCP（手机直连）\n地址：${d.url}${secret.length ? `\n请求头：${secret.join('、')}` : ''}`;
  }
  return `电脑上运行的 MCP\n命令：${[d.command, ...(d.args ?? [])].join(' ')}${Object.keys(d.env).length ? `\n环境变量：${Object.keys(d.env).join('、')}` : ''}`;
}

const STATE_TEXT: Record<ServerStatus['state'], string> = {
  idle: '未连接',
  connecting: '连接中',
  ready: '可用',
  error: '出错',
  offline: '电脑未连接',
};

export function createExtensionTools(deps: ExtensionToolDeps): AgentTools {
  const { api } = deps;

  /** 当前可用的 MCP 工具：合并后的名称 → 服务和原始工具名 */
  function mcpTable(): Map<string, { serverId: string; tool: string; info: ToolInfo }> {
    const table = new Map<string, { serverId: string; tool: string; info: ToolInfo }>();
    const prefixes = api.prefixes();
    for (const s of api.servers()) {
      const st = api.status(s.id);
      if (!s.enabled || st?.state !== 'ready') continue;
      const prefix = prefixes.get(s.id);
      if (!prefix) continue;
      for (const t of st.tools) {
        if (s.disabledTools.includes(t.name)) continue;
        const info = wrapTool(s.name, prefix, t);
        table.set(info.name, { serverId: s.id, tool: t.name, info });
      }
    }
    return table;
  }

  async function confirm(question: string, signal?: AbortSignal): Promise<boolean> {
    if (!deps.askUser) return true;
    const a = await deps.askUser(
      { question, options: [{ label: '安装' }, { label: '取消' }], multiple: false, allowCustom: false },
      signal,
    );
    return a.selected[0] === '安装';
  }

  function listText(): string {
    const lines: string[] = [];
    const servers = api.servers();
    const skills = api.skills();
    if (!servers.length && !skills.length) return '还没有安装任何扩展。';
    if (servers.length) {
      lines.push(`MCP 服务（${servers.length} 个）：`);
      for (const s of servers) {
        const st = api.status(s.id);
        const state = s.enabled ? STATE_TEXT[st?.state ?? 'idle'] : '已停用';
        const where = s.kind === 'remote' ? '远程' : '电脑';
        lines.push(
          `- ${s.name}（${where}，${state}${st?.state === 'ready' ? `，${st.tools.length} 个工具` : ''}${st?.error ? `：${st.error}` : ''}）`,
        );
      }
    }
    if (skills.length) {
      lines.push(`Skill（${skills.length} 个）：`);
      for (const s of skills) lines.push(`- ${s.name}${s.enabled ? '' : '（已停用）'}：${s.description}`);
    }
    return lines.join('\n');
  }

  async function installSkill(pkg: SkillPackage, signal?: AbortSignal): Promise<ToolResult> {
    if (!pkg.skills.length) return text('没有找到 SKILL.md', true);
    const desc = pkg.skills
      .map((s) => {
        const scripts = s.files.filter((f) => /\.(ps1|bat|cmd|sh|py|js|mjs|vbs|exe)$/i.test(f));
        return `「${s.name}」${s.description}${scripts.length ? `\n包含脚本：${scripts.join('、')}` : ''}`;
      })
      .join('\n\n');
    if (!(await confirm(`安装 Skill？\n来源：${pkg.source}\n\n${desc}`, signal))) return text('用户取消了安装');
    const installed = await pkg.commit();
    return text(`已安装 Skill：${installed.map((s) => s.name).join('、')}。现在就可以用 skill_read 读取。`);
  }

  return {
    list() {
      const tools: ToolInfo[] = [...[...mcpTable().values()].map((x) => x.info)];
      if (api.skills().some((s) => s.enabled)) tools.push(...SKILL_TOOLS);
      tools.push(...EXT_TOOLS.filter((t) => deps.askUser || !/^ext_(add|install|create|remove)/.test(t.name)));
      return tools;
    },

    async call(name, args, signal) {
      if (!FIXED_NAMES.has(name)) {
        const hit = mcpTable().get(name);
        if (!hit) return text(`MCP 工具不可用：${name}（服务可能已停用或断开）`, true);
        return api.callMcp(hit.serverId, hit.tool, args, signal);
      }
      switch (name) {
        case 'skill_read':
        case 'skill_run': {
          const key = str(args.name);
          const sk = api.skills().find((s) => s.enabled && (s.name.toLowerCase() === key.toLowerCase() || s.id === key));
          if (!sk)
            return text(
              `没有找到启用的 Skill「${key}」。已安装：${
                api
                  .skills()
                  .filter((s) => s.enabled)
                  .map((s) => s.name)
                  .join('、') || '无'
              }`,
              true,
            );
          if (name === 'skill_read') {
            const path = str(args.path) || 'SKILL.md';
            const content = await api.readSkill(sk.id, path);
            const others = sk.files.filter((f) => f.path !== 'SKILL.md').map((f) => f.path);
            return text(path === 'SKILL.md' && others.length ? `${content}\n\n［附带文件：${others.join('、')}］` : content);
          }
          const script = str(args.script);
          if (!sk.files.some((f) => f.path === script)) return text(`Skill「${sk.name}」里没有 ${script}`, true);
          const timeout = Math.min(600, Math.max(5, Number(args.timeout_sec) || 120));
          return api.runSkill(
            sk.id,
            script,
            str(args.args),
            { cwd: str(args.cwd) || undefined, timeoutSec: timeout, admin: args.admin === true },
            signal,
          );
        }
        case 'ext_list':
          return text(listText());
        case 'ext_add_mcp': {
          let drafts: McpDraft[] | string;
          if (str(args.config)) drafts = parseMcpConfig(str(args.config), str(args.name));
          else if (str(args.url)) drafts = parseMcpConfig(str(args.url), str(args.name));
          else return text('需要 url 或 config', true);
          if (typeof drafts === 'string') return text(drafts, true);
          const extra = args.headers && typeof args.headers === 'object' ? (args.headers as Record<string, unknown>) : {};
          for (const d of drafts) {
            if (d.kind === 'remote') for (const [k, v] of Object.entries(extra)) d.headers[k] = typeof v === 'string' ? v : '';
          }
          const q = `安装 MCP？\n\n${drafts.map((d) => `「${d.name}」${describeDraft(d)}`).join('\n\n')}`;
          if (!(await confirm(q, signal))) return text('用户取消了安装');
          const added = await api.addServers(drafts, 'agent');
          const needSecret = added.filter(
            (s) =>
              (s.secrets ?? []).length &&
              drafts.some((d) => d.name === s.name && Object.values({ ...d.headers, ...d.env }).some((v) => !v)),
          );
          return text(
            `已添加：${added.map((s) => s.name).join('、')}。正在连接，连上后工具会出现在工具列表里（下一步即可使用）。` +
              (needSecret.length
                ? `\n${needSecret.map((s) => `「${s.name}」需要填写 ${(s.secrets ?? []).join('、')}`).join('\n')}，请提醒用户到「扩展」页填写，不要让用户发在对话里。`
                : ''),
          );
        }
        case 'ext_install_skill': {
          const url = str(args.url);
          if (!/^https?:\/\//i.test(url)) return text('url 需要以 http:// 或 https:// 开头', true);
          return installSkill(await api.prepareSkillFromUrl(url, signal), signal);
        }
        case 'ext_create_skill': {
          const files: Record<string, string> = {};
          if (args.files && typeof args.files === 'object') {
            for (const [k, v] of Object.entries(args.files as Record<string, unknown>)) if (typeof v === 'string') files[k] = v;
          }
          const pkg = api.prepareSkill({
            name: str(args.name),
            description: str(args.description),
            instructions: str(args.instructions),
            files,
          });
          if (typeof pkg === 'string') return text(pkg, true);
          return installSkill(pkg, signal);
        }
        case 'ext_toggle': {
          const hit = findExt(api, str(args.name));
          if (!hit) return text(`没有找到扩展「${str(args.name)}」`, true);
          api.setEnabled(hit.kind, hit.item.id, args.enabled === true);
          return text(`已${args.enabled === true ? '启用' : '停用'}「${hit.item.name}」`);
        }
        case 'ext_remove': {
          const hit = findExt(api, str(args.name));
          if (!hit) return text(`没有找到扩展「${str(args.name)}」`, true);
          if (deps.askUser) {
            const a = await deps.askUser(
              {
                question: `卸载${hit.kind === 'mcp' ? ' MCP' : ' Skill'}「${hit.item.name}」？`,
                options: [{ label: '卸载' }, { label: '取消' }],
                multiple: false,
                allowCustom: false,
              },
              signal,
            );
            if (a.selected[0] !== '卸载') return text('用户取消了卸载');
          }
          await api.remove(hit.kind, hit.item.id);
          return text(`已卸载「${hit.item.name}」`);
        }
      }
      return text(`未知的扩展工具：${name}`, true);
    },
  };
}

/** 扩展工具是否由本模块处理（MCP 工具名都带 __） */
export function isExtensionTool(name: string): boolean {
  return FIXED_NAMES.has(name) || name.includes('__');
}
