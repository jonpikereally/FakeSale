# FakeSale error codes

Every problem FakeSale can show you has a code like `FS-301`. Find yours below.

**Getting help from an AI assistant:** click **Copy Error Details** on the error, then paste it into ChatGPT, Claude or similar along with a link to this page. For a plain-text copy that's easy for AI assistants to read, use https://raw.githubusercontent.com/jonpikereally/FakeSale/main/ERRORS.md

Codes are grouped: `1xx` updates, `2xx` reading product pages, `3xx` saved data, `4xx` backup import/export, `999` anything else. Codes are never reused or renumbered.

| Code | What happened | What to try |
|---|---|---|
| `FS-101` | FakeSale couldn't reach the update feed. | Check your internet connection. If you set a custom Update source in Settings, make sure the URL is right, or clear it. |
| `FS-102` | The update feed answered, but not with a valid `latest.json`. | Clear the Update source in Settings to go back to the built-in GitHub feed. If you're already on the built-in feed, open an issue. |
| `FS-201` | The page reader crashed while looking at a product page. The page itself is unaffected. | Copy the details and open an issue with the page link so the detector can be fixed for that store. |
| `FS-202` | A product price was found but saving the visit failed. | Reload the page. If it keeps happening, copy the details and open an issue. |
| `FS-203` | The grid reader failed on a search, category or collection page (only when "Log items on listing pages" is on). | Product pages still work. Copy the details and open an issue with the page link. |
| `FS-301` | FakeSale couldn't read your saved price history. | Restart Brave. If it persists, try Settings → Export backup, then copy the details. |
| `FS-302` | Saving a change to your price history failed, often because the disk is full. | Free some disk space and try again. |
| `FS-401` | The file you chose to import isn't a FakeSale backup. | Choose a `.json` file made by FakeSale's Export backup button. |
| `FS-402` | Creating the backup file failed. | Try again. If it repeats, copy the details and open an issue. |
| `FS-999` | Something unexpected went wrong. | Copy the details and paste them into an AI assistant with a link to this page, or open an issue. |
