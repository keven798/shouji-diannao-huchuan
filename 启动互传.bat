@echo off
chcp 65001 >nul
title 手机-电脑局域网互传
cd /d %~dp0
echo ==============================================
echo   启动中... 关闭本窗口即停止服务
echo   本机访问:   http://localhost:5210/
echo   手机访问:   http://192.168.1.2:5210/  (需同一 WiFi)
echo   电脑端页面: http://localhost:5210/pc
echo ==============================================
"C:\Users\shihan.li\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" server.js
pause
