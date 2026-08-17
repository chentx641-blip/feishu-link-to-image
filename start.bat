@echo off
setlocal
cd /d "%~dp0"

REM ===== 访问口令：改这一行即可（改完保存，重新运行本脚本生效）=====
set FLC_ACCESS_CODE=gdq65ok8

REM 托管 Node 完整路径（避免系统 PATH 里没有 node）
set NODE_EXE=C:\Users\小绵羊\.workbuddy\binaries\node\versions\22.22.2\node.exe

echo 正在启动「飞书图片链接转图片」服务...
start "FLC-Server" cmd /k "%NODE_EXE% server.js"
start "FLC-Tunnel" cmd /k "tools\cloudflared.exe tunnel --url http://localhost:8787 --no-autoupdate"

echo.
echo 访问口令: %FLC_ACCESS_CODE%
echo 本机地址: http://localhost:8787
echo 隧道窗口会显示公网地址（好友用的那个）。
echo 关闭时：直接关掉弹出的两个命令行窗口即可。
echo.
pause
