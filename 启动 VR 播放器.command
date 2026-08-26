#!/bin/bash
# 双击启动本地 VR 播放器，并在默认浏览器中打开
cd "$(dirname "$0")"
if ! lsof -ti :7100 >/dev/null 2>&1; then
  node server.js --port 7100 > /dev/null 2>&1 &
  sleep 1
fi
open "http://localhost:7100/"
