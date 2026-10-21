@echo off
chcp 936 >nul
title VWI-SERVER-8092
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。请先安装 Node.js 22.5 或更高版本。
  echo   下载：https://nodejs.org/
  echo.
  echo   不想装 Node 的话，直接用 release 目录里的绿色免安装包：
  echo     release\online-vwi-server-1.4.0-win-x64.zip
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":8092" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   端口 8092 已被占用，服务可能已经在运行（重复启动会开两个服务）。
  echo.
  pause
  exit /b 0
)

echo.
echo   ============================================================
echo     在线 VWI 发布系统 · 服务端（源码运行）
echo   ============================================================
echo     启动完成后，下方会列出「局域网访问」地址，
echo       把它填到 5 台终端的装机向导里。
echo.
echo   ------------------------------------------------------------
echo.

chcp 65001 >nul
node --no-warnings server.js %*
chcp 936 >nul

echo.
echo   ------------------------------------------------------------
echo   服务已停止。若上方有红字报错，请截图给维护人员。
echo.
pause
