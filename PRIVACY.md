# Privacy policy

_Effective 2026-10-26. Applies to the holt Chrome extension and the
`@velvet-thunder/holt` npm package._

holt is a tool for QA-ing your own app. It takes screenshots, tab
recordings, and voice or typed notes, and a server that you run on your own
computer writes them into your project folder. The developer of holt runs no
servers and receives none of your data. There are no accounts, no
analytics, no telemetry, no ads and no tracking.

## What the extension handles, and where it goes

Everything below happens only when you start a capture (a holt shortcut, or
an item in holt's menu). Nothing is captured in the background.

| Data | When | Where it goes |
| --- | --- | --- |
| Screenshots of the current tab | You take a screenshot | Your holt server |
| Video and sound of the current tab | You record the tab | Your holt server |
| Microphone audio | You record a voice note or narrate a tab recording | Google's speech service, if transcription is on (see below). Your holt server, if the audio is kept. |
| Microphone audio | You use the dictation button in the note window | Google's speech service, if transcription is on |
| Typed notes and transcripts | You save a note | Your holt server |
| The captured page's URL and title | With each capture | Your holt server |

**Your holt server** is the one you start, with `npx holt` or the Vite
plugin, on your own computer. By default the extension only talks to
`http://127.0.0.1` and `http://localhost`. If you enter another server
address in holt's settings, captures go there instead. The server writes
them into your project folder (by default `qa/`) and sends them nowhere
else.

To find your server, the extension asks pages served from `localhost` or
`127.0.0.1` for `/__holt/status`. It never contacts any other site. The
extension can also see the URL and title of `localhost` and `127.0.0.1`
tabs; it uses them only to label captures and to show which project holt
writes to.

## Speech recognition (Google)

To turn your speech into text, holt uses Chrome's built-in speech
recognition (`webkitSpeechRecognition`). In Chrome this sends the audio
from your microphone to Google's speech service while you speak, and the
text comes back to the extension. Google's handling of that audio is
covered by [Google's Privacy Policy](https://policies.google.com/privacy).
holt sends Google nothing else.

You can turn transcription off in holt's settings, or on the welcome page
that opens when you install holt. With transcription off, no audio goes to
Google. Voice notes then keep the audio file instead of a transcript, tab
recordings don't use the microphone at all, and the dictation button is
hidden.

## What is stored in your browser

In `chrome.storage` on your device (it is not synced to your Google
account):

- your settings: server address, token, microphone choice, and the
  transcription and audio options;
- short-lived state the extension needs to survive a restart: what is
  recording right now, the most recent captures in this session, and the
  note you are typing about a screenshot along with which screenshot it
  belongs to, so the note is not lost if Chrome closes.

Removing the extension deletes all of it.

## What the server stores

The server writes captures only into the output folder in your project.
Each session's `notes.md` contains the URLs and titles of the pages you
captured, the absolute path of your project folder, and your notes. When the
server creates the output folder, it adds a `.gitignore` so sessions are not
committed by accident. You decide whether to commit, share or delete them.

## Sharing and selling

holt does not sell, share, or transfer your data to anyone. The developer
never receives it. The only third party involved is Google's speech
service, as described above, and only while transcription is on.

## Changes

Changes to this policy are made in this file, and its history is public in
the repository. The effective date at the top is updated whenever this
policy changes.

## Contact

Questions: open an issue at <https://github.com/eric435/holt/issues>.
Security problems: report them privately as described in
[SECURITY.md](SECURITY.md).
