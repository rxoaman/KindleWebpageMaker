#!/data/data/com.termux/files/usr/bin/bash

echo "======================================================"
echo "🚀 Starting KindleWebpageMaker on Android"
echo "======================================================"

PORT=${PORT:-3001}

echo "Starting server on port $PORT..."
echo ""
echo "📱 Open your phone's browser (Chrome/Firefox) and visit:"
echo "   http://localhost:$PORT"
echo ""
echo "Press Ctrl+C to stop the server when done."
echo "======================================================"

# Automatically open browser if termux-open-url or Android am is available
(
  sleep 2
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "http://localhost:$PORT"
  elif command -v am >/dev/null 2>&1; then
    am start -a android.intent.action.VIEW -d "http://localhost:$PORT" >/dev/null 2>&1
  fi
) &

node backend/src/server.js
