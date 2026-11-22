# Security

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's private vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**, or go to <https://github.com/DreamZora/racku/security/advisories/new>. Please don't open a public issue for it.

Say what you found, how to reproduce it, and which version or commit it affects. The answer comes in the same report, and the advisory credits you when the fix is out, unless you'd rather not be named.

## Versions that get fixes

Fixes go into the newest minor version of racku. A fix for a vulnerability comes as a patch of it, and its release notes say so. Earlier minor versions get none.

## What racku protects against

- **It protects against:** the clients of panels and listeners, other users of the same machine, and web pages in a browser of the rack's user.
- **It trusts:** the code of its devices, and whoever can write the app's files, an executable's base directory, or a hot-plug directory, since those decide what code the rack runs.
- **By design, whoever holds the management endpoint runs code as the rack's user:** a swap names a file, which the rack builds and runs. The endpoint is a Unix socket that only the rack's user can reach, or loopback TCP with a token of 32 characters or more, as [Managing a running rack](docs/guides/managing.md#who-can-connect) describes.
