#!/usr/bin/env bash
# demo.sh - Reproducible one-command showcase of the IVL skill.
# No API key: uses public Binance candles. Run: bash demo.sh
set -e
cd "$(dirname "$0")"

line() { printf '\n\033[1;33m=== %s ===\033[0m\n' "$1"; }

line "1) Self-test (polarity high IVL=good + intrinsic fractality)"
node selftest.mjs | tail -9

line "2) IVL - BNB-USDT (range, LP ticks, decision)"
node ivl.mjs --pair BNB-USDT --lookback 120 | head -12

line "3) Backtest - BNB-USDT (evidence: fee-efficiency vs naive range)"
node backtest.mjs --pair BNB-USDT | tail -9

line "4) Backtest - BNB-AAVE (synthetic cross, pool with no direct pair)"
node backtest.mjs --pair BNB-AAVE | tail -7

printf '\n\033[1;32m🐉 Demo complete.\033[0m\n\n'
