/**
 * Hand a loopback URL to the operating system's default browser.
 *
 * The card cannot do this itself: a `window.open` inside the DSH shell opens an
 * in-app window (or is blocked), not the browser the user actually browses in.
 * The URL is never supplied by the client — the caller passes the supervisor's
 * own address — so this cannot be used to open arbitrary targets.
 *
 * `open` is LaunchServices' one verb for this: it resolves the default browser
 * from the user's settings, which is exactly what a browser button should do.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Fire-and-forget: the browser's lifetime is not the caller's business. */
export async function openExternal(url) {
  if (process.platform !== 'darwin') {
    throw new Error(`当前平台（${process.platform}）不支持打开系统浏览器；本包只提供 macOS 构建`)
  }
  await execFileAsync('open', [String(url)])
}
