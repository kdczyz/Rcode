import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rcode.mobile",
  appName: "Rcode",
  webDir: "dist",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false }
};

export default config;
