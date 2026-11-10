# -*- coding: utf-8 -*-
"""生成「放行端口.bat」（GBK + CRLF）。

为什么要单独一个生成脚本：bat 里必须带中文，而 cmd 默认代码页是 936，
用 UTF-8 写会乱码；同时又要保证换行是 CRLF。手工改容易坏，脚本生成可重复。

四个入口：
  双击（无参数）  体检 → 缺规则就提权补上 → 复查
  /check 或 check 只体检（不需要管理员，现场可以先跑这个）
  /add    只添加规则（提权后由脚本自己调用）
  /remove 删除规则

体检的核心不是"能不能连上"——那在本机永远成立（回环不走防火墙），
而是"程序在不在听、绑在哪个地址、防火墙放没放、本机有哪些地址可填"。
"""
import pathlib
import sys

BAT = r'''@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
title ESOP 服务端 - 端口体检 / 放行
set RULE=ESOP Server - TCP 8092
set PORT=8092

if /i "%~1"=="/check"  goto :check
if /i "%~1"=="check"   goto :check
if /i "%~1"=="/remove" goto :remove
if /i "%~1"=="remove"  goto :remove
if /i "%~1"=="/add"    goto :add
if /i "%~1"=="add"     goto :add

rem ============================================================
rem  双击：先体检，缺规则再提权补
rem ============================================================
call :probe
if "!BAD!"=="0" goto :allgood
echo.
echo ------------------------------------------------------------
echo 上面有问题项。现在请求管理员权限来补规则，弹窗请点"是"。
echo ------------------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '/add' -Verb RunAs"
  echo.
  echo 已弹出权限窗口。点"取消"则规则不会添加。
  pause
  exit /b 1
)
goto :add_do

rem ============================================================
:check
call :probe
echo.
if "!BAD!"=="0" (
  echo [体检通过] 本机侧没发现问题。
  echo             但"本机能连"不等于"屏能连"，请按上面的办法换台机器确认。
  exit /b 0
)
echo [体检未通过] 见上面的问题项。
exit /b 2

rem ============================================================
:add
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '/add' -Verb RunAs"
  exit /b
)

:add_do
echo ============================================================
echo   添加防火墙规则：%RULE%
echo ============================================================
echo.
rem 先删同名旧规则，避免重复叠加（不存在时报错忽略）
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=any enable=yes description="ESOP 发布系统服务端，局域网终端连 8092"
if errorlevel 1 goto :fail
echo [完成] 规则已添加，覆盖 域 / 专用 / 公用 三种网络位置。
echo.
call :probe
echo.
echo ------------------------------------------------------------
echo 接下来必须换一台机器验证，别在本机测：
echo   1. 在屏上打开设置页点"检测"  -- 最真实，和播片同一条路
echo   2. 或在另一台电脑浏览器打开 http://上面列出的地址:8092/
echo ------------------------------------------------------------
echo.
pause
exit /b 0

rem ============================================================
:remove
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '/remove' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="%RULE%"
echo [已删除] %RULE%
echo 注意：删掉之后屏就连不上服务端了，除非本来就没开防火墙。
pause
exit /b 0

rem ============================================================
rem  体检子过程
rem ============================================================
:probe
set "BAD=0"
set "LADDR="
set "LPID="
set "PNAME="
set "ANYIP="
echo ============================================================
echo   ESOP 服务端 - 端口体检（本机侧）
echo   %date% %time%
echo ============================================================
echo.

echo [1] 谁在监听 %PORT%
for /f "tokens=2,5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  if not defined LADDR (
    set "LADDR=%%a"
    set "LPID=%%b"
  )
)
if not defined LADDR (
  echo     没人在监听。
  echo     服务端 ESOP-Server.exe 还没启动，先把服务端开起来再跑一次。
  set "BAD=1"
) else (
  for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq !LPID!" /FO CSV /NH 2^>nul ^| findstr /i ".exe"') do set "PNAME=%%~n"
  if not defined PNAME set "PNAME=查不到进程名"
  rem 进程名若带括号，同样会在 for/if 块里截断输出，先剔掉
  set "PNAME=!PNAME:)=!"
  set "PNAME=!PNAME:(=!"
  echo     监听地址：!LADDR!
  echo     监听进程：!PNAME!   PID !LPID!
  if "!LADDR:~0,10!"=="127.0.0.1:" (
    echo     [问题] 只绑定了回环地址，别的机器永远连不上。
    echo            这跟防火墙无关，是服务端监听配置的问题。
    set "BAD=1"
  ) else (
    echo     绑定在全部网卡上，正常。
  )
)
echo.

echo [2] 防火墙规则
rem 规则详情用 PowerShell 取：Action / Profile / Enabled 是英文常量，
rem 不受系统语言和代码页影响。netsh 的中文输出在不同环境下编码不一致，
rem 按中文过滤会时灵时不灵。
powershell -NoProfile -Command "$r = Get-NetFirewallRule -DisplayName '%RULE%' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($r) { 'Enabled=' + $r.Enabled + '   Action=' + $r.Action + '   Profile=' + $r.Profile }" > "%TEMP%\esop_r.txt" 2>nul
call :ruleexists
if errorlevel 1 (
  echo     规则不存在 —— 局域网访问会被拦。
  set "BAD=1"
) else (
  echo     规则存在：
  for /f "usebackq delims=" %%a in ("%TEMP%\esop_r.txt") do echo          %%a
)
echo.

echo [3] 防火墙总开关（三个网络位置）
powershell -NoProfile -Command "Get-NetFirewallProfile | ForEach-Object { '{0}|{1}' -f $_.Name, $_.Enabled }" > "%TEMP%\esop_fw.txt" 2>nul
set "FWSEEN="
for /f "tokens=1,2 delims=|" %%a in ('type "%TEMP%\esop_fw.txt" 2^>nul') do (
  set "PN=%%a"
  set "PV=%%b"
  if /i "%%a"=="Domain"  set "PN=域网络"
  if /i "%%a"=="Private" set "PN=专用网络"
  if /i "%%a"=="Public"  set "PN=公用网络"
  if /i "%%b"=="True"    set "PV=启用，会拦"
  if /i "%%b"=="False"   set "PV=关闭，不拦"
  echo      !PN!：!PV!
  set "FWSEEN=1"
)
if not defined FWSEEN echo      没取到状态，命令行执行 netsh advfirewall show allprofiles state 看。
echo.

echo [4] 本机地址 —— 在别的机器 / 屏上填这个
echo     要和屏在同一网段的那个；名字带「虚拟」的不要用。
rem 网卡名里的圆括号必须在这里就去掉：bat 的 for 块内 echo 展开出的
rem ASCII 右括号会被 cmd 当成块结束符，输出直接截断。
powershell -NoProfile -Command "$l = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $a = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; $n = '未知网卡'; if ($a) { $n = $a.Name -replace '[()]', '' }; $b = 0; if ($n -match 'VMware|VirtualBox|vEthernet|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|Bluetooth|Npcap') { $b = 1 }; '{0}|{1}|{2}' -f $_.IPAddress, $n, $b }; $l | Where-Object { $_ -like '*|0' } | ForEach-Object { $_ }; $l | Where-Object { $_ -like '*|1' } | ForEach-Object { $_ }" > "%TEMP%\esop_ip.txt" 2>nul
set "SEEN="
for /f "tokens=1,2,3 delims=|" %%a in ('type "%TEMP%\esop_ip.txt" 2^>nul') do (
  if "%%c"=="0" (
    if not defined ANYIP set "ANYIP=%%a"
    echo      http://%%a:8092/      %%b
  ) else (
    echo      http://%%a:8092/      %%b   【虚拟网卡，别用】
  )
  set "SEEN=1"
)
if not defined SEEN (
  echo      没取到地址，手工看：命令行执行 ipconfig，找 IPv4 地址那一行。
  set "BAD=1"
)
echo.

echo ============================================================
echo   注意：上面查的全是本机。本机怎么测都是通的！
echo ============================================================
echo   即使防火墙一条规则都没有，在服务端这台机器上：
echo       浏览器开 http://127.0.0.1:8092/       一定成功
echo       浏览器开 http://本机局域网 IP:8092/    也一定成功
echo   因为本机发起的连接走机器内部回环，防火墙根本不检查。
echo   所以"本机能打开"完全不能证明屏能连上。
echo.
echo   真正确认只有一个办法：换一台机器发起连接。
if defined ANYIP (
  echo     屏上：打开设置页点"检测"    最真实，和播片走同一条路
  echo     电脑：浏览器开 http://!ANYIP!:8092/
  echo     电脑：powershell Test-NetConnection !ANYIP! -Port 8092
  echo           看 TcpTestSucceeded : True 就是通了
) else (
  echo     先在另一台机器用浏览器开 http://服务端IP:8092/
)
echo.
goto :eof

:ruleexists
netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
exit /b %errorlevel%

:allgood
echo.
echo ------------------------------------------------------------
echo 本机侧看着都正常，不用改什么。
echo 要确认屏真的能连，还是得换一台机器验证：
if defined ANYIP (
  echo     屏上设置页点"检测"，或在另一台电脑开 http://!ANYIP!:8092/
) else (
  echo     屏上设置页点"检测"
)
echo ------------------------------------------------------------
echo.
pause
exit /b 0

:fail
echo.
echo [失败] 规则没加上。可能是安全软件拦了 netsh，或被公司组策略锁住。
echo.
echo 手工办法：
echo   控制面板 - Windows Defender 防火墙 - 高级设置 - 入站规则 - 新建规则
echo   端口 - TCP - 特定本地端口 8092 - 允许连接 - 域/专用/公用 全勾上
echo.
pause
exit /b 1
'''


def main():
    targets = [pathlib.Path("tools/放行端口.bat")]
    if len(sys.argv) > 1:
        targets.append(pathlib.Path(sys.argv[1]) / "放行端口.bat")
    for t in targets:
        t.parent.mkdir(parents=True, exist_ok=True)
        data = BAT.replace("\n", "\r\n").encode("gbk")
        t.write_bytes(data)
        print("写入 %s  %d 字节" % (t, len(data)))


if __name__ == "__main__":
    main()
