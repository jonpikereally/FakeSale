// Every error a user can see has a stable code. Never reuse or renumber.
// The public list lives in ERRORS.md; scripts/check-errors.sh fails the
// build if a code used in src/ is missing from it.
//   1xx updates   2xx page detection/logging   3xx saved data
//   4xx import/export   999 unexpected

export const REPO = "jonpikereally/FakeSale";
export const ERROR_LIST_URL = `https://github.com/${REPO}/blob/main/ERRORS.md`;
export const ERROR_LIST_RAW = `https://raw.githubusercontent.com/${REPO}/main/ERRORS.md`;
export const ERROR_HOVER = `Look this code up on the FakeSale error list: ${ERROR_LIST_URL}`;

export const ERRORS = {
  "FS-101": ["Couldn't reach the update feed.", "Check your internet connection, or the Update source in Settings."],
  "FS-102": ["The update feed returned something unreadable.", "Clear the Update source in Settings to go back to the built-in feed."],
  "FS-201": ["Something went wrong while reading a product page.", "The page still works. Copy the details and open an issue with the page link."],
  "FS-202": ["A product page was found but couldn't be saved.", "Reload the page. If it keeps happening, copy the details."],
  "FS-203": ["Something went wrong while reading the items on a search or category page.", "Product pages still work. Copy the details and open an issue with the page link."],
  "FS-301": ["Couldn't read your saved price history.", "Restart Brave. If it persists, export a backup and copy the details."],
  "FS-302": ["Couldn't save a change to your price history.", "Your disk may be full. Free some space and try again."],
  "FS-401": ["That file isn't a FakeSale backup.", "Choose a .json file made by FakeSale's Export button."],
  "FS-402": ["Couldn't create the backup file.", "Try again; if it repeats, copy the details."],
  "FS-999": ["Something unexpected went wrong.", "Copy the details and paste them into an AI assistant along with the error list link."],
};

export function describe(code) {
  const [summary, hint] = ERRORS[code] || ERRORS["FS-999"];
  return { code: ERRORS[code] ? code : "FS-999", summary, hint };
}

export function detailsText(err, version) {
  const d = describe(err.code);
  return [
    `FakeSale error ${d.code}: ${d.summary}`,
    `What to try: ${d.hint}`,
    err.details ? `Details: ${err.details}` : null,
    `When: ${new Date(err.t || Date.now()).toISOString()}`,
    `FakeSale version: ${version}`,
    `Browser: ${navigator.userAgent}`,
    `Error list: ${ERROR_LIST_URL}`,
    `Error list (plain text for AI assistants): ${ERROR_LIST_RAW}`,
  ].filter(Boolean).join("\n");
}
