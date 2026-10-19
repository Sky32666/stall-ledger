# Stall Ledger

A phone-first web app for a hawker stall: daily close, item sales, stock and a monthly profit & loss. On iPhone, open it in Safari and use **Add to Home Screen** to run it like an app.

- **Close**: photograph the POS end-of-day (Z) report. The phone reads it for free with Tesseract.js (no API key) and fills in total sales, cash, NETS/card, PayNow/QR, delivery apps, order count and, if the report lists them, items sold. Check the numbers and save; the photo is kept with the day.
- **Items sold**: quantity and sales per dish for each day, typed in or read from the report. Dish names and prices are remembered for next time.
- **Stock**: stock in (quantity, total price, supplier), counts and write-offs, with low-stock alerts.
- **Recipes**: set what one portion of each dish uses (e.g. Chicken Chop = 1 pcs chicken chop + 0.15 kg fries). When a day's items sold are saved, those ingredients come off stock automatically. Editing and re-saving a day only applies the difference, so nothing is taken off twice. When you count stock, any gap from the system figure is real loss (waste, portions, theft).
- **Report**: sales − food purchases = gross profit, minus rent, wages, utilities and other expenses = net profit. Also item sales ranking, daily sales, best days of the week, payment mix and purchases by supplier. Export to CSV for Excel or the accountant.

Data is stored in Supabase in tables prefixed `ledger_`, separate from the POS tables. Anyone can create an account, but only approved members can see or change anything. A new account waits on an approval screen until an owner approves it in **Settings → People**.

## One-time setup (Supabase)

1. **Create the tables**: Supabase → SQL Editor → paste all of [`supabase/migrations/20261021_stall_ledger.sql`](supabase/migrations/20261021_stall_ledger.sql) → Run. The script is safe to run again after an update.
2. **Make yourself the owner**: create your account on the site first (or in Authentication → Users), then run in SQL Editor:
   ```sql
   insert into ledger_members (email, role) values ('you@example.com', 'owner')
   on conflict (email) do update set role = 'owner';
   ```
3. **Point confirmation emails at the site**: Authentication → URL Configuration → set *Site URL* to `https://sky32666.github.io/stall-ledger/` and add the same address under *Redirect URLs*. Otherwise the link in the sign-up email opens `localhost`.
4. Leave Authentication → Sign In / Providers → Email → *Allow new users to sign up* **on**, and *Confirm email* **on** (people must prove they own the email).

After that, staff sign themselves up on the site and you approve them under Settings → People.

> This Supabase project also holds the POS tables. With sign-up open, anyone can get a signed-in account, so POS rules that let in *any* signed-in user (for example the `notices` table) need tightening.

## Deploying

The folder is a static site with no server code. It is served by GitHub Pages from this repo; any static host works. It must be served over **https** for Add to Home Screen and offline loading.

`config.js` holds only the Supabase URL and the **publishable (anon) key**, which is public by design. **Never** put the service_role key in it.

## Install on iPhone

Open the site in Safari → Share → **Add to Home Screen**. Create an account or sign in once; it stays signed in.

## Development

```bash
python3 -m http.server 8766
node --test tests
```

Report reading rules live in [`ocr.js`](ocr.js). If your POS prints different words (for example "Nett Amt"), add them to `TOTAL_KEYS` or `CATEGORIES` and add an example to `tests/ocr.test.mjs`.
