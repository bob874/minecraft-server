# Minecraft Hosting Starter (local)

This repository contains a minimal backend to:
- Register / login users
- Create Stripe Checkout sessions
- Handle Stripe webhook and provision a Minecraft server via Pterodactyl API

Prerequisites:
- Node 18+, npm
- PostgreSQL
- Stripe account (create price IDs for plans)
- Pterodactyl panel (or mock endpoint) for game-server provisioning

Environment (.env)
```
DATABASE_URL=postgres://user:pass@localhost:5432/mchost
JWT_SECRET=replace_me
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_2GB=price_xxx
STRIPE_PRICE_4GB=price_xxx
PTERO_URL=https://panel.example.com
PTERO_ADMIN_KEY=your_ptero_admin_key
PTERO_EGG_ID=1
FRONTEND_URL=http://localhost:3001
PORT=3000
```

DB schema (example)
```
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  stripe_payment_intent TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE servers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  pterodactyl_server_id TEXT,
  plan TEXT,
  ram_mb INTEGER,
  slots INTEGER,
  status TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
```

Local run
1. npm install
2. Set .env
3. node server.js

Notes:
- The Pterodactyl API payload here is simplified; consult Pterodactyl docs for exact fields and consider creating Pterodactyl users for each customer.
- Secure the admin key; do not expose it to frontend.
- Test Stripe webhooks locally with stripe-cli or using tunneling (ngrok).