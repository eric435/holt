# Security policy

holt runs a local server that writes files into your repository, and a
Chrome extension that captures your screen and microphone. Security reports
are very welcome.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the
repository's **Security** tab and click **Report a vulnerability**
(<https://github.com/eric435/holt/security/advisories/new>). Do not open a
public issue, pull request or discussion for a suspected vulnerability.

A useful report says:

- which part is affected: the npm package `@velvet-thunder/holt` (CLI,
  Vite plugin) or the Chrome extension, and which version;
- how you ran it (standalone or Vite, Vite version, OS, Chrome version, and
  any non-default config such as `host`, `token` or `allowedOrigins`);
- the steps to reproduce, and what an attacker gains.

holt is maintained by one person in their spare time, so responses are best
effort. You will get an acknowledgement once the report has been read, and
a fix is released as soon as it is ready. Reporters are credited in the
advisory unless they would rather not be.

## Supported versions

Only the latest release of each part gets security fixes: the latest
`@velvet-thunder/holt` on npm, and the latest extension version. holt is
pre-1.0, so a fix may ship in a release that also changes behavior; the
release notes say so when it does.

## What counts

[docs/SECURITY.md](docs/SECURITY.md) is the threat model: what the server
and the extension defend against, and what they deliberately do not. A way
around one of the defenses it lists is a vulnerability. Some examples:

- a web page or another machine writing into, or reading from, your
  repository or session folders through holt (or another extension doing
  so when `allowedExtensionIds` pins holt to yours);
- a path that makes the server write outside the session folder;
- the Vite plugin serving the session folders or holt's config file;
- the extension sending captures, settings or the token anywhere other
  than the server it is configured for or found on the page's origin.

Things the threat model lists as trusted or out of scope (for example, a
program running as your user, other installed extensions while
`allowedExtensionIds` is unset, or a server you pointed the extension at
yourself) are not vulnerabilities, but if you think one of those
decisions is wrong, an ordinary issue is the right place to argue it.
