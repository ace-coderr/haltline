# Haltline

A risk guard for one trading session, shown on Even G2 glasses. It tells you, at a glance and without picking up a phone, how close you are to your own daily loss limit, and lets you act on it with one confirmed gesture.

Hackathon: Heads Up: Even Realities Hackathon (DoraHacks), Track 3: Exchanges & Stocks.

> This README is a work in progress. The full version (architecture, setup, safety model, limitations) is written in the final step. The two statements below are already final.

## Verification status

**Tested in the official Even Hub simulator. Not yet verified on physical glasses.**

Hardware-unverified: swipe direction mapping (the SDK does not document how scroll-top and scroll-bottom events map to swipe up and down, so the app ignores direction: any swipe cycles through the options, and a swipe on a confirm screen only cancels), BLE timing of image and text updates, font rendering and text widths, and the microphone PCM format on real hardware.

## Pre-existing work

The official Even Hub minimal template was first downloaded on 19 Nov 2026 to test the development environment (a tap-counter test, no Haltline code, not part of this repo). The /glasses scaffold in this repo was downloaded fresh from that template on 23 Nov 2026. All Haltline code was written from 23 Nov 2026.

## Paper trading only

The account is simulated and priced from live public market data (Bitstamp public ticker, no API key). No real funds are held, no order ever reaches a real exchange, and nothing here is financial advice.
