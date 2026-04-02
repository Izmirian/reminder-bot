#!/bin/bash
# Helper script to manage Telegram + WhatsApp reminder bots

TELEGRAM_LABEL="com.varant.telegram-bot"
WHATSAPP_LABEL="com.varant.whatsapp-bot"
TELEGRAM_PLIST="$HOME/Library/LaunchAgents/$TELEGRAM_LABEL.plist"
WHATSAPP_PLIST="$HOME/Library/LaunchAgents/$WHATSAPP_LABEL.plist"
LOG_DIR="$HOME/Documents/Whatsapp Bot/logs"

case "$1" in
  start)
    echo "Starting bots..."
    launchctl load "$TELEGRAM_PLIST" 2>/dev/null
    launchctl load "$WHATSAPP_PLIST" 2>/dev/null
    echo "Both bots started. Check status with: ./scripts/bots.sh status"
    ;;

  stop)
    echo "Stopping bots..."
    launchctl unload "$TELEGRAM_PLIST" 2>/dev/null
    launchctl unload "$WHATSAPP_PLIST" 2>/dev/null
    echo "Both bots stopped."
    ;;

  restart)
    echo "Restarting bots..."
    launchctl unload "$TELEGRAM_PLIST" 2>/dev/null
    launchctl unload "$WHATSAPP_PLIST" 2>/dev/null
    sleep 2
    launchctl load "$TELEGRAM_PLIST" 2>/dev/null
    launchctl load "$WHATSAPP_PLIST" 2>/dev/null
    echo "Both bots restarted."
    ;;

  status)
    echo "=== Bot Status ==="
    echo ""
    if launchctl list | grep -q "$TELEGRAM_LABEL"; then
      PID=$(launchctl list | grep "$TELEGRAM_LABEL" | awk '{print $1}')
      echo "Telegram:  RUNNING (PID: $PID)"
    else
      echo "Telegram:  STOPPED"
    fi

    if launchctl list | grep -q "$WHATSAPP_LABEL"; then
      PID=$(launchctl list | grep "$WHATSAPP_LABEL" | awk '{print $1}')
      echo "WhatsApp:  RUNNING (PID: $PID)"
    else
      echo "WhatsApp:  STOPPED"
    fi

    echo ""
    echo "=== Recent Logs ==="
    echo ""
    echo "--- Telegram (last 5 lines) ---"
    tail -5 "$LOG_DIR/telegram.log" 2>/dev/null || echo "(no logs yet)"
    echo ""
    echo "--- WhatsApp (last 5 lines) ---"
    tail -5 "$LOG_DIR/whatsapp.log" 2>/dev/null || echo "(no logs yet)"
    ;;

  logs)
    BOT="${2:-telegram}"
    tail -f "$LOG_DIR/$BOT.log"
    ;;

  *)
    echo "Usage: ./scripts/bots.sh {start|stop|restart|status|logs [telegram|whatsapp]}"
    ;;
esac
