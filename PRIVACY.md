# Maitri Annotations — Privacy Policy

Last updated: 29 September 2026

Maitri Annotations is a Chrome extension used internally by the Maitri Services team. It lets a
developer click elements on the web app they are building, write feedback about them, and send that
feedback to the team's own annotation server, where their AI coding agent reads it and makes the
change. This policy explains what the extension handles and where it goes.

## What the extension collects

- **Annotations you create.** Your comment, the page URL, details about the element you clicked
  (its selector, tag, classes, text and position, plus a little of the surrounding page structure),
  any design changes you make in the annotation panel, and your browser window size.
- **Screenshots of the annotated element**, only if the Screenshots setting is on, plus any image
  you attach to an annotation yourself.
- **Your name and work email address**, when you sign in with Google. They are used to show who
  made each annotation and to let only you and your coding agent change your annotations.
- **Sign-in information**: the address of your team's annotation server and the session token that
  server issues to the extension.
- **Extension settings** such as pin colour, keyboard shortcut and which sites you enabled.

The extension does not collect browsing history, keystrokes outside the annotation panel, form
contents, passwords, payment information, location, or analytics of any kind.

## Where the data goes

- **In your browser.** Annotations, settings, the server address and the session token are kept in
  the extension's local storage (`chrome.storage.local`) on your computer.
- **To your team's annotation server.** Annotations, attached images and screenshots are sent only
  to the server address configured in the extension. For Maitri this is a server run by Maitri
  Services on its private network. It is not operated by the extension's authors or any third
  party.
- **To Google, for sign-in only.** When you click **Sign in with Google**, Chrome asks Google for a
  short-lived access token with the `openid`, `email` and `profile` scopes. The extension sends that
  token once to the team's annotation server, which asks Google to confirm your name and email, checks
  that the account belongs to `maitriservices.com`, and then issues its own session token. The
  server does not keep the Google access token. Google's handling of your sign-in is covered by the
  [Google Privacy Policy](https://policies.google.com/privacy).

The extension does not send data anywhere else, does not sell or share data with third parties,
does not use it for advertising, and does not use it to determine creditworthiness or for lending.

## How long it is kept

- Annotations stay on the team server until you or your coding agent delete them. Agents delete an
  annotation once they have implemented it. Deleting an annotation also deletes its images.
- Extension session tokens expire after 7 days unless the extension renews them while you use it.
  Tokens you create for Claude Code last until you revoke them on the extension's setup page.
- Signing out removes the session token from your browser and revokes it on the server.
- When someone leaves the team, an administrator removes their account and all of their tokens
  from the server.
- Uninstalling the extension deletes everything it stored in your browser.

## Security

The team server stores only hashes of session tokens, never the tokens themselves. Sign-in is limited
to verified `@maitriservices.com` Google accounts. The server is reachable only on Maitri's private
network.

## Your choices

- Leave the Screenshots setting off to stop element screenshots from being sent.
- Enable the extension only on the sites you want to annotate. It runs on local development
  addresses by default and asks before running anywhere else.
- Sign out or revoke any token from the extension's setup page at any time.
- Ask the team administrator to delete your account and annotations from the server.

## Changes and contact

If this policy changes, the updated version will be published at this address with a new date.
Questions or requests: open an issue at
https://github.com/brthapa-maitri/vibe-annotations/issues or contact the Maitri Services team
administrator.
