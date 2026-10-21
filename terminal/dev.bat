@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
set VWI_TERMINAL_ROOT=

rem 开发调试：不 kiosk、不置顶、允许 DevTools，窗口可以随便关
"node_modules\electron\dist\electron.exe" . --dev
pause
