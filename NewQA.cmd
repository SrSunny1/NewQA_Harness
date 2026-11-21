@echo off
setlocal
set PORT=4173
set CHK=powershell -NoProfile -Command "try { (New-Object System.Net.Sockets.TcpClient('127.0.0.1', %PORT%)).Close(); exit 0 } catch { exit 1 }"
%CHK%
if %errorlevel%==0 goto :open
start /min "NewQA Server" wsl.exe bash -lc "cd /mnt/e/vibecoding/NewQA && npm start"
set /a tries=0
:wait
%CHK%
if %errorlevel%==0 goto :open
set /a tries+=1
if %tries% GEQ 30 goto :fail
timeout /t 1 /nobreak >nul
goto :wait
:open
start "" http://127.0.0.1:%PORT%/
goto :eof
:fail
echo NewQA 30 秒内未就绪，请查看 NewQA Server 窗口里的日志
pause
