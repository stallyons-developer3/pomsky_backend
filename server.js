const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();

// const cors = require('cors');

// Staging/preview origins are supplied per-environment so they never need to be
// committed here. Comma-separated, e.g. EXTRA_CORS_ORIGINS=https://my-copy.webflow.io,http://localhost:8080
const extraOrigins = (process.env.EXTRA_CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: [
    'https://pomsky-association.webflow.io',
    'https://pomskyownersassociation.com',
    'https://www.pomskyownersassociation.com',
    ...extraOrigins
  ],
  credentials: true
}));

// Body parsing middleware MUST come before routes
app.use(cookieParser());
app.use('/webhook', require('./routes/webhooks'));
app.use(express.json());

// Stripe/webhook routes are disabled until Stripe is configured
// app.use('/webhook', require('./routes/webhooks'));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.use('/membership', require('./routes/membership'));
app.use('/user', require('./routes/user'));
app.use('/admin', require('./routes/admin'));
app.use('/listings', require('./routes/listings'));
app.use('/payments', require('./routes/payments'));
app.use('/breeder', require('./routes/breeder'));

app.listen(3000, () => console.log('Server running on port 3000'));
