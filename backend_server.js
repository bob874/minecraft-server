// Simple Express backend (Node 18+). Install: express, pg, bcrypt, jsonwebtoken, stripe, axios, dotenv, body-parser
// usage: node server.js (after npm install and setting .env)
const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Stripe = require('stripe');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    // preserve raw body for Stripe signature verification on webhook route
    req.rawBody = buf;
  }
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

// helper: auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'missing token' });
  const token = auth.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid token' });
  }
}

// register
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).send({ error: 'email & password required' });
  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, created_at) VALUES ($1,$2,NOW()) RETURNING id,email',
    [email, hash]
  );
  const user = result.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// create Stripe Checkout Session for paid plan
app.post('/api/checkout', authMiddleware, async (req, res) => {
  const { plan } = req.body; // e.g., 'plan_2gb'
  // map plan to price id in Stripe dashboard
  const priceMap = {
    plan_2gb: process.env.STRIPE_PRICE_2GB,
    plan_4gb: process.env.STRIPE_PRICE_4GB
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: 'invalid plan' });

  // create or retrieve stripe customer
  const userRow = await pool.query('SELECT stripe_customer_id FROM users WHERE id=$1', [req.user.id]);
  let customerId = userRow.rows[0].stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email });
    customerId = customer.id;
    await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, req.user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: process.env.FRONTEND_URL + '/dashboard?checkout=success',
    cancel_url: process.env.FRONTEND_URL + '/dashboard?checkout=cancelled',
    metadata: { userId: req.user.id, plan }
  });

  res.json({ url: session.url });
});

// Stripe webhook to listen to checkout.session.completed
app.post('/api/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan;
    // record payment
    await pool.query(
      'INSERT INTO payments (user_id, stripe_payment_intent, amount, currency, status, created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
      [userId, session.payment_intent || null, session.amount_total || null, session.currency || 'usd', 'paid']
    );

    // Provision server via Pterodactyl API
    try {
      const server = await createPterodactylServerForUser(userId, plan);
      await pool.query(
        'INSERT INTO servers (user_id, pterodactyl_server_id, plan, ram_mb, slots, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
        [userId, server.id, plan, server.ram, server.slots, 'running']
      );
    } catch (err) {
      console.error('Provisioning error:', err);
      // optionally alert admin
    }
  }

  res.json({ received: true });
});

// Example Pterodactyl provisioning function
async function createPterodactylServerForUser(userId, plan) {
  // Map plan to resources
  const planMap = {
    plan_2gb: { egg: process.env.PTERO_EGG_ID, ram: 2048, slots: 20 },
    plan_4gb: { egg: process.env.PTERO_EGG_ID, ram: 4096, slots: 40 }
  };
  const cfg = planMap[plan];
  if (!cfg) throw new Error('invalid plan');

  // Get user info for name/email
  const userRes = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
  const email = userRes.rows[0].email;

  // Pterodactyl API create server
  const adminUrl = process.env.PTERO_URL; // e.g., https://panel.yourhost.com
  const adminKey = process.env.PTERO_ADMIN_KEY; // admin API key with appropriate perms

  const payload = {
    name: `mc-${userId}-${Date.now()}`,
    user: 1, // you can create server under admin account or map to a ptero subuser; better: create Pterodactyl user for each customer and then server under that user
    egg: cfg.egg,
    docker_image: 'ghcr.io/pterodactyl/yolks:java-17', // example
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar',
    environment: { 'SERVER_JARFILE': 'server.jar' },
    limits: { memory: cfg.ram, swap: 0, disk: 5000, io: 500, cpu: 0 },
    feature_limits: { databases: 0, allocations: 1 },
    allocate: [{ default: 1, port_range: [] }]
  };

  // POST to /api/application/servers
  const resp = await axios.post(`${adminUrl}/api/application/servers`, payload, {
    headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }
  });
  // resp.data contains server object; adapt to your Pterodactyl version
  return { id: resp.data.attributes.id, ram: cfg.ram, slots: cfg.slots };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));