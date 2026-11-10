@echo off
chcp 936 >nul
setlocal
title ESOP 服务端 - 放行 8092 端口
set RULE=ESOP Server - TCP 8092

if /i "%~1"=="/check"  goto :check
if /i "%~1"=="check"   goto :check
if /i "%~1"=="/remove" goto :remove
if /i "%~1"=="remove"  goto :remove

rem ================= 提权 =================
rem 走到这里就是「双击、不带参数」的正常用法。带了 /check /remove 的
rem 已在上面分派走，各自管自己的提权，这里不要再传 %~1（传空会多出一个空参数）。
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限，正在弹窗请求，请点"是"...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo   ESOP 服务端 - 放行 TCP 8092 入站
echo ============================================================
echo.
echo 这条规则让局域网里的屏能连上本机服务端。
echo 同时覆盖「域 / 专用 / 公用」三种网络位置，插到别的网段也不会失效。
echo.

rem 先删同名旧规则，避免重复叠加（不存在时报错忽略）
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1

netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=8092 profile=any enable=yes description="ESOP 发布系统服务端，局域网终端连 8092"
if errorlevel 1 goto :fail

echo [完成] 规则已添加：%RULE%
echo.
echo 下一步：
echo   1. 回到服务端窗口，看「局域网访问」那几行，里面就是终端要填的地址
echo   2. 在另一台机器上打开 http://服务端IP:8092/ 能出页面，就说明通了
echo   3. 屏上填的地址就是那行，不要填 127.0.0.1
echo.
echo 以后想撤掉这条规则：右键本文件 - 以管理员身份运行，参数加 /remove
echo.
pause
exit /b 0

:check
netsh advfirewall firewall show rule name="%RULE%" >nul 2>&1
if errorlevel 1 (
  echo [未放行] 没找到规则：%RULE%
  echo          屏会连不上服务端（表现为一直"连接中"或提示检查防火墙）
  exit /b 2
)
echo [已放行] 规则存在：%RULE%
exit /b 0

:remove
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '/remove' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="%RULE%"
echo [已删除] %RULE%
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
