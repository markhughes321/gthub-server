import notifier from "node-notifier";
import { execFile } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { platform } from "os";
import { getProjectRoot } from "./config.js";

const ICON_PATH = join(getProjectRoot(), "icon.png");
const SOUND_PATH = join(getProjectRoot(), "assets", "notify.wav");

function openInBrowser(url: string): void {
  if (platform() === "win32") {
    execFile("cmd", ["/c", "start", "", url]);
  } else if (platform() === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

function playCustomSound(): boolean {
  if (!existsSync(SOUND_PATH)) return false;
  if (platform() === "win32") {
    execFile("powershell", ["-c", `(New-Object Media.SoundPlayer '${SOUND_PATH}').PlaySync()`]);
    return true;
  }
  return false;
}

export function notify(
  title: string,
  message: string,
  clickUrl?: string
): void {
  const customSoundPlayed = playCustomSound();

  notifier.notify(
    {
      title,
      message,
      sound: !customSoundPlayed,
      icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
      timeout: 10,
      // appID overrides the "SnoreToast" label shown on Windows
      appID: "PR Review",
    } as Parameters<typeof notifier.notify>[0],
    (_err, response) => {
      if (clickUrl && (response === "clicked" || response === "activate")) {
        openInBrowser(clickUrl);
      }
    }
  );
}
