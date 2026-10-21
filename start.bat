@echo off
chcp 65001 >nul
title 在线 VWI 发布系统
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。请先安装 Node.js 22.5 或更高版本。
  echo   下载：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node server.js %*
pause
