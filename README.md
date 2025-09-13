# TipPool Backend (starter)

Stores **cuts**, computes equal splits, and sends **Stripe Connect transfers**.

## Setup
1) `npm install`
2) `cp .env.example .env` and edit with your Stripe **TEST** secret key
3) `npm run init:db`
4) `npm run dev`

## Admin header
Use: `x-admin-token: <ADMIN_TOKEN>` for POSTs.

## API
- `POST /valets/upsert` { name, email, stripe_account_id }
- `POST /valets/invite` { name, email } -> returns onboarding_url
- `POST /cuts/open` { cut_code, shift_id, date, start_time, roster_text }
- `POST /cuts/close` { cut_code, end_time, tips_dollars }
- `POST /transfers/execute` { cut_code, memo? }
