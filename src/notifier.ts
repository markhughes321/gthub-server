import notifier from "node-notifier";
import { join } from "path";
import { getProjectRoot } from "./config.js";

export function notify(title: string, message: string): void {
  notifier.notify({
    title,
    message,
    sound: true,
    icon: join(getProjectRoot(), "icon.png"),
    timeout: 10,
  });
}
