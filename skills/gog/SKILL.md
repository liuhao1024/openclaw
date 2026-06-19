---
name: gog
description: "Google Workspace CLI for Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Contacts, Tasks, People, YouTube, Maps, Photos, Analytics, Search Console, and more."
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "openclaw/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog (brew)",
            },
          ],
      },
  }
---

# gog

Use `gog` for Google Workspace services. Requires OAuth setup.

Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

## Gmail

Docs: [Gmail workflows](https://gogcli.sh/gmail-workflows.html), [Gmail watch](https://gogcli.sh/watch.html).

- Search: `gog gmail search 'newer_than:7d' --max 10`
- Messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Send draft: `gog gmail drafts send <draftId>`
- Reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Export filters: `gog gmail settings filters export --out filters.xml`
- Hard block sends: `gog --gmail-no-send gmail drafts create --to you@example.com --subject test`

## Calendar

Docs: [`gog calendar`](https://gogcli.sh/commands/gog-calendar.html), [Zoom setup](https://gogcli.sh/zoom-auth-setup.html).

- List events: `gog calendar events --today`
- Create event: `gog calendar create primary --summary "Title" --from <iso> --to <iso>`
- Create with color: `gog calendar create primary --summary "Title" --from <iso> --to <iso> --event-color 7`
- Create with Meet: `gog calendar create primary --summary "Title" --from <iso> --to <iso> --with-meet`
- Create with Zoom: `gog calendar create primary --summary "Title" --from <iso> --to <iso> --with-zoom`
- Update event: `gog calendar update primary <eventId> --summary "New Title" --event-color 4`
- Move event: `gog calendar move primary <eventId> team-calendar@example.com`
- Show colors: `gog calendar colors`
- Create calendar: `gog calendar create-calendar "Project calendar" --timezone Europe/London`
- Delete calendar: `gog calendar delete-calendar <calendarId> --force`
- Subscribe: `gog calendar subscribe en.uk#holiday@group.v.calendar.google.com`
- Unsubscribe: `gog calendar unsubscribe en.uk#holiday@group.v.calendar.google.com --force`

## Drive

Docs: [Drive audits](https://gogcli.sh/drive-audits.html), [polling](https://gogcli.sh/polling.html), [raw API](https://gogcli.sh/raw-api.html).

- Search: `gog drive search "query" --max 10`
- Get file: `gog drive get <fileId> --fields 'id,name,mimeType,size,owners' --json`
- Folder tree: `gog drive tree --parent <folderId> --depth 2`
- Disk usage: `gog drive du --parent <folderId> --max 20 --json`
- Share: `gog drive share <fileId> --to user --email person@example.com --notify --dry-run`
- Sharing audit: `gog drive audit sharing --parent <folderId> --internal-domain example.com --json`
- Bulk remove public: `gog drive bulk remove-public --parent <folderId> --dry-run`
- Labels: `gog drive labels list --json`
- File labels: `gog drive labels file list <fileId> --json`
- Changes: `gog drive changes list --token <token> --json`
- Revisions: `gog drive revisions list <fileId> --all --json`
- Activity: `gog drive activity query --file <fileId> --actions edit,share --from 2026-01-01T00:00:00Z --json`
- Raw API: `gog drive raw <fileId> --pretty`

## Docs

Docs: [Docs editing](https://gogcli.sh/docs-editing.html), [sed-style edits](https://gogcli.sh/sedmat.html).

- Export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Cat: `gog docs cat <docId>`
- Write: `gog docs write <docId> --append --markdown --text '## Status'`
- Format: `gog docs format <docId> --match Status --bold --font-size 18`
- Find-replace: `gog docs find-replace <docId> old new --dry-run`
- Insert table: `gog docs insert-table <docId> --rows 3 --cols 2 --at-end`
- Insert image: `gog docs insert-image <docId> --url https://example.com/chart.png --at end`
- Comments poll: `gog docs comments poll <docId> --state-file ~/.local/state/gog/doc-comments.json --json`

## Sheets

Docs: [Sheets batch](https://gogcli.sh/sheets-batch-update.html), [Sheets tables](https://gogcli.sh/sheets-tables.html), [Sheets formatting](https://gogcli.sh/sheets-formatting.html).

- Get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Metadata: `gog sheets metadata <sheetId> --json`
- Batch update: `gog sheets batch-update <sheetId> --data-json @updates.json --json`
- Table list: `gog sheets table list <sheetId>`
- Validation: `gog sheets validation set <sheetId> 'Sheet1!B2:B100' --type ONE_OF_LIST --value Open --value Done`
- Conditional format: `gog sheets conditional-format add <sheetId> 'Sheet1!A2:A100' --type text-contains --expr blocked --format-json '{"backgroundColor":{"red":1,"green":0.84,"blue":0.84}}'`

## Slides

Docs: [Slides from Markdown](https://gogcli.sh/slides-markdown.html), [template replacement](https://gogcli.sh/slides-template-replacement.html).

- Create from markdown: `gog slides create-from-markdown "Weekly update" --content-file slides.md`
- Info: `gog slides info <presentationId> --json`
- Locate text: `gog slides locate <presentationId> "Quarterly revenue" --all --json`
- Style text: `gog slides style-text <presentationId> <objectId> --range 0:12 --bold --size 24`
- Replace text: `gog slides replace-text <presentationId> old new --object <objectId>`
- Insert table: `gog slides table create <presentationId> <slideId> --rows 2 --cols 3`
- New slide: `gog slides new-slide <presentationId> --layout TITLE_AND_BODY --index 1`
- Insert image: `gog slides insert-image <presentationId> <slideId> chart.png --x 24 --y 24 --width 240`

## Forms

Docs: [`gog forms`](https://gogcli.sh/commands/gog-forms.html).

- Update: `gog forms update <formId> --quiz=true`
- Add question: `gog forms add-question <formId> --title "What is 2+2?" --type radio -o 1 -o 4 --correct 4 --points 1`
- Publish: `gog forms publish <formId>`
- Responses: `gog forms responses list <formId> --json`

## Contacts

Docs: [contacts dedupe](https://gogcli.sh/contacts-dedupe.html), [JSON updates](https://gogcli.sh/contacts-json-update.html).

- List: `gog contacts list --max 20`
- Search: `gog contacts search alice --json`
- Export: `gog contacts export --all --out contacts.vcf`
- Dedupe preview: `gog contacts dedupe --json`
- Dedupe apply: `gog contacts dedupe --apply`

## Tasks and People

- Tasks list: `gog tasks list --json`
- Tasks create: `gog tasks create --title "Review PR" --due <iso>`
- People search: `gog people search "Alice" --json`

## YouTube

Docs: [YouTube workflows](https://gogcli.sh/youtube.html).

Setup: `gog config set youtube_api_key YOUR_API_KEY` (for API-key reads) or `gog auth add you@gmail.com --services youtube` (for OAuth).

- Channels: `gog yt channels list --id UC_x5XG1OV2P6uZZ5FSM9Ttw --json`
- Videos: `gog yt videos list --chart mostPopular --region US --max 5`
- Activities: `gog yt activities list --mine -a you@gmail.com`
- Subscriptions: `gog yt subscriptions list --all -a you@gmail.com`
- Playlists: `gog yt playlists list --mine -a you@gmail.com`
- Create playlist: `gog yt playlists create --title "Research" -a you@gmail.com`

## Maps

Docs: [`gog maps`](https://gogcli.sh/commands/gog-maps.html).

- Places search: `gog maps places search "Elysian Coffee Vancouver" --json`
- Places details: `gog maps places details <placeId> --json`
- Directions: `gog maps directions --origin "Vancouver, BC" --destination "Seattle, WA" --json`
- Distance: `gog maps distance --origins "Vancouver BC" --destinations "Seattle WA" --json`
- Geocode: `gog maps geocode "1600 Amphitheatre Parkway, Mountain View, CA" --json`
- Reverse geocode: `gog maps reverse-geocode --lat=37.422 --lng=-122.084 --json`

## Photos

Docs: [`gog photos`](https://gogcli.sh/commands/gog-photos.html), [Photos Picker](https://gogcli.sh/photos-picker.html).

Requires `photoslibrary.readonly.appcreateddata` scope. Enable Photos Library API on the OAuth project.

- List: `gog photos list --json`
- Search: `gog photos search --media-type PHOTO --from 2026-01-01 --to 2026-01-31 --json`
- Download: `gog photos download <mediaItemId> --out photo.jpg`
- Picker create: `gog photos picker create --max-items 20 --open --json`
- Picker wait: `gog photos picker wait <sessionId> --json`

## Analytics and Search Console

- Analytics accounts: `gog analytics accounts --all --json`
- Analytics report: `gog analytics report 123456789 --from 7daysAgo --to today --dimensions date,country --metrics activeUsers,sessions`
- Search Console sites: `gog searchconsole sites`
- Search Console query: `gog searchconsole query sc-domain:example.com --from 2026-02-01 --to 2026-02-07 --dimensions query,page`

## Backup

Docs: [Backup](https://gogcli.sh/backup.html).

- Init: `gog backup init --repo ~/Backups/gog`
- Push: `gog backup push --services gmail,calendar,contacts,drive`
- Verify: `gog backup verify`

## Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.

Example (plain text via stdin):

```bash
gog gmail send --to recipient@example.com \
  --subject "Meeting Follow-up" \
  --body-file - <<'EOF'
Hi Name,

Thanks for meeting today. Next steps:
- Item one
- Item two

Best regards,
Your Name
EOF
```

## Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy/write/format/find-replace. In-place edits use the Docs API directly.
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
- Use `gog calendar colors` to see all available event colors (IDs 1-11).
- Google Calendar appointment schedules are not exposed by the Calendar API.
