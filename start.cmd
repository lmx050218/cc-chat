@echo off
chcp 65001 >nul
title cc-chat Agent

REM ── 配置 ──────────────────────────────────────────
set CC_TOKEN=test123
set CC_RELAY=ws://localhost:17389/ws
set CC_CMD=claude

echo.
echo ╔══════════════════════════════════════════╗
echo ║         cc-chat Agent                    ║
echo ║  本机中继: %CC_RELAY%    ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0agent"
node agent.js
pause
