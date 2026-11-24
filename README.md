# Pump Fun Replay Sprint — Paper Bot

[![competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/toirant/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/toirant/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump Fun Replay Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins.

## Strategy

Ride the opening trend of fresh launches, then get out fast:

- **Entry — fresh launches only.** Every coin is watched from its `CreateEvent`. In its first 3 slots the bot reads the opening tape: the creator's own buy (at most 0.5 SOL), whether the creator has already sold, how many other wallets bought in (exactly one distinct non-creator buyer — a launch bundled by many wallets is usually the creator's cluster waiting to dump), and whether recent flow is still net buying. Only launches that pass get one small 0.1 SOL buy.
- **Exit — fast.** The position is sold whole on the first of: +15% take-profit, −8% stop loss, 15 slots held, or the creator selling while held. Fresh pump.fun coins mostly dump, so the bot takes the opening move and leaves.
- **Spread thin.** Stakes are tiny and spread over ~140 coins on the dev window, so no single coin can hurt the run and the 20-coin guardrail is cleared by the entries themselves. A probe backstop opens tiny round trips only if fills or coins ever lag the pace.

## Run

```sh
node main.ts
```

`main.ts` is a single self-contained file (Node 22+, no dependencies). It speaks the `agent-fun/replay/v2` protocol on stdin/stdout: one JSON line in per batch (`hello` / `batch` / `done`), exactly one reply line out per batch. No clock, no randomness, no environment, no network, no files — every decision comes only from the batches the harness sends, so two runs on the same window produce identical action logs.

## Dev-window result (kit `grade-local`, process driver)

- **Net PnL: −0.076 SOL** on 10 SOL starting capital (−0.76%)
- 280 fills over 140 coins, 140 round trips, max drawdown 0.008
- Guardrails met (127 coins hold a round trip of at least 0.01 SOL)

The dev window is a hard, mostly-down sample: the kit's own tuned momentum pilot loses −9.49 SOL on it and its sniper pilot −0.47 SOL. This bot's edge is survival — tiny drawdown, guardrails met — so it stays in the ranking on bad windows and can catch the upside on a window where fresh launches run.

## License

MIT — see [LICENSE](LICENSE).
