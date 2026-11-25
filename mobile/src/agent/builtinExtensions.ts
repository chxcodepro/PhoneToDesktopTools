// 内置的 MCP 和 Skill：第一次打开 App 时自动装上，用户可以停用或删除（删除后不会再自动装回来）。
// - Skill 是自己写的中文说明书 + 脚本，脚本只读取信息、不做改动，要改动时 Agent 先问用户，再用 shell_exec 执行。
//   Windows 脚本兼容 Win7 自带的 PowerShell 2.0（只用 Get-WmiObject 等老命令），文件带 UTF-8 BOM，否则 PowerShell 2.0 会把中文读成乱码；
//   麒麟脚本用 bash。
// - MCP 只放免费、不用登录、走手机网络的远程服务（电脑一般不能上网，也没有 Node / Python）。
// 内容有更新时把 version 加一：用户没删、没改过的内置 Skill 会被更新。

import { buildSkillMd, type McpDraft } from './extensions';

/** 内置 Skill 的「来源」；用户在扩展页改过后变成 BUILTIN_EDITED_SOURCE，之后不再自动更新 */
export const BUILTIN_SOURCE = '内置';
export const BUILTIN_EDITED_SOURCE = '内置（已修改）';

export interface BuiltinSkill {
  key: string;
  version: number;
  name: string;
  description: string;
  body: string;
  /** 附带文件（相对路径 → 内容） */
  files: Record<string, string>;
}

export interface BuiltinMcp {
  key: string;
  version: number;
  draft: McpDraft;
}

const BOM = '\ufeff';

// ---------------- 电脑体检 ----------------

const HEALTH_PS1 = String.raw`# 电脑体检（只读）：系统、开机时长、CPU、内存、磁盘、占内存最多的进程、开机启动项、最近 24 小时的系统错误
$ErrorActionPreference = 'SilentlyContinue'
function Section($t) { Write-Output ''; Write-Output ('== ' + $t + ' ==') }
$os = Get-WmiObject Win32_OperatingSystem
$cs = Get-WmiObject Win32_ComputerSystem
Section '系统'
Write-Output ('{0} {1}（{2}）' -f $os.Caption, $os.Version, $os.OSArchitecture)
Write-Output ('电脑名：{0}　型号：{1} {2}' -f $env:COMPUTERNAME, $cs.Manufacturer, $cs.Model)
$boot = $os.ConvertToDateTime($os.LastBootUpTime)
$up = (Get-Date) - $boot
Write-Output ('上次开机：{0:yyyy-MM-dd HH:mm}（已连续运行 {1} 天 {2} 小时）' -f $boot, $up.Days, $up.Hours)
Section 'CPU'
Get-WmiObject Win32_Processor | ForEach-Object { Write-Output ('{0}，{1} 个逻辑核心，当前占用 {2}%' -f $_.Name.Trim(), $_.NumberOfLogicalProcessors, $_.LoadPercentage) }
Section '内存'
$total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$free = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$used = [math]::Round(100 - 100 * $os.FreePhysicalMemory / $os.TotalVisibleMemorySize)
Write-Output ('共 {0} GB，可用 {1} GB（已用 {2}%）' -f $total, $free, $used)
Section '磁盘'
Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $size = [math]::Round($_.Size / 1GB, 1)
  $freeG = [math]::Round($_.FreeSpace / 1GB, 1)
  $pct = 0
  if ($_.Size) { $pct = [math]::Round(100 * $_.FreeSpace / $_.Size) }
  $flag = ''
  if ($pct -lt 10) { $flag = '  <- 空间不足' }
  Write-Output ('{0} 共 {1} GB，剩余 {2} GB（{3}%）{4}' -f $_.DeviceID, $size, $freeG, $pct, $flag)
}
Section '占内存最多的 10 个进程'
Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10 | ForEach-Object {
  Write-Output ('{0,-30} {1,6} MB' -f $_.ProcessName, [math]::Round($_.WorkingSet / 1MB))
}
Section '开机启动项'
Get-WmiObject Win32_StartupCommand | ForEach-Object { Write-Output ('{0}：{1}' -f $_.Name, $_.Command) }
Section '最近 24 小时的系统错误（最多 15 条）'
$errs = Get-EventLog -LogName System -EntryType Error -After (Get-Date).AddDays(-1) -Newest 15
if (-not $errs) { Write-Output '没有' }
$errs | ForEach-Object {
  $m = ($_.Message -replace '\s+', ' ')
  if ($m.Length -gt 150) { $m = $m.Substring(0, 150) + '…' }
  Write-Output ('{0:MM-dd HH:mm} {1}：{2}' -f $_.TimeGenerated, $_.Source, $m)
}
`;

const HEALTH_SH = String.raw`#!/bin/bash
# 电脑体检（只读）：系统、开机时长、CPU、内存、磁盘、占内存最多的进程、开机启动项、失败的服务、最近 24 小时的系统错误
sec() { echo; echo "== $1 =="; }
sec 系统
grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"'
echo "内核：$(uname -r)（$(uname -m)）　电脑名：$(hostname)"
echo "已连续运行：$(uptime -p 2>/dev/null || uptime)"
sec CPU
model=$(grep -m1 -E 'model name|Model Name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')
[ -z "$model" ] && model=$(uname -m)
echo "$model，$(nproc) 个逻辑核心"
echo "负载（1 / 5 / 15 分钟）：$(cut -d' ' -f1-3 /proc/loadavg)"
sec 内存
free -h
sec 磁盘
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h
sec 占内存最多的 10 个进程
ps -eo comm,rss --sort=-rss | head -11 | awk 'NR==1{printf "%-30s %s\n","进程","内存(MB)";next}{printf "%-30s %d\n",$1,$2/1024}'
sec 开机启动项
ls /etc/xdg/autostart "$HOME/.config/autostart" 2>/dev/null
sec 失败的系统服务
systemctl --failed --no-legend 2>/dev/null | head -20
sec "最近 24 小时的系统错误（最多 15 条）"
journalctl -p err --since "24 hours ago" --no-pager -q 2>/dev/null | tail -15
`;

const HEALTH: BuiltinSkill = {
  key: 'pc-health',
  version: 1,
  name: '电脑体检',
  description: '检查电脑的系统、CPU、内存、磁盘空间、占内存多的程序、开机启动项和最近的系统错误，给出体检报告和建议。用户说「体检」「电脑卡」「看看电脑状态」时使用。',
  body: `# 电脑体检

## 步骤
1. 用 skill_run 运行体检脚本（只读取信息，不改任何东西）：Windows 运行 \`health.ps1\`，Linux / 银河麒麟运行 \`health.sh\`。timeout_sec 设为 120。
2. 根据输出写一份简短的中文体检报告，分「正常」「需要注意」两部分，每条一句话：
   - 磁盘剩余不到 10%：需要注意，建议用「清理磁盘空间」技能清理。
   - 内存已用超过 85%：列出占内存最多的程序。
   - 连续运行超过 7 天：建议找时间重启。
   - 开机启动项很多（超过 8 个）：列出可能不需要的（下载器、更新程序、聊天软件等），由用户决定。
   - 系统错误：只挑反复出现或看起来严重的（磁盘、蓝屏、驱动），说明大概意思，不要逐条翻译。
3. 不要自行关闭程序、删除启动项或改设置。用户确认要处理哪一项后再操作，需要管理员权限的命令设置 admin 为 true。

## 注意
- 同时体检多台电脑时，每台分别运行，报告里标明是哪台。
`,
  files: { 'health.ps1': BOM + HEALTH_PS1, 'health.sh': HEALTH_SH },
};

// ---------------- 清理磁盘空间 ----------------

const SCAN_PS1 = String.raw`# 清理磁盘空间：统计可以清理的地方占了多少空间（只读，不删除任何文件）
$ErrorActionPreference = 'SilentlyContinue'
function SizeOf($p) {
  if (-not (Test-Path -LiteralPath $p)) { return -1 }
  $s = (Get-ChildItem -LiteralPath $p -Recurse -Force | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
  if (-not $s) { $s = 0 }
  return $s
}
function Show($label, $p) {
  $s = SizeOf $p
  if ($s -lt 0) { return }
  Write-Output ('{0,-24} {1,9:N0} MB   {2}' -f $label, ($s / 1MB), $p)
}
Write-Output '== 各盘剩余空间 =='
Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  Write-Output ('{0} 剩余 {1:N1} GB / 共 {2:N1} GB' -f $_.DeviceID, ($_.FreeSpace / 1GB), ($_.Size / 1GB))
}
Write-Output ''
Write-Output '== 可以清理的地方 =='
$la = $env:LOCALAPPDATA
if (-not $la) { $la = Join-Path $env:USERPROFILE 'AppData\Local' }
Show '用户临时文件' $env:TEMP
Show '系统临时文件' (Join-Path $env:windir 'Temp')
Show 'Windows 更新下载缓存' (Join-Path $env:windir 'SoftwareDistribution\Download')
Show '回收站（C 盘）' 'C:\$Recycle.Bin'
Show 'Chrome 缓存' (Join-Path $la 'Google\Chrome\User Data\Default\Cache')
Show 'Edge 缓存' (Join-Path $la 'Microsoft\Edge\User Data\Default\Cache')
Show '360 浏览器缓存' (Join-Path $la '360Chrome\Chrome\User Data\Default\Cache')
Show '系统错误报告' (Join-Path $env:ProgramData 'Microsoft\Windows\WER')
Show '缩略图缓存' (Join-Path $la 'Microsoft\Windows\Explorer')
Write-Output ''
Write-Output '== 用户文件（不要自动删除，只给用户参考） =='
Show '下载' (Join-Path $env:USERPROFILE 'Downloads')
Show '微信文件' (Join-Path $env:USERPROFILE 'Documents\WeChat Files')
Show 'QQ 文件' (Join-Path $env:USERPROFILE 'Documents\Tencent Files')
Write-Output ''
Write-Output '== 用户文件夹里最大的 15 个文件（大于 200 MB，不含 AppData 等程序目录） =='
# 只看用户自己的文件夹：跳过隐藏目录、AppData、点开头的程序目录，以及「Local Settings」这类指向别处的连接点
Get-ChildItem -LiteralPath $env:USERPROFILE | Where-Object { $_.PSIsContainer -and $_.Name -ne 'AppData' -and -not $_.Name.StartsWith('.') -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
  ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Force } |
  Where-Object { -not $_.PSIsContainer -and $_.Length -gt 200MB } |
  Sort-Object Length -Descending | Select-Object -First 15 | ForEach-Object {
    Write-Output ('{0,9:N0} MB  {1:yyyy-MM-dd}  {2}' -f ($_.Length / 1MB), $_.LastWriteTime, $_.FullName)
  }
`;

const SCAN_SH = String.raw`#!/bin/bash
# 清理磁盘空间：统计可以清理的地方占了多少空间（只读，不删除任何文件）
show() { [ -e "$2" ] && printf '%-24s %8s   %s\n' "$1" "$(du -sh "$2" 2>/dev/null | cut -f1)" "$2"; }
echo "== 各分区剩余空间 =="
df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h
echo
echo "== 可以清理的地方 =="
show "用户缓存" "$HOME/.cache"
show "回收站" "$HOME/.local/share/Trash"
show "缩略图缓存" "$HOME/.cache/thumbnails"
show "临时文件 /tmp" /tmp
show "软件包缓存" /var/cache/apt/archives
echo "系统日志：$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]?B?' | head -1)"
echo
echo "== 用户文件（不要自动删除，只给用户参考） =="
show "下载" "$HOME/Downloads"
show "下载（中文目录）" "$HOME/下载"
echo
echo "== 用户文件夹里最大的 15 个文件（大于 200 MB，不含隐藏的程序目录） =="
find "$HOME" -xdev -path "$HOME/.*" -prune -o -type f -size +200M -printf '%s\t%TY-%Tm-%Td\t%p\n' 2>/dev/null | sort -rn | head -15 | awk -F'\t' '{printf "%8d MB  %s  %s\n",$1/1048576,$2,$3}'
`;

const CLEANUP: BuiltinSkill = {
  key: 'disk-cleanup',
  version: 1,
  name: '清理磁盘空间',
  description: '找出电脑上能清理的临时文件、缓存、回收站、大文件，列给用户选，确认后再清理。用户说「C 盘满了」「磁盘空间不足」「清理一下电脑」时使用。',
  body: `# 清理磁盘空间

## 步骤
1. 用 skill_run 运行统计脚本（只读）：Windows 运行 \`scan.ps1\`，Linux / 银河麒麟运行 \`scan.sh\`。文件多时较慢，timeout_sec 设为 300。
2. 把结果整理成清单给用户看：每项写大小和「能不能放心清理」。
   - 可以放心清理：临时文件、浏览器缓存、Windows 更新下载缓存、系统错误报告、缩略图缓存、软件包缓存、系统日志。
   - 要用户自己确认：回收站（清空后找不回）。
   - 只提示不清理：下载、微信 / QQ 文件、大文件。这些是用户自己的文件，只列出来，用户明确说删哪个文件才删。
   - 脚本只找用户文件夹里的大文件。满的是 D 盘等其他盘时，用 shell_exec 列出那个盘各个文件夹的大小，再找大文件给用户看。
3. 用选择卡片让用户勾选要清理的项目，确认后再执行下面的命令。执行完再运行一次统计脚本，告诉用户腾出了多少空间。

## 清理命令
Windows（用 shell_exec；正在使用的文件删不掉是正常的，忽略即可）：
- 用户临时文件：\`del /f /s /q "%TEMP%\\*" & for /d %i in ("%TEMP%\\*") do rd /s /q "%i"\`
- 系统临时文件（admin）：\`del /f /s /q "%windir%\\Temp\\*"\`
- Windows 更新下载缓存（admin）：\`net stop wuauserv & rd /s /q "%windir%\\SoftwareDistribution\\Download" & mkdir "%windir%\\SoftwareDistribution\\Download" & net start wuauserv\`
- 系统错误报告（admin）：\`rd /s /q "%ProgramData%\\Microsoft\\Windows\\WER\\ReportArchive" & rd /s /q "%ProgramData%\\Microsoft\\Windows\\WER\\ReportQueue"\`
- 浏览器缓存：先让用户关闭浏览器，再删除脚本列出的 Cache 目录（\`rd /s /q "目录"\`）。
- 回收站（admin）：Win10 / 11 用 \`powershell -NoProfile -Command "Clear-RecycleBin -Force"\`；Win7 用 \`rd /s /q C:\\$Recycle.Bin\`（其他盘同理）。

Linux / 银河麒麟：
- 用户缓存：\`rm -rf ~/.cache/thumbnails/* ~/.cache/*/Cache/*\`（不要整个删掉 ~/.cache，里面有程序的设置）
- 回收站：\`rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/*\`
- 软件包缓存（admin）：\`apt-get clean\`
- 系统日志（admin）：\`journalctl --vacuum-size=100M\`

## 注意
- 不要删除脚本没列出的系统目录，不要用磁盘清理之外的第三方工具。
- 删除前一定要用户确认，删除后告诉用户删了什么、腾出多少空间。
`,
  files: { 'scan.ps1': BOM + SCAN_PS1, 'scan.sh': SCAN_SH },
};

// ---------------- 网络故障排查 ----------------

const NET_PS1 = String.raw`# 网络故障排查（只读）：网卡和 IP、网关、DNS、能不能连通网关 / 外网、域名解析、代理设置、hosts
$ErrorActionPreference = 'SilentlyContinue'
function Ping1($h) {
  $p = New-Object System.Net.NetworkInformation.Ping
  try { $r = $p.Send($h, 2000); if ($r.Status -eq 'Success') { return ('通（' + $r.RoundtripTime + ' ms）') } else { return ('不通（' + $r.Status + '）') } } catch { return '不通' }
}
Write-Output '== 网卡 =='
$gws = @()
Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' | ForEach-Object {
  Write-Output ('{0}' -f $_.Description)
  Write-Output ('  IP：{0}　DHCP：{1}' -f ($_.IPAddress -join ', '), $_.DHCPEnabled)
  Write-Output ('  网关：{0}　DNS：{1}' -f ($_.DefaultIPGateway -join ', '), ($_.DNSServerSearchOrder -join ', '))
  if ($_.DefaultIPGateway) { $gws += $_.DefaultIPGateway[0] }
}
Get-WmiObject Win32_NetworkAdapter -Filter 'NetEnabled=FALSE AND PhysicalAdapter=TRUE' | ForEach-Object { Write-Output ('未连接的网卡：{0}' -f $_.NetConnectionID) }
Write-Output ''
Write-Output '== 连通性 =='
foreach ($g in $gws) { Write-Output ('网关 {0}：{1}' -f $g, (Ping1 $g)) }
Write-Output ('外网 223.5.5.5（阿里 DNS）：{0}' -f (Ping1 '223.5.5.5'))
Write-Output ('外网 114.114.114.114：{0}' -f (Ping1 '114.114.114.114'))
Write-Output ''
Write-Output '== 域名解析 =='
foreach ($d in @('www.baidu.com', 'www.qq.com')) {
  try { $ips = [System.Net.Dns]::GetHostAddresses($d) | ForEach-Object { $_.IPAddressToString }; Write-Output ('{0} -> {1}' -f $d, ($ips -join ', ')) } catch { Write-Output ('{0} 解析失败' -f $d) }
}
Write-Output ''
Write-Output '== 网页访问 =='
try {
  $wc = New-Object System.Net.WebClient
  $null = $wc.DownloadString('http://www.baidu.com')
  Write-Output '打开 http://www.baidu.com：成功'
} catch { Write-Output ('打开 http://www.baidu.com：失败（' + $_.Exception.Message + '）') }
Write-Output ''
Write-Output '== 代理设置 =='
$ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Write-Output ('系统代理：{0}　地址：{1}　自动配置脚本：{2}' -f $(if ($ie.ProxyEnable -eq 1) { '开' } else { '关' }), $ie.ProxyServer, $ie.AutoConfigURL)
Write-Output ''
Write-Output '== hosts 里的自定义记录 =='
Get-Content (Join-Path $env:windir 'System32\drivers\etc\hosts') | Where-Object { $_ -match '^\s*[^#\s]' }
`;

const NET_SH = String.raw`#!/bin/bash
# 网络故障排查（只读）：网卡和 IP、网关、DNS、能不能连通网关 / 外网、域名解析、代理设置、hosts
ping1() { if ping -c 1 -W 2 "$1" >/dev/null 2>&1; then echo "通"; else echo "不通"; fi; }
echo "== 网卡和 IP =="
ip -brief addr 2>/dev/null || ip addr
command -v nmcli >/dev/null && { echo; nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device 2>/dev/null; }
echo
gw=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
echo "== 连通性 =="
if [ -n "$gw" ]; then echo "网关 $gw：$(ping1 "$gw")"; else echo "没有默认网关"; fi
echo "外网 223.5.5.5（阿里 DNS）：$(ping1 223.5.5.5)"
echo "外网 114.114.114.114：$(ping1 114.114.114.114)"
echo
echo "== DNS =="
grep -E '^nameserver' /etc/resolv.conf 2>/dev/null
for d in www.baidu.com www.qq.com; do r=$(getent hosts "$d" | awk '{print $1}' | head -3 | tr '\n' ' '); [ -z "$r" ] && r="解析失败"; echo "$d -> $r"; done
echo
echo "== 网页访问 =="
if command -v curl >/dev/null; then curl -s -o /dev/null -m 8 -w "打开 http://www.baidu.com：HTTP %{http_code}\n" http://www.baidu.com || echo "打开 http://www.baidu.com：失败"; fi
echo
echo "== 代理设置 =="
env | grep -i '_proxy=' || echo "环境变量里没有代理"
command -v gsettings >/dev/null && echo "系统代理模式：$(gsettings get org.gnome.system.proxy mode 2>/dev/null)"
echo
echo "== hosts 里的自定义记录 =="
grep -vE '^\s*(#|$)' /etc/hosts
`;

const NETWORK: BuiltinSkill = {
  key: 'network-fix',
  version: 1,
  name: '网络故障排查',
  description: '排查电脑上不了网、网页打不开、能上 QQ 打不开网页等网络问题：检查网卡、IP、网关、DNS、代理，找出原因并修复。',
  body: `# 网络故障排查

## 步骤
1. 先问清楚这台电脑本来能不能上外网。很多单位的电脑只能上内网，外网不通是正常的，这时只排查内网（网关、内网网站）。
2. 用 skill_run 运行诊断脚本（只读）：Windows 运行 \`diagnose.ps1\`，Linux / 银河麒麟运行 \`diagnose.sh\`。timeout_sec 设为 90。
3. 按下面的顺序判断原因，告诉用户结论和打算怎么修，用户同意后再执行修复命令：
   - 没有 IP，或 IP 是 169.254 开头：没连上网线 / WiFi，或路由器没分配地址。检查网线和 WiFi，可以试试重新获取 IP。
   - 网关不通：网线、WiFi 或路由器的问题，电脑上能做的有限，请用户检查网线、重启路由器。
   - 网关通、223.5.5.5 不通：路由器连不上外网（宽带问题），或单位限制了外网。
   - 能 ping 通 223.5.5.5，但域名解析失败：DNS 有问题，刷新 DNS 缓存，或把 DNS 改成 223.5.5.5 / 114.114.114.114。
   - 解析正常、网页打不开：多半是代理设置（系统代理开着但代理软件没开）、hosts 被改，或安全软件拦截。
4. 修完再运行一次诊断脚本确认。

## 修复命令
Windows（shell_exec）：
- 重新获取 IP：\`ipconfig /release & ipconfig /renew\`
- 刷新 DNS 缓存：\`ipconfig /flushdns\`
- 关闭系统代理：\`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f\`
- 改 DNS（admin，「以太网」换成实际的网卡名）：\`netsh interface ip set dns name="以太网" static 223.5.5.5 & netsh interface ip add dns name="以太网" 114.114.114.114 index=2\`
- 重置网络（admin，要重启电脑才生效，最后才用）：\`netsh winsock reset & netsh int ip reset\`

Linux / 银河麒麟：
- 重启网络服务（admin）：\`systemctl restart NetworkManager\`
- 重新连接：\`nmcli device disconnect 网卡名; nmcli device connect 网卡名\`
- 改 DNS（admin）：\`nmcli connection modify "连接名" ipv4.dns "223.5.5.5 114.114.114.114" ipv4.ignore-auto-dns yes && nmcli connection up "连接名"\`

## 注意
- 手机是通过 WiFi 连着这台电脑时，重新获取 IP、断开网卡、重置网络都会让手机和电脑断开。先提醒用户，最好改用数据线连接再操作。
- 不要关闭防火墙或安全软件来「解决」问题。
`,
  files: { 'diagnose.ps1': BOM + NET_PS1, 'diagnose.sh': NET_SH },
};

// ---------------- 打印机故障处理 ----------------

const PRINT_PS1 = String.raw`# 打印机故障处理（只读）：打印机列表、默认打印机、状态、脱机、待打印的任务、打印服务状态
$ErrorActionPreference = 'SilentlyContinue'
Write-Output '== 打印服务 =='
$sp = Get-WmiObject Win32_Service -Filter "Name='Spooler'"
Write-Output ('Print Spooler：{0}（启动方式 {1}）' -f $sp.State, $sp.StartMode)
Write-Output ''
Write-Output '== 打印机 =='
Get-WmiObject Win32_Printer | ForEach-Object {
  $flags = @()
  if ($_.Default) { $flags += '默认' }
  if ($_.WorkOffline) { $flags += '脱机' }
  if ($_.Network) { $flags += '网络打印机' }
  Write-Output ('{0}　[{1}]　状态码 {2}　端口 {3}　驱动 {4}' -f $_.Name, ($flags -join '、'), $_.PrinterStatus, $_.PortName, $_.DriverName)
}
Write-Output '（状态码：3 空闲、4 正在打印、5 预热、7 脱机；其他值表示有错误）'
Write-Output ''
Write-Output '== 等待打印的任务 =='
$jobs = Get-WmiObject Win32_PrintJob
if (-not $jobs) { Write-Output '没有' }
$jobs | ForEach-Object { Write-Output ('{0}　文档：{1}　状态：{2}　页数：{3}' -f $_.Name, $_.Document, $_.JobStatus, $_.TotalPages) }
Write-Output ''
Write-Output '== 最近的打印错误（最多 10 条） =='
Get-EventLog -LogName System -Source 'Microsoft-Windows-PrintSpooler' -EntryType Error -Newest 10 | ForEach-Object {
  $m = ($_.Message -replace '\s+', ' ')
  if ($m.Length -gt 150) { $m = $m.Substring(0, 150) + '…' }
  Write-Output ('{0:MM-dd HH:mm} {1}' -f $_.TimeGenerated, $m)
}
`;

const PRINT_SH = String.raw`#!/bin/bash
# 打印机故障处理（只读）：打印服务状态、打印机列表、默认打印机、等待打印的任务
echo "== 打印服务（CUPS） =="
systemctl is-active cups 2>/dev/null || echo "没有找到 cups 服务"
echo
echo "== 打印机 =="
lpstat -p -d 2>&1
echo
echo "== 打印机连接方式 =="
lpstat -v 2>&1
echo
echo "== 等待打印的任务 =="
lpstat -o 2>&1 | head -30
echo
echo "== 最近的打印错误 =="
journalctl -u cups --since "3 days ago" -p warning --no-pager -q 2>/dev/null | tail -10
`;

const PRINTER: BuiltinSkill = {
  key: 'printer-fix',
  version: 1,
  name: '打印机故障处理',
  description: '处理打印机打印不出来、一直排队、显示脱机、默认打印机不对等问题：检查打印机和打印任务，清空卡住的队列、重启打印服务。',
  body: `# 打印机故障处理

## 步骤
1. 用 skill_run 运行检查脚本（只读）：Windows 运行 \`printers.ps1\`，Linux / 银河麒麟运行 \`printers.sh\`。
2. 根据结果判断，告诉用户原因和打算怎么做，同意后再执行：
   - 打印服务没在运行：启动打印服务。
   - 队列里有卡住的任务（状态是错误、一直不动）：清空队列并重启打印服务。
   - 打印机显示脱机：网络打印机先请用户确认打印机开着、和电脑在同一个网络；USB 打印机请用户检查数据线和电源。然后取消「脱机使用」。
   - 用户打印的不是想要的那台：改默认打印机。
   - 驱动有问题、打印乱码：说明需要重新安装打印机驱动，请用户提供打印机型号，不要自己去网上下载驱动安装。
3. 处理完后可以打印一张测试页，请用户看看打印机有没有出纸。

## 命令
Windows（shell_exec）：
- 启动打印服务（admin）：\`net start spooler\`
- 清空卡住的队列并重启打印服务（admin）：\`net stop spooler & del /q /f /s "%windir%\\System32\\spool\\PRINTERS\\*" & net start spooler\`
- 取消脱机（把「打印机名」换成实际名称）：\`powershell -NoProfile -Command "$p = Get-WmiObject Win32_Printer -Filter \\"Name='打印机名'\\"; $p.WorkOffline = $false; $p.Put()"\`
- 设为默认打印机：\`powershell -NoProfile -Command "(Get-WmiObject Win32_Printer -Filter \\"Name='打印机名'\\").SetDefaultPrinter()"\`
- 打印测试页：\`rundll32 printui.dll,PrintUIEntry /k /n "打印机名"\`
- 打开打印机设置窗口：\`start "" control printers\`

Linux / 银河麒麟：
- 重启打印服务（admin）：\`systemctl restart cups\`
- 清空所有打印任务：\`cancel -a\`
- 打印机被停用时重新启用（admin）：\`cupsenable 打印机名 && cupsaccept 打印机名\`
- 设为默认打印机：\`lpoptions -d 打印机名\`
- 打印测试页：\`lp -d 打印机名 /usr/share/cups/data/testprint\`

## 注意
- 打印机名里有空格或中文时要加引号。
- 共享打印机连不上时，先确认共享它的那台电脑开着。
`,
  files: { 'printers.ps1': BOM + PRINT_PS1, 'printers.sh': PRINT_SH },
};

export const BUILTIN_SKILLS: BuiltinSkill[] = [HEALTH, CLEANUP, NETWORK, PRINTER];

export const BUILTIN_MCPS: BuiltinMcp[] = [
  {
    // 微软官方文档（Windows、Office、PowerShell 等）：免费、不用登录。https://learn.microsoft.com/en-us/training/support/mcp
    key: 'ms-learn',
    version: 1,
    draft: {
      name: '微软文档',
      kind: 'remote',
      url: 'https://learn.microsoft.com/api/mcp',
      transport: 'http',
      headers: {},
      env: {},
    },
  },
];

/** 内置 Skill 的 SKILL.md 全文 */
export function builtinSkillMd(s: BuiltinSkill): string {
  return buildSkillMd(s.name, s.description, s.body);
}
