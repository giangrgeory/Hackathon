import type { CapacitorConfig } from "@capacitor/cli";

const appUrl = process.env.APP_WEB_URL?.trim();
if (!appUrl) {
    throw new Error("Set APP_WEB_URL to the HTTPS URL where Kita-Kita is hosted.");
}

const config: CapacitorConfig = {
    appId: "com.kitakita.reporting",
    appName: "Kita-Kita",
    webDir: "www",
    server: {
        url: appUrl,
        cleartext: false
    }
};

export default config;
