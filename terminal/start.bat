@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 沙箱/CI 环境可能带着这个变量，会让 Electron 退化成纯 Node 而不开窗口
set ELECTRON_RUN_AS_NODE=
set VWI_TERMINAL_ROOT=

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   缺少 Electron 运行时。
  echo   请先在当前目录执行：  npm install
  echo.
  pause
  exit /b 1
)

echo 正在启动终端（kiosk 全屏）……
echo 维护退出：Ctrl+Alt+Shift+Q
echo.
"node_modules\electron\dist\electron.exe" .
if errorlevel 1 (
  echo.
  echo 启动失败，退出码 %errorlevel%
  pause
)
