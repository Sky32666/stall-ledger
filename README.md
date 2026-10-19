# Stall Ledger

A phone-first web app for a hawker stall: daily close, item sales, stock and a monthly profit & loss. On iPhone, open it in Safari and use **Add to Home Screen** to run it like an app.

- **Close**: photograph the POS end-of-day (Z) report. The phone reads it for free with Tesseract.js (no API key) and fills in total sales, cash, NETS/card, PayNow/QR, delivery apps, order count and, if the report lists them, items sold. Check the numbers and save; the photo is kept with the day.
- **Items sold**: quantity and sales per dish for each day, typed in or read from the report. Dish names and prices are remembered for next time.
- **Stock**: stock in (quantity, total price, supplier), counts and write-offs, with low-stock alerts.
- **Report**: sales − food purchases = gross profit, minus rent, wages, utilities and other expenses = net profit. Also item sales ranking, daily sales, best days of the week, payment mix and purchases by supplier. Export to CSV for Excel or the accountant.

Data is stored in Supabase in tables prefixed `ledger_`, separate from the POS tables. Only emails on the allow-list can sign in and see anything.

## One-time setup (Supabase)

1. **Create the tables**: Supabase → SQL Editor → paste all of [`supabase/migrations/20261021_stall_ledger.sql`](supabase/migrations/20261021_stall_ledger.sql) → Run. The script is safe to run again after an update.
2. **Turn off public sign-up**: Authentication → Sign In / Providers → Email → turn off *Allow new users to sign up*. (Even if left on, people not on the allow-list see no data.)
3. **Add a user**: Authentication → Users → *Add user* → *Create new user*, enter email and password, tick *Auto Confirm User*.
4. **Add them to the allow-list**: in SQL Editor run
   ```sql
   insert into ledger_members (email) values ('sister@example.com');
   ```

## Deploying

The folder is a static site with no server code. It is served by GitHub Pages from this repo; any static host works. It must be served over **https** for Add to Home Screen and offline loading.

`config.js` holds only the Supabase URL and the **publishable (anon) key**, which is public by design. **Never** put the service_role key in it.

## Install on iPhone

Open the site in Safari → Share → **Add to Home Screen**. Sign in once; it stays signed in.

## Development

```bash
python3 -m http.server 8766
node --test tests
```

Report reading rules live in [`ocr.js`](ocr.js). If your POS prints different words (for example "Nett Amt"), add them to `TOTAL_KEYS` or `CATEGORIES` and add an example to `tests/ocr.test.mjs`.
