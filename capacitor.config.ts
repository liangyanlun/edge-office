import type { CapacitorConfig } from "@capacitor/cli";

const apiServer = process.env.EDGE_OFFICE_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.edgeoffice.app",
  appName: "微知 Edge Office",
  // mobile:sync creates a clean, allow-listed app shell before Capacitor copies.
  webDir: "build/release-public",
  bundledWebRuntime: false,
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#15263a",
      showSpinner: false
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#15263a"
    }
  }
};

// For a packaged phone build, set EDGE_OFFICE_SERVER_URL to the HTTPS cloud
// endpoint or a paired LAN gateway. Leaving it unset keeps the local PWA mode.
if (apiServer) {
  config.server = {
    url: apiServer,
    cleartext: apiServer.startsWith("http://")
  };
}

export default config;
