# Troubleshooting

Each entry: what you see, why, and what to do. Messages are quoted as holt
prints them; `<...>` stands for the part that varies.

Two places tell you most of what is wrong: **holt's menu** (click the
toolbar icon; its header names the project holt writes into for this page,
or says why it can't), and the **settings panel** (holt's menu →
**Settings**), which shows the server, the session folder and the
settings.

## The toolbar icon shows a red "!"

**Why.** Nothing is recording, and no usable holt server answers for the
local page in front: neither the page's own origin (the Vite plugin) nor
the fallback server URL (`http://127.0.0.1:4848` by default, where
`npx holt` listens). "Usable" also rules out a server that wants a token
you haven't entered, and one from a release that speaks another protocol
version (see the next entry). The "!" is only shown on `localhost` and
`127.0.0.1` pages; on other sites the icon stays plain.

A "!" that appears for a few seconds and goes away is different: a capture
just failed, and the icon's tooltip has the error meanwhile.

**Fix.** Click the icon. The menu's header says **Not connected** (or
**Update needed**) and why; hovering the icon shows the same reason. Most
often the server isn't running: start it in your project (`npx holt`, or
the dev server that has the Vite plugin). holt checks again when you
switch tabs, load a page or open its menu, so reload the page if the "!"
stays.
If the server runs elsewhere, set its URL under **Settings** → Server. If
the server wants a token, enter it under **Settings** → Token.

## "Update needed"

**Why.** The extension and the server are released separately (Chrome
updates the extension; your project pins the npm package), and they found
they speak different protocol versions. holt refuses to capture rather
than fail after you did the work. The message says which side is behind:

- "The holt server in `<project>` is too old for this extension. Update it:
  npm i -D @velvet-thunder/holt@latest (or run npx
  @velvet-thunder/holt@latest), then restart it."
- "This holt extension is older than the holt server in `<project>`. Update
  it at chrome://extensions (Developer mode, then Update) or wait for
  Chrome to update it."

(Without a project name, the message names the server's host instead.)

**Fix.** Do what it says. After updating the server, restart it, or the
Vite dev server. For the extension, the **Update** button on
`chrome://extensions` appears once **Developer mode** is on; Chrome also
checks for updates by itself every few hours. A build from source: pull,
rebuild, and reload it on `chrome://extensions`.

A capture can also fail with "Unknown entry kind ... The holt extension is
probably newer than this holt server (`<version>`): update the server with
...". That is the same problem for a new kind of capture: update the server.

## The microphone is blocked

**What you see.** "Microphone access is blocked for holt. Allow it once on
holt's permission page, then try again." (or the dictation and narration
versions of that message), and a tab titled "holt: microphone access".

**Why.** The microphone permission belongs to the extension, not to the
site you are testing. holt records in a hidden page, where Chrome can't
show a permission prompt, so it asks on its own page instead.

**Fix.** On that page, click **Allow microphone** and allow it in Chrome's
prompt, then start the voice note again. If you denied it before, Chrome
doesn't ask again: the page says "Access was denied" with a
`chrome://settings/content/siteDetails?site=...` address for holt; open it
and set Microphone to Allow. If Chrome itself has no microphone access in
your operating system (macOS: System Settings → Privacy & Security →
Microphone), allow it there too.

"No microphone found." means there is no input device. If the microphone
picked under **Settings** → Microphone is unplugged, holt records with the
default one and says "Selected microphone not found; used the default".

## No transcript

Without a transcript, a voice note still saves its audio file, and a tab
recording still saves its video. What the transcript box or the note says
tells you why:

- "Transcription is off. ..." **Settings** → Speech → **Transcribe
  speech** is off (it can also be switched on the welcome tab and the
  microphone permission page). Off is a privacy choice: Chrome's speech
  recognition sends the audio to Google. Turn it on if you want
  transcripts.
- "Speech recognition needs a network connection (Chrome uses an online
  service). ..." You are offline, or Google's speech service can't be
  reached. Browsers that don't have Google's service (Brave, and possibly
  Arc) can fail this way too.
- "Speech recognition is not available in this browser." The browser has
  no speech recognition at all. Use Chrome, or turn transcription off.
- "Speech recognition is not allowed in holt's background recorder
  (microphone permission or browser policy). ..." Grant the microphone (see
  above). If it still happens, a browser or enterprise policy blocks speech
  recognition.

On older Chrome versions, speech recognition listens to the system
default microphone even when you picked another one in Settings (the audio
file still uses the one you picked; Chrome 155 is known to transcribe the
picked one). Make the microphone you want the system default, or update
Chrome.

## Port 4848 is already in use

**What you see.** `npx holt` stops with
`[holt] error: Port 4848 on 127.0.0.1 is already in use. Is holt already running? Try --port <other>.`

**Why.** Another process listens on that port, often holt itself, still
running for another project.

**Fix.** Stop the other one, or pick another port: `npx holt --port 4949`
(or `"port": 4949` in `holt.config.json`). The extension's fallback URL is
port 4848, so the banner then says what to set:
`Connect: in the holt extension's settings (toolbar menu > Settings), set the server URL to http://127.0.0.1:4949`.
Do that under **Settings** → Server, and **Save**.

## Vite runs behind another backend

**What you see.** You use the Vite plugin, but your pages are served by
Rails, Laravel, Django or similar, and holt says **Not connected**, or
captures land in another project's standalone server.

**Why.** The extension looks for holt on the page's own origin. Here that
is the backend's origin, which has no `/__holt`, so holt uses the fallback
URL.

**Fix.** Under **Settings** → Server, set the fallback server URL to the
Vite dev server. The plugin prints it at startup:
`If your pages come from another server (Vite behind Rails, Laravel, Django, ...), set the extension's fallback server URL to http://localhost:5173.`
Or pick **Always use this URL**, which also stops holt from asking pages
for `/__holt/status`.

## "holt on `<origin>` isn't answering"

**What you see.** "holt on http://localhost:5173 isn't answering (dev
server restarting?). Try again in a moment."

**Why.** That page's origin answered as holt earlier in this browser
session and has stopped (the Vite dev server is restarting or was
stopped). holt does not fall back to the fallback URL for it, because that
may be another project's server and the capture would land in the wrong
repository.

**Fix.** Start the dev server again, or wait for it to finish restarting.
If you stopped using holt on that origin, restarting Chrome makes it
forget.

## A shortcut does nothing

**Why.** Chrome allows only four default shortcuts per extension, so
holt's visible-area and full-page screenshots ship without one. And if
another extension already uses one of the defaults (Alt+S, Alt+A, Alt+R,
Alt+T), or it is one of Chrome's own shortcuts on your platform, Chrome
leaves holt's unbound without saying so.

**Fix.** Set them at `chrome://extensions/shortcuts`. **Settings** →
Shortcuts lists the bindings Chrome actually has. On macOS, Alt is
Option (⌥). See [the extension README](../packages/extension/README.md#keyboard-shortcuts)
for platform details.

## "Chrome only lets holt capture a tab after you invoke holt on it"

Screenshots and tab recordings need you to have used holt on that tab: a
holt shortcut, or opening holt's menu there. The grant ends when the tab
navigates to another page. Press the shortcut again, or open the menu on
the tab. `chrome://` pages and the Chrome Web Store can't be captured at
all.

## `npx holt` runs something else

**Why.** In a project without `@velvet-thunder/holt` installed, `npx holt`
downloads and runs the unrelated `holt` package from the npm registry.

**Fix.** Install it first (`npm i -D @velvet-thunder/holt`), after which
`npx holt` runs holt, or use the full name: `npx @velvet-thunder/holt`.

## Where did my captures go?

Into `<project>/qa/<YYYY-MM-DD-HHMMSS>/notes.md` plus the media files next
to it. The project is the directory you started `holt` in, or Vite's root
with the plugin, and `qa` is `outputDir` (`--out` on the command line).
The server prints the folder at startup (`Writing sessions to ...`), and the
settings panel shows the current session's notes file and folder.

- A session starts with your first capture (or **Start new session** in
  the settings panel) and lasts until you start another, click **End
  session**, or stop the server. Captures from one session go into one
  folder.
- Each capture goes to the server for the page you took it on: with the
  Vite plugin, that dev server's project; otherwise the server at the
  fallback URL. holt's menu names the project for the page in front.
- `git status` doesn't show them: holt writes a `.gitignore` into the
  output folder when it creates it. Delete it to commit sessions.
- On a page holt has no access to, the entry says "Unknown page" instead
  of the title and URL.
