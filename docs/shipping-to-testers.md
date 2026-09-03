# Getting the mobile app to alpha testers

The app talks to whatever `EXPO_PUBLIC_API_URL` / `app.config.js` resolves to at
**bundle time**. `app.config.js` defaults it to `https://project-river.fly.dev`,
so any build or OTA update points at the deployed server — a tester's phone can
never fall back to `localhost`. Confirm it in the app: the login screen and
Settings both show `server: <host>`.

If you deploy the API under a different Fly app name, change the default in
`apps/mobile/app.config.js` **and** the `env` blocks in `apps/mobile/eas.json`.

## Option A — EAS Update + Expo Go (recommended: free, iOS + Android, no laptop)

Testers install **Expo Go** once, then open a link. The JS bundle lives on
Expo's CDN, so your machine doesn't have to stay running.

```bash
npm i -g eas-cli
cd apps/mobile
eas login                       # free Expo account
eas init                        # links the project, writes the projectId

# publish the bundle (API URL baked from app.config.js / .env)
EXPO_PUBLIC_API_URL=https://project-river.fly.dev eas update --branch preview --message "alpha build 1"
```

`eas update` prints a QR / link — send it to testers. Ship JS changes later
with another `eas update --branch preview`.

> Expo Go must match the SDK (52). Fine for this alpha since the app uses no
> custom native modules.

## Option B — a standalone Android APK (free, no Expo Go)

```bash
cd apps/mobile
eas build --profile preview --platform android
```

`eas.json`'s `preview` profile builds an APK with `EXPO_PUBLIC_API_URL` set.
EAS hosts the artifact — send testers the install link. Update JS in place with
`eas update --branch preview` (same as Option A); a native change needs a new
build.

## iOS

A standalone iOS build (`eas build -p ios`) needs an Apple Developer account
($99/yr). Without one, iOS testers use **Option A** (Expo Go + `eas update`).

## Local development (your own machine)

`expo start` with the API on your laptop: create `apps/mobile/.env`:

```
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000   # your machine's LAN IP, not localhost
```

Then `pnpm --filter @river/mobile dev` and scan with Expo Go on a phone on the
same wifi.
