@echo off
title SAE INDIA Local Connector Agent
echo ========================================================
echo  SAE INDIA ADDC 2026 - Local Connector Agent
echo  Bridging ESP32 (LAN: 192.168.31.194:8080) to Cloud Relay
echo ========================================================
cd /d "%~dp0local-connector"
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)
echo Starting Local Connector...
node connector.js
pause

