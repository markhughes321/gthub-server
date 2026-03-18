import { notify } from "../src/notifier.js";

console.log("Test 1: Success notification with click-to-open (click to open GitHub)");
notify(
  "Review Ready: KaseyaOne/kaseya-one-auto-tests#42",
  "mark.hughes · No critical issues found. Minor typing improvements suggested.",
  "https://github.com/KaseyaOne/kaseya-one-auto-tests/pulls"
);

setTimeout(() => {
  console.log("Test 2: Failure notification (5s after first)");
  notify(
    "Review Failed: KaseyaOne/kaseya-one-auto-tests#99",
    "claude exited with code 1: review timed out after 15 minutes"
  );
}, 5000);
