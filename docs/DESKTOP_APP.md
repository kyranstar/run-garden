# Desktop app (Tauri 2, macOS-first)

`apps/desktop` is a small Tauri 2 menu-bar/window app whose real job is to
host the **COROS bridge** on your Mac — the only machine that may hold COROS
credentials and the only place COROS writes execute (residential IP + product
security rule). The UI shows bridge status, pairing, and safety controls.

## What it does

- Spawns `services/coros-bridge` as a **Tauri sidecar** and speaks NDJSON to
  it over stdin/stdout (the bridge never opens an HTTP port).
- Stores COROS email/password/region and the device's Ed25519 private key in
  the **macOS Keychain** (`src-tauri/src/keychain.rs`, Rust `keyring` crate);
  credentials reach the sidecar via stdin only — never argv, env, or logs.
- Runs the sync loop (`services/coros-bridge/src/cloud-sync.ts`): pushes a
  schedule/activity/health snapshot roughly every 30 minutes (14 days back,
  8 weeks ahead), polls the worker for queued COROS write jobs every 45 s,
  executes them via the [safe write protocol](COROS_WRITE_PROTOCOL.md), and
  reports Ed25519-signed results.

## Pairing flow

1. First launch generates an Ed25519 keypair (private key → Keychain).
2. The app calls `POST /api/devices/handshake` with the public key, device
   name, platform, and version, receiving a `handshakeId` and an `approveUrl`.
3. It opens the approve URL in your browser; you sign in with the single
   allowed Google account, which approves the handshake.
4. The app polls `GET /api/devices/handshake/:id` until `claimed`, storing its
   permanent `deviceId` in the Keychain. Handshakes expire after 15 minutes
   and are single-use.

From the web UI you can later **pause** the bridge (stops claiming jobs) or
**revoke** the device (signature auth fails permanently).

## Safety controls in the app

- **Run schedule write test** (Settings → COROS): the reversible write spike —
  moves one approved low-risk workout one day and back, verifying each step,
  and writes a sanitized report. Until this passes on your real account,
  treat COROS writes as unproven (see
  [COROS_WRITE_PROTOCOL.md](COROS_WRITE_PROTOCOL.md#the-initial-reversible-write-test)).
  Also available headless as `pnpm coros:spike`.
- **Pause bridge / Resume bridge** — local pause switch.
- **Erase credentials** — clears all Keychain entries and the sidecar memory.
- **Launch at login** — the `set_launch_at_login` command is wired in the UI;
  the actual autostart registration is provided by the `tauri-plugin-autostart`
  plugin at packaging time (the dev build's command is currently a no-op stub —
  `src-tauri/src/lib.rs`).

## Building it

Prereqs: Rust toolchain (`rustup`), Xcode command-line tools, pnpm, and
**Bun** (for the sidecar compile; see below).

```bash
pnpm install
pnpm --filter @rg/desktop sidecar:build   # compile the bridge sidecar binary
pnpm --filter @rg/desktop tauri build     # build the .app / .dmg
```

- `sidecar:build` (`apps/desktop/scripts/build-sidecar.mjs`) compiles
  `services/coros-bridge/src/main.ts` into a self-contained executable with
  `bun build --compile` and places it at
  `src-tauri/binaries/coros-bridge-<target-triple>` (e.g.
  `coros-bridge-aarch64-apple-darwin`), which `tauri.conf.json` references via
  `bundle.externalBin`. If a prebuilt `services/coros-bridge/dist/coros-bridge`
  exists it is copied instead; without Bun the script prints the manual path
  to place a binary at and exits.
- `tauri build` produces `dmg` + `app` targets, minimum macOS 12.0.
- Dev mode: `pnpm dev:desktop` (Vite on :5180 + `tauri dev`; the sidecar can
  run via `pnpm --filter @rg/coros-bridge start` with tsx during development).

## macOS-first, no Apple Developer account needed

For personal use you do not need a paid Apple Developer account: the build is
ad-hoc signed. Gatekeeper will warn on first launch of an unnotarized app —
**right-click the app → Open → Open** (or approve it under System Settings →
Privacy & Security). Since you built it yourself, that's the whole ceremony.
If you later want notarization, add your signing identity to the Tauri macOS
bundle config.

## Windows/Linux

The TypeScript bridge, protocol, and cloud-sync code are platform-neutral, the
`keyring` crate maps to Windows Credential Manager / Secret Service, and the
pairing API accepts `windows`/`linux` platforms — so the **shared code is
compatible**. But packaging, tray behavior, autostart, and the sidecar build
have only been exercised for macOS; treat other platforms as untested.
