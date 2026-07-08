const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { triggerEmailByTag } = require('../utils/activecampaign');

router.get('/dashboard', authMiddleware, async (req, res) => {
  const userId = req.user.id;

  const [profileResult, ordersResult, billingResult,
         shippingResult, paymentResult, historyResult, breederResult] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('billing_addresses').select('*').eq('user_id', userId),
      supabase.from('shipping_addresses').select('*').eq('user_id', userId),
      supabase.from('payment_methods').select('*').eq('user_id', userId),
      supabase.from('membership_history').select('*').eq('user_id', userId).order('started_at', { ascending: false }),
      supabase.from('breeder_profiles').select('id, is_onboarded, is_approved').eq('user_id', userId).maybeSingle()
    ]);

  const profile = profileResult.data;

  res.json({
    name: profile?.full_name || req.user.email,
    email: profile?.email || req.user.email,
    // Multi-role fields
    membership_shopper: profile?.membership_shopper,
    membership_breeder: profile?.membership_breeder,
    membership_owner: profile?.membership_owner,
    status_shopper: profile?.status_shopper,
    status_breeder: profile?.status_breeder,
    status_owner: profile?.status_owner,
    // Legacy fields for compatibility
    account_type: profile?.account_type || 'shopper',
    membership_type: profile?.membership_type || 'shopper_free',
    membership_status: profile?.membership_status || 'active',
    stripe_subscription_id: profile?.stripe_subscription_id || null,
    created_at: profile?.created_at || new Date().toISOString(),
    orders: ordersResult.data || [],
    billing_addresses: billingResult.data || [],
    shipping_addresses: shippingResult.data || [],
    payment_methods: paymentResult.data || [],
    membership_history: historyResult.data || [],
    breeder_id: breederResult.data?.id || null,
    breeder_is_onboarded: breederResult.data?.is_onboarded || false,
    breeder_is_approved: breederResult.data?.is_approved || false
  });
});

router.post('/tag-contact', async (req, res) => {
  const { email, first_name, tag } = req.body;
  
  if (!email || !tag) {
    return res.status(400).json({ error: 'Email and tag are required' });
  }

  try {
    const success = await triggerEmailByTag(email, first_name || '', '', tag);
    if (success) {
      return res.json({ message: 'Contact tagged successfully' });
    } else {
      return res.status(500).json({ error: 'Failed to tag contact' });
    }
  } catch (err) {
    console.error('Public Tag Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;