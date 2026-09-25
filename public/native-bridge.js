const plugins = () => globalThis.Capacitor?.Plugins || {};

export function isNativeApp() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}

export async function shareFile(url, title = "微知 Edge Office 文件") {
  const share = plugins().Share;
  if (!share?.share) return false;
  await share.share({ title, url, dialogTitle: "分享文件" });
  return true;
}

export async function hideSplash() {
  const splash = plugins().SplashScreen;
  if (splash?.hide) await splash.hide();
}
