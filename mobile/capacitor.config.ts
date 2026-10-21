import type { CapacitorConfig } from "@capacitor/cli";

// Mode A: the app loads a self-hosted Paperclip server.
//
// Setting `server.url` keeps everything same-origin with the server, so the
// existing Paperclip UI works untouched: session cookies, WebSocket live events
// and the service worker all behave exactly as in a desktop browser.
//
//   PAPERCLIP_MOBILE_SERVER_URL=https://paperclip.example.com npx cap sync
//
// Without it the bundled www/ page acts as a connect screen: the user enters a
// server address, it is stored with @capacitor/preferences, and the WebView
// navigates to it.
const serverUrl = process.env.PAPERCLIP_MOBILE_SERVER_URL?.trim();
const cleartext = serverUrl?.startsWith("http://") ?? false;

const config: CapacitorConfig = {
  appId: "ai.paperclip.app",
  appName: "Paperclip",
  webDir: "www",
  appendUserAgent: "PaperclipShell/0.3.1",
  ...(serverUrl ? { server: { url: serverUrl, cleartext } } : {}),
  ios: {
    contentInset: "always",
    // Self-hosted servers live on LAN/Tailscale hosts, not on app-bound domains.
    limitsNavigationsToAppBoundDomains: false,
    preferredContentMode: "mobile",
  },
  android: {
    allowMixedContent: cleartext,
    captureInput: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#18181b",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#18181b",
    },
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
  },
};

export default config;
