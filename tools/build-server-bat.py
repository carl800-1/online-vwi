#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成服务端绿色免安装包里的 Windows 批处理脚本。

为什么要有两套（中文 GBK / 英文 ASCII）：
  cmd.exe 读取 .bat 时，是用当前 OEM 代码页把整个文件一次性解码的，
  之后 chcp 不会再改变已读内容。
  - 存 UTF-8  -> cmd 按 936 解读，中文变成乱码字节，其中 0x5C 会被当成
                  反斜杠，直接把命令拆坏（实测报 'TENING" 不是内部命令'）。
  - 加 UTF-8 BOM -> cmd 不认，会把 BOM 当成命令的一部分
                  （实测报 ''@echo' 不是内部或外部命令'，且 @echo off 失效）。
  - 存 GBK    -> 中文 Windows（936）上完全正确，命令结构不被破坏。
因此中文版存 GBK，并且必须在 chcp 前后分段输出：
  chcp 936 段   -> bat 自己的中文提示（GBK 正确显示）
  chcp 6501 段  -> node 的 stdout（node 永远输出 UTF-8 字节）
英文版全部用 ASCII，任何代码页下都不会被拆坏，作为非中文 Windows 的兜底。

用法：python tools/build-server-bat.py <包目录>
"""
import pathlib
import sys

CN = {
    "start": """@echo off
chcp 936 >nul
title VWI-SERVER-8092
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo.
  echo   [错误] 缺少 runtime\\node.exe，安装包不完整。
  echo   请重新完整解压压缩包，不要单独从压缩包里拖文件出来。
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":8092" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   服务已经在运行了（端口 8092 已被占用）。
  echo   如需重启，请先运行「停止服务端.bat」。
  echo.
  pause
  exit /b 0
)

echo.
echo   ============================================================
echo     在线 VWI 发布系统 · 服务端
echo   ============================================================
echo     正在启动。首次启动会自动生成空的内容库，需要几秒。
echo.
echo     * 启动完成后，下方会列出「局域网访问」地址，
echo       把它填到 5 台终端的装机向导里。
echo     * 不要关闭本窗口，关掉就等于停服，终端会离线。
echo     * 停止服务：运行「停止服务端.bat」，或直接关掉本窗口。
echo.
echo   ------------------------------------------------------------
echo.

chcp 65001 >nul
"runtime\\node.exe" --no-warnings server.js %*
chcp 936 >nul

echo.
echo   ------------------------------------------------------------
echo   服务已停止。若上方有红字报错，请截图给维护人员。
echo.
pause
""",
    "stop": """@echo off
chcp 936 >nul
cd /d "%~dp0"

echo.
echo   正在停止 在线 VWI 服务端…

taskkill /FI "WINDOWTITLE eq VWI-SERVER-8092" /T /F >nul 2>&1
if errorlevel 1 (
  echo   没有找到正在运行的服务端窗口（可能已经停了）。
  echo   若端口仍在监听，请打开任务管理器，结束 node.exe 进程。
) else (
  echo   已停止。
)

echo.
netstat -ano | findstr ":8092" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [注意] 端口 8092 仍在监听，说明还有 node.exe 在跑。
  echo   请打开任务管理器，结束 node.exe 进程后再试。
) else (
  echo   端口 8092 已释放，终端将无法连接。
)
echo.
pause
""",
    "autostart-on": """@echo off
chcp 936 >nul
cd /d "%~dp0"

echo.
echo   正在设置开机自启（只影响当前用户，不需要管理员密码）…
echo.

cscript //nologo //E:vbscript "tools\\add-autostart.vbs" "%~dp0" "启动服务端.bat" "在线VWI服务端.lnk"
if errorlevel 1 (
  echo.
  echo   [失败] 没能创建自启快捷方式，请把上面的英文报错截图给维护人员。
) else (
  echo.
  echo   已设置。下次登录 Windows 会自动启动服务端，窗口最小化在任务栏。
  echo   取消请运行「取消开机自启.bat」。
)

echo.
pause
""",
    "autostart-off": """@echo off
chcp 936 >nul
cd /d "%~dp0"

echo.
echo   正在取消开机自启…

cscript //nologo //E:vbscript "tools\\remove-autostart.vbs" "在线VWI服务端.lnk"
if errorlevel 1 (
  echo.
  echo   [失败] 没能删除自启快捷方式，请手动到「启动」文件夹删除：
  echo          %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
) else (
  echo   已取消开机自启。
)

echo.
pause
""",
}

EN = {
    "start": """@echo off
chcp 65001 >nul
title VWI-SERVER-8092
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo.
  echo   [ERROR] runtime\\node.exe is missing - the package is incomplete.
  echo   Extract the whole archive again. Do not copy single files out.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr ":8092" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo   The server is already running (port 8092 is in use).
  echo   Run stop-server.bat first if you need to restart it.
  echo.
  pause
  exit /b 0
)

echo.
echo   ============================================================
echo     Online VWI Publisher - Server
echo   ============================================================
echo     Starting up. On the first run an empty catalog is created.
echo.
echo     * When the LAN address appears below, fill that address into
echo       the setup wizard of each of the 5 terminals.
echo     * Do not close this window. Closing it stops the server.
echo     * To stop: run stop-server.bat, or close this window.
echo.
echo   ------------------------------------------------------------
echo.

"runtime\\node.exe" --no-warnings server.js %*

echo.
echo   ------------------------------------------------------------
echo   Server stopped. Screenshot any red error above and send it.
echo.
pause
""",
    "stop": """@echo off
cd /d "%~dp0"

echo.
echo   Stopping Online VWI Publisher - Server...

taskkill /FI "WINDOWTITLE eq VWI-SERVER-8092" /T /F >nul 2>&1
if errorlevel 1 (
  echo   No running server window was found (it may already be stopped).
  echo   If the port is still listening, open Task Manager and end node.exe.
) else (
  echo   Stopped.
)

echo.
netstat -ano | findstr ":8092" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   [WARN] Port 8092 is still listening - another node.exe is running.
  echo   Open Task Manager and end node.exe, then try again.
) else (
  echo   Port 8092 is released. Terminals cannot connect right now.
)
echo.
pause
""",
    "autostart-on": """@echo off
cd /d "%~dp0"

echo.
echo   Enabling start-at-login (current user only, no admin rights)...
echo.

cscript //nologo //E:vbscript "tools\\add-autostart.vbs" "%~dp0" "start-server.bat" "Online VWI Server.lnk"
if errorlevel 1 (
  echo.
  echo   [FAILED] Could not create the shortcut. Screenshot the error above.
) else (
  echo.
  echo   Enabled. The server will start automatically at the next logon.
  echo   Run disable-autostart.bat to turn it off.
)

echo.
pause
""",
    "autostart-off": """@echo off
cd /d "%~dp0"

echo.
echo   Disabling start-at-login...

cscript //nologo //E:vbscript "tools\\remove-autostart.vbs" "Online VWI Server.lnk"
if errorlevel 1 (
  echo.
  echo   [FAILED] Could not delete the shortcut. Remove it manually from
  echo   %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
) else (
  echo   Start-at-login is now off.
)

echo.
pause
""",
}

CN_NAME = {
    "start": "启动服务端.bat",
    "stop": "停止服务端.bat",
    "autostart-on": "设置开机自启.bat",
    "autostart-off": "取消开机自启.bat",
}

EN_NAME = {
    "start": "start-server.bat",
    "stop": "stop-server.bat",
    "autostart-on": "enable-autostart.bat",
    "autostart-off": "disable-autostart.bat",
}


def write(path: pathlib.Path, text: str, encoding: str):
    data = text.replace("\r\n", "\n").replace("\n", "\r\n").encode(encoding)
    path.write_bytes(data)
    print(f"  {path.name:28s} {encoding:6s} {len(data):6d} bytes")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    pkg = pathlib.Path(sys.argv[1]).resolve()
    print(f"生成批处理脚本 -> {pkg}")
    for key, name in CN_NAME.items():
        write(pkg / name, CN[key], "gbk")
    for key, name in EN_NAME.items():
        write(pkg / name, EN[key], "ascii")
    print("完成。")


if __name__ == "__main__":
    main()
