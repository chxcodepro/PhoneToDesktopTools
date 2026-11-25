; p2d 安装程序的额外步骤（electron-builder 的 nsis.include）。
; 1. 覆盖安装 / 卸载前，除了主程序，还要结束它带的电脑端服务（p2d-core.exe），以及旧版本带的 adb 后台服务：
;    主程序被强制结束时服务进程会留下来，adb 后台服务本来就常驻，它们占着安装目录里的文件，覆盖时会失败。
;    新版本不再带 adb（电脑端自己经 USB 连接手机），从旧版本升级时才会遇到。
;    adb 只结束从安装目录启动的那个，不动用户自己（Android Studio 等）的 adb。
; 2. 卸载时去掉开机自启（升级时的卸载不去掉，新版本启动后会重新登记）。

!macro p2dStopHelpers
  ; 改名前的主程序叫 PhoneToDesktop.exe，从旧版本升级时默认的检查按新名字 p2d.exe 找不到它
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM PhoneToDesktop.exe`
  Pop $0
  ; 64 位系统上 32 位安装程序读不到 64 位进程的路径，所以服务程序直接按名字结束（只有本程序有这个名字）
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM p2d-core.exe`
  Pop $0
  ; Win7 自带 PowerShell 2.0 也支持 Get-Process 的 Path
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process adb -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | Stop-Process -Force"`
  Pop $0
  Sleep 300
!macroend

; 沿用 electron-builder 默认的「程序正在运行」检查（提示后结束主程序），再结束服务和 adb
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro p2dStopHelpers
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 开机自启的 Run 项（见 src/electron/autostart.ts），连同改名前的 PhoneToDesktop 一起删
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "p2d"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PhoneToDesktop"
  ${endIf}
!macroend
