[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Erwinsays12/makefun-pump-replay-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Erwinsays12/makefun-pump-replay-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Confirm-Then-Ride Paper Bot

A trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`).

## Idea

Most fresh curves die flat: on the dev window the median coin sees 1 buyer and 0.3 SOL of buys in its first 20 slots. The coins that run to 3x or complete share one early signature — several distinct wallets buying, real SOL piling in fast, and the price already 25%+ above its create price within the first slots. So this bot does **not** snipe the create slot. It watches every curve from birth, waits for that signature to confirm, buys small (0.03 SOL), and exits fast: take profit at +15%, stop loss at −15%, trailing stop, or a 300-slot time limit. Five open slots and ~1200 coins per day mean slots must turn over, so positions never sit on dead coins.

Entry requires, over an 8-slot window: ≥ 8 distinct non-creator buyers, ≥ 5 SOL net inflow, price +25% over the window start and within 3% of the window high, the last trade a buy, and no single buyer over 40% of the window's buy SOL. A probe round-trip mechanism keeps the run above the 20-coin guardrail if entries ever lag the pace.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (pure function of the batches; no clock, no randomness, no I/O, so the two graded executions match byte for byte).
- `vendor/agentfun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte.

## Local grading

With the competition kit unpacked:

```sh
node --import /home/hatch/workspace/makefun/undici-preload.mjs cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Dev-window result: net PnL ≈ −0.03 SOL, 142 coins, 36% win rate, max drawdown ≈ 1.1%, guardrails met.

## License

MIT — see [LICENSE](LICENSE).
