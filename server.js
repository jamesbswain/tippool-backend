import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import {
  runMigrations, createCut, closeCut,
  getCutByCode, listAllocations, markAllocationStatus, upsertValet
} from './db.js';

const app = express();
app.use(express.json());

const {
  PORT = 8787,
  ADMIN_TOKEN,
  STRIPE_SECRET_KEY,
  CURRENCY = 'usd'
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY missing. Set it in .env');
}

const stripe = new Stripe(STRIPE_SECRET_KEY || 'sk_test_xxx', { apiVersion: '2023-10-16' });

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

runMigrations();

app.get('/health', (req, res) => res.json({ ok: true }));

// Map a valet to their connected account
app.post('/valets/upsert', requireAdmin, (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    stripe_account_id: z.string().min(5)
  });
  const data = schema.parse(req.body);
  upsertValet(data);
  res.json({ ok: true });
});

// Create Express account + onboarding link (optional helper)
app.post('/valets/invite', requireAdmin, async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    name: z.string().min(1)
  });
  const { email, name } = schema.parse(req.body);

  const account = await stripe.accounts.create({
    type: 'express',
    email,
    capabilities: { transfers: { requested: true } },
    business_type: 'individual',
    business_profile: { product_description: 'Valet tip payouts' }
  });

  const link = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: 'https://example.com/onboarding/refresh',
    return_url: 'https://example.com/onboarding/complete',
    type: 'account_onboarding'
  });

  res.json({ account_id: account.id, onboarding_url: link.url });
});

// Open a cut
app.post('/cuts/open', requireAdmin, (req, res) => {
  const schema = z.object({
    cut_code: z.string().min(3),
    shift_id: z.string().min(1),
    date: z.string().min(1),
    start_time: z.string().min(1),
    roster_text: z.string().min(1),
    notes: z.string().optional()
  });
  const data = schema.parse(req.body);
  const id = createCut(data);
  res.json({ ok: true, cut_id: id });
});

// Close a cut
app.post('/cuts/close', requireAdmin, (req, res) => {
  const schema = z.object({
    cut_code: z.string().min(3),
    end_time: z.string().min(1),
    tips_dollars: z.number().nonnegative()
  });
  const { cut_code, end_time, tips_dollars } = schema.parse(req.body);
  const tips_cents = Math.round(tips_dollars * 100);
  const updated = closeCut({ cut_code, end_time, tips_cents });
  const allocations = listAllocations(updated.id);
  res.json({ ok: true, cut: updated, allocations });
});

// Execute transfers to connected accounts
app.post('/transfers/execute', requireAdmin, async (req, res) => {
  const schema = z.object({
    cut_code: z.string().min(3),
    memo: z.string().optional()
  });
  const { cut_code, memo } = schema.parse(req.body);

  const cut = getCutByCode(cut_code);
  if (!cut) return res.status(404).json({ error: 'Cut not found' });
  if (cut.status !== 'closed') return res.status(400).json({ error: 'Cut must be closed' });

  const allocs = listAllocations(cut.id);
  const results = [];

  for (const alloc of allocs) {
    try {
      if (!alloc.stripe_account_id) {
        results.push({ allocation_id: alloc.id, status: 'skipped', reason: 'No connected account' });
        continue;
      }
      if (alloc.payout_cents <= 0) {
        results.push({ allocation_id: alloc.id, status: 'skipped', reason: 'Zero amount' });
        continue;
      }
      const transfer = await stripe.transfers.create({
        amount: alloc.payout_cents,
        currency: CURRENCY,
        destination: alloc.stripe_account_id,
        metadata: { cut_code, valet_name: alloc.valet_name, memo: memo || '' }
      });
      markAllocationStatus(alloc.id, 'transferred');
      results.push({ allocation_id: alloc.id, status: 'transferred', transfer_id: transfer.id });
    } catch (err) {
      console.error(err);
      markAllocationStatus(alloc.id, 'failed');
      results.push({ allocation_id: alloc.id, status: 'failed', error: err.message });
    }
  }

  res.json({ ok: true, results });
});

app.listen(process.env.PORT || 8787, () => {
  console.log(`TipPool backend running on :${process.env.PORT || 8787}`);
});
