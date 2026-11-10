# Access and sharing

Who can open the library and how: accounts, share links, the internet tunnel, backup, the administrator's settings, and what to keep in mind about passwords and links.

[← README](../README.md) · [Reading](reading.md) · [The library](library.md) · [Scanned books](scans.md) · [Access and sharing](access.md) · [Plugins](plugins.md)

## Accounts

The first administrator is created on the computer that runs the server; readers can create their own accounts (optional, from the local network). Passwords are argon2id hashes, sessions are random cookies stored hashed, repeated failed logins are slowed down

## Share links with a QR code

`/s/<token>` opens exactly one book, optionally at an exact view, with no sign-in; a link can expire and be revoked

## Internet access

Through a Cloudflare quick tunnel (embedded `cloudflared`, no account or port forwarding). The tunnel enters through a separate loopback listener, so a request is known to come from the internet by the socket it arrived on, not by a header; over the tunnel the library always needs sign-in, and the first-run setup and self-registration are refused

## Backup and restore

Administrator only, in Settings (also offered on the first-run screen of a new computer): one JSON file with the accounts, bookmarks, projects with their items, reading places, how each reader likes to see their books (turn, crop and page numbers), the book details and tags the administrator typed, share links and settings. Passwords are in it only as argon2id hashes, so the same passwords work after a restore, but the file should be kept private, since the share links in it are live. Books, covers and the search index are not included (they are rebuilt from the library folder) and neither is the library folder's path, which belongs to each computer. A restore replaces all accounts, bookmarks, projects and links (a backup made before projects existed leaves everybody without projects), signs everybody out, and keeps the administrator who did it signed in when the backup has an account of that name; a file that is not a valid backup is refused and changes nothing

## Settings

For the administrator: library folder, who may browse on the local network, internet tunnel, accounts

## About the program

**About** beside "Developed by" at the foot of the left panel opens a window with the version (read from `package.json`, so it is the release's), the licence, links to the site, the source and the issues page, the parts the program is built from with their licences, a button that copies the version and the browser for a report of a problem, and, for the administrator only, the folder with the program's own files (`/api/about`). The program makes no connection to the internet by itself

## Languages

Interface in English, Russian and Ukrainian

## Notes on access

- On the local network the page is plain HTTP, so a password typed there travels unencrypted inside your network. Over the internet tunnel it is HTTPS.
- Whoever has a share link can read that book: treat it like a key. Links can be limited in time and revoked under **My links**.
- A quick-tunnel address changes every time the tunnel starts, so a QR code printed from an internet link stops working after a restart. (Local-network links keep working as long as the computer's address does.)
- A forgotten administrator password: on the sign-in page (local network only) choose **Forgot the administrator password?** and ask for a code. The server writes it into `reset-code.txt` in the data folder, where only someone with access to the computer can read it; type it back with the administrator's name and a new password (fifteen minutes, one use; five wrong tries from one visitor lock that visitor out for a minute, thirty from everybody burn the code). The reset signs that account out everywhere and the file is removed. Other accounts' passwords are set by an administrator in Settings.

