import { execFile } from 'node:child_process';

// Native desktop notification with no dependencies. Text goes through env vars, never into the script, so it can't inject commands.
const WIN = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:AP_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:AP_BODY)) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

export function desktopNotify(title, body) {
  const env = { ...process.env, AP_TITLE: title, AP_BODY: body };
  const [cmd, args] =
    process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN]] :
    process.platform === 'darwin' ? ['osascript', ['-e', 'display notification (system attribute "AP_BODY") with title (system attribute "AP_TITLE")']] :
    ['notify-send', [title, body]];
  execFile(cmd, args, { env, windowsHide: true, timeout: 15000 }, e => { if (e) console.warn(`desktop notification failed (${cmd}): ${e.message.split('\n')[0]}`); });
  console.log(`[${new Date().toLocaleTimeString()}] ${title}: ${body}`);
}
