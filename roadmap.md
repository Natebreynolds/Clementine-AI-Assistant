# Clementine Roadmap

## Native Desktop App (Electron)

**Status:** Planned
**Priority:** Medium
**Repo:** `clementine-desktop` (separate repo)

### Why
- Mac users shouldn't need a terminal to access the dashboard
- System tray icon gives always-on quick access
- Native notifications instead of Discord-only
- Auto-launch on login — feels like a real app
- Better onboarding for non-technical users

### Architecture
- Electron main process starts the Express dashboard server internally (or connects to running daemon)
- BrowserWindow renders the existing dashboard HTML — no dashboard code changes needed
- Tray icon with quick actions (status, open dashboard, restart, quit)
- Native menu bar integration

### Build Steps
1. Scaffold Electron app with `electron-builder`
2. BrowserWindow → existing localhost dashboard
3. System tray icon + native menus
4. Auto-launch on login (LaunchAgent or Electron's built-in)
5. Package as .dmg for distribution
6. Code signing for macOS Gatekeeper
7. Auto-updater (electron-updater or Sparkle)

### Considerations
- Electron adds ~150MB to app size
- Alternative: Tauri (Rust-based, ~5MB, uses system WebView) — different stack but much lighter
- Dashboard server could run inside the Electron process or connect to the existing daemon
- Need to handle the case where daemon isn't running (start it automatically?)

### Estimate
- Scaffolding + basic window: 1-2 hours
- Tray icon + menus + auto-launch: 2-3 hours
- Packaging + .dmg + code signing: 3-4 hours
- Auto-updater: 2-3 hours
- **Total: ~1-2 days**

---

## Future Ideas

*(Add items here as they come up)*

- Claude Memory npm package — portable memory system for any Claude Code project
- Multi-user support — per-user auth, isolated vaults, shared server
- Mobile companion app (React Native) — notifications + quick chat
