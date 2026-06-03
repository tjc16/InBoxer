# 📬 InBoxer

**Your inbox, finally organised.** InBoxer reviews and organises any email inbox.
It connects over **IMAP**, so it works with virtually every provider — Gmail,
Outlook/Office 365, Yahoo, iCloud, AOL, Fastmail, Zoho, and anything that speaks
IMAP. Categorisation is **100% rule-based**: no AI API, no key, no cost.

## What it does

1. **Scan** your whole inbox (up to 100,000 emails) over IMAP — or click
   **Try the live demo** for realistic sample data and a guided walkthrough, no
   credentials needed. Results stream in live with a progress bar.
2. **Review the plan** — InBoxer proposes a folder taxonomy (subfolders under an
   `InBoxer/` parent), an analysis of every list you can **mass-unsubscribe** from,
   and the **junk** it will stage for deletion. You tweak the parent name, toggle
   any folder on/off, and decide whether to stage junk.
3. **Confirm & sort** — InBoxer creates the folders **permanently** in your inbox
   and files everything away. Junk is moved to an `InBoxer/Junk (review & delete)`
   folder so *you* can delete it. InBoxer **never deletes a single email**.

You can also **Browse emails in detail** at any time: a dashboard that classifies
each email with a priority, a suggested action, and the *reasons* behind it, plus
bulk mark-as-read and move.

### Three-tier taxonomy

Every email is sorted on two axes. **Disposition → Group → Category** decides
*where it goes*; cross-cutting **flags** (priority, unsubscribe-able) decide
*what you can do with it*.

```
📂 File      (keep & organise)   People · Work · Finance · Shopping · Travel ·
                                 Accounts · Personal Admin · Reading  → ~24 categories
⏳ Hold      (act soon)          To Respond · Awaiting Reply · Meetings · Bills Due ·
                                 In Transit · Upcoming Travel · Security & Codes · Reminders
🧹 Clean up  (review & delete)   Promotions · Newsletters · Social · Notifications ·
                                 Expired · Likely Spam
❓ Unsorted  (left in Inbox)     anything the engine can't identify confidently
```

Disposition is **time-aware**: a Hold item graduates to `Clean up / Expired` once
its window passes (an OTP after a day, a meeting invite after two weeks, an
in-transit parcel after a fortnight). The engine ([`categorize.js`](categorize.js))
uses sender-domain knowledge (banks, GitHub, Slack, airlines, social networks…),
header signals (`List-Unsubscribe`, `List-Unsubscribe-Post`, `Precedence`) and
keyword matching, and records the *reasons* + a confidence level for each decision.

### Dynamic folders

Folders are proposed **per scan** and only when warranted: a dedicated category
folder needs ≥ 5 emails, a File group needs ≥ 3 — otherwise mail rolls up to the
group or disposition folder. A tidy inbox yields a handful of folders; a chaotic
one, dozens. You review the tree, untick anything, then confirm.

### One-click mass unsubscribe

InBoxer groups every unsubscribe-able sender and unsubscribes in bulk
([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)): an HTTP `POST
List-Unsubscribe=One-Click` where supported, a GET fallback otherwise, and an
SMTP-sent message for `mailto:`-only lists — no inbox tab-storm.

## Built for scale

InBoxer **streams** through the inbox in batches (newest first) over a
newline-delimited JSON response, with a live progress bar — so it comfortably
handles **tens of thousands of emails** without freezing. Set the scan size in
**Advanced** (up to 50,000). The list itself renders in pages with "Load more"
to keep the UI snappy.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Click **Try the live demo** for a full, guided walkthrough with no setup.

## Getting an app password

Gmail, Outlook, and Yahoo block your normal password over IMAP. With 2-factor
authentication enabled, create an **app password** and paste that in:

- **Gmail** → Google Account → Security → App passwords
- **Outlook** → Microsoft Account → Security → Advanced → App passwords
- **Yahoo** → Account Security → Generate app password

For other providers your normal IMAP password usually works. If auto-detection
can't find the host, set it manually under **Advanced**.

## Privacy

Credentials live only in the browser tab's memory for the session and are sent
to the local server with each request to talk to your provider. They are
**never** written to disk, logged, or stored. Email content stays between your
machine and your provider.

## Tech

Node.js · Express · `imap-simple` · `mailparser`. The categoriser and demo data
generator are self-contained modules ([`categorize.js`](categorize.js),
[`demo-data.js`](demo-data.js)). The front-end is dependency-free vanilla JS.

## Notes & limits (MVP)

- Folders are created under a parent (default `InBoxer/`). On Gmail, IMAP folders
  appear as labels. The hierarchy delimiter is detected from the server.
- Clean-up mail is **moved, never deleted** — review the folder and delete yourself.
- **Mass unsubscribe** performs real RFC-8058 one-click HTTP requests and SMTP
  `mailto:` sends server-side. Some senders only honour an interactive confirmation
  page; those are reported back so you can finish them manually.
- The **Donate** button is a UI skeleton — Stripe / payment gateway to be added.
- Categorisation reads headers + subject (not full bodies) — fast and private,
  but very generic subjects may land in "Other" (kept in Inbox).
- Demo mode performs all actions in the browser only; nothing leaves your machine.
