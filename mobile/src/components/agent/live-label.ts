// Agent 实时操作的文字说明（实时画面小窗、虚拟桌面页共用）。

import type { LiveAction } from '@/agent/conversations';

const TOOL_LABEL: Record<string, string> = {
  sys_info: '查看系统信息',
  shell_exec: '执行命令',
  fs_list: '浏览文件夹',
  fs_read: '读取文件',
  fs_write: '写入文件',
  fs_edit: '修改文件',
  fs_search: '搜索文件',
  fs_delete: '删除文件',
  doc_read: '读取文档',
  screen_capture: '查看屏幕',
  input_mouse: '操作鼠标',
  input_keyboard: '操作键盘',
  ui_tree: '读取界面元素',
  ui_act: '操作界面元素',
  web_search: '手机联网搜索',
  web_fetch: '手机读取网页',
  driver_search: '查找驱动',
  download_to_pc: '下载到电脑',
  ask_user: '等你选择',
  schedule_create: '创建定时任务',
  schedule_list: '查看定时任务',
  schedule_update: '修改定时任务',
  schedule_delete: '删除定时任务',
  skill_read: '读取 Skill',
  skill_run: '运行 Skill 脚本',
  ext_list: '查看扩展',
  ext_add_mcp: '添加 MCP',
  ext_install_skill: '安装 Skill',
  ext_create_skill: '创建 Skill',
  ext_toggle: '开关扩展',
  ext_remove: '卸载扩展',
};

/** 工具的中文名；MCP 工具（前缀__工具名）显示为「MCP：工具名」 */
export function toolLabel(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  const i = name.indexOf('__');
  return i > 0 ? `MCP：${name.slice(i + 2)}` : name;
}

export function liveText(live: LiveAction | null, running: boolean): string {
  if (!live) return running ? 'Agent 正在思考…' : '';
  const label = toolLabel(live.name);
  return live.summary ? `${label}：${live.summary}` : label;
}
