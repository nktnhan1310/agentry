---
name: react-native
description: React Native / Expo conventions: native deps, platform differences, lists, secure storage, uploads, builds and OTA updates. Use when writing or reviewing an Expo or React Native app.
---
# React Native / Expo
Check first: the `expo` SDK version in package.json, Expo Router (`expo-router`) vs React Navigation, and managed vs bare (`ios/` and `android/` folders present). Follow what the repo already uses.

Dependencies
- Expo projects: add native packages with `npx expo install <pkg>` so versions match the SDK, not a bare `npm install`.
- A new native module or permission means a new native build; it cannot ship as an OTA update.
- Native config (permission strings, plugins) goes in `app.json` / `app.config.*` config plugins, not hand-edited native folders in a managed app.

Platform
- Test both platforms for anything touching files, permissions, keyboard, safe areas, or fonts. Use `Platform.OS` or `.ios.tsx` / `.android.tsx` files for real differences, not scattered ternaries.
- Respect safe areas (`react-native-safe-area-context`) and keyboard avoidance on forms.

Lists & rendering
- Long or unbounded lists: `FlatList`/`SectionList` (or FlashList if the repo uses it) with a stable `keyExtractor`; never `ScrollView` + `map`.
- Keep `renderItem` cheap and memoized; no inline style objects or new closures per row in hot lists.
- Styles via `StyleSheet.create` or the repo's styling system.

Data & secrets
- Anything bundled is public: `EXPO_PUBLIC_*` variables and app config end up in the app. No secrets in the client.
- Tokens go in secure storage (`expo-secure-store` / Keychain / Keystore), not AsyncStorage.
- Handle offline, timeouts, and retries explicitly; cancel requests on unmount (`AbortController`).

Files & uploads
- Android returns `content://` URIs; copy or read through the file-system API before uploading if the server needs a real file.
- Multipart uploads: `FormData` entries as `{ uri, name, type }` with a real filename and MIME type; encode non-ASCII names deliberately.

Navigation
- Typed route params; validate params from deep links like any external input.

Permissions
- Ask at the moment of use, explain why, and handle "denied" and "never ask again" with a path to settings.

Testing & builds
- Unit/component tests with the repo's preset (`jest-expo` or `react-native` preset) and `@testing-library/react-native`; query by role/label/text.
- Mock native modules at the boundary only. Type-check with `npx tsc --noEmit`.
- EAS builds use the profiles in `eas.json`; OTA updates (`expo-updates`) only reach builds with a matching `runtimeVersion`.

Accessibility
- `accessibilityRole` / `accessibilityLabel` on touchables and icons; touch targets ≥44pt (use `hitSlop`).
