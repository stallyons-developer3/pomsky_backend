const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const { sendEmail } = require('../utils/email');
const { triggerEmailByTag, triggerMembershipTagById } = require('../utils/activecampaign');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const rateLimit = require('express-rate-limit');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});


// Admin auth middleware
const adminAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.split(' ')[1]) || req.cookies.admin_token;

  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Admin Auth ──

router.post('/setup', async (req, res) => {
  const { email, password, name, setup_key } = req.body;

  if (setup_key !== process.env.ADMIN_SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key' });
  }

  const hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('admins')
    .insert({ email, password_hash: hash, name })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Admin created!', admin: { id: data.id, email: data.email } });
});

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body;

  const { data: admin, error } = await supabase
    .from('admins')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000
  });

  res.json({ message: 'Logged in', token, admin: { name: admin.name, email: admin.email } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token', { httpOnly: true, secure: true, sameSite: 'None' });
  res.json({ message: 'Logged out!' });
});

// ── Users Management ──

router.get('/users', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ users: data });
});

router.patch('/users/:id/membership', adminAuth, async (req, res) => {
  const {
    membership_shopper, status_shopper,
    membership_breeder, status_breeder,
    membership_owner, status_owner,
    membership_type, membership_status
  } = req.body;

  try {
    // 1. Fetch current profile to check for active subscriptions
    const { data: profile, error: fetchError } = await supabase
      .from('profiles')
      .select('sub_id_shopper, sub_id_breeder, sub_id_owner')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw fetchError;

    const updateData = {
      membership_shopper, status_shopper,
      membership_breeder, status_breeder,
      membership_owner, status_owner,
      membership_type, membership_status
    };

    // 2. Handle Stripe cancellations if downgraded to free
    const categories = ['shopper', 'breeder', 'owner'];
    for (const cat of categories) {
      const field = `membership_${cat}`;
      const subIdField = `sub_id_${cat}`;
      const freeTier = `${cat}_free`;

      // If being changed to free AND there is an active subscription
      if (req.body[field] === freeTier && profile[subIdField]) {
        try {
          await stripe.subscriptions.cancel(profile[subIdField]);
          updateData[subIdField] = null; // Clear the sub ID in DB
          console.log(`Cancelled Stripe subscription ${profile[subIdField]} for category ${cat}`);
        } catch (stripeErr) {
          console.error(`Error cancelling Stripe sub ${profile[subIdField]}:`, stripeErr.message);
          // We continue even if Stripe fails, but maybe log it
        }
      }
    }

    // Special check for legacy membership_type if it's being set to a free value
    if (membership_type && membership_type.endsWith('_free')) {
      updateData.stripe_subscription_id = null;
      updateData.membership_status = 'cancelled';
    }

    // Remove undefined fields
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    const { error: updateError } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', req.params.id);

    if (updateError) return res.status(400).json({ error: updateError.message });

    // Trigger ActiveCampaign tagging for any updated memberships
    try {
      const updatedMemberships = [];
      if (membership_shopper) updatedMemberships.push(membership_shopper);
      if (membership_breeder) updatedMemberships.push(membership_breeder);
      if (membership_owner) updatedMemberships.push(membership_owner);
      // Fallback/Legacy if none of the above are set but membership_type is
      if (membership_type && !membership_shopper && !membership_breeder && !membership_owner) {
        updatedMemberships.push(membership_type);
      }

      for (const type of updatedMemberships) {
        await triggerMembershipTagById(req.params.id, type);
      }
    } catch (acErr) {
      console.error('ActiveCampaign admin membership update tagging error:', acErr.message);
    }

    res.json({ message: 'User updated and subscriptions cancelled if applicable!' });

  } catch (err) {
    console.error('Membership update error:', err);
    res.status(500).json({ error: 'Failed to update membership' });
  }
});

router.delete('/users/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'User deleted!' });
});

// ── Store Items ──

router.get('/store-items', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('store_items')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ items: data });
});

router.post('/store-items', adminAuth, async (req, res) => {
  const { name, description, price, image_url, category, stock_quantity } = req.body;

  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });

  const { data, error } = await supabase
    .from('store_items')
    .insert({ name, description, price, image_url, category, stock_quantity: stock_quantity || 0 })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Item added!', item: data });
});

router.patch('/store-items/:id', adminAuth, async (req, res) => {
  const { name, description, price, image_url, category, stock_quantity, is_active } = req.body;

  const { error } = await supabase
    .from('store_items')
    .update({ name, description, price, image_url, category, stock_quantity, is_active })
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Item updated!' });
});

router.delete('/store-items/:id', adminAuth, async (req, res) => {
  const { error } = await supabase
    .from('store_items')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Item deleted!' });
});

// ── Dashboard Stats ──

router.get('/stats', adminAuth, async (req, res) => {
  const [usersResult, storeResult, ordersResult, listingsResult, breederReqsResult, litterReqsResult] = await Promise.all([
    supabase.from('profiles').select('membership_type, membership_shopper, membership_breeder, membership_owner'),
    supabase.from('store_items').select('id, is_active'),
    supabase.from('orders').select('total, status'),
    supabase.from('pomsky_listings').select('id, is_active'),
    supabase.from('breeder_requests').select('id').eq('status', 'pending'),
    supabase.from('litter_requests').select('id, request_email_blast').eq('status', 'pending')
  ]);

  const users = usersResult.data || [];
  const membershipCounts = users.reduce((acc, u) => {
    // Count Shoppers
    if (u.membership_shopper && u.membership_shopper !== 'shopper_free') {
      acc[u.membership_shopper] = (acc[u.membership_shopper] || 0) + 1;
    }
    // Count Breeders
    if (u.membership_breeder && u.membership_breeder !== 'breeder_free') {
      acc[u.membership_breeder] = (acc[u.membership_breeder] || 0) + 1;
    }
    // Count Owners
    if (u.membership_owner && u.membership_owner !== 'owner_free') {
      acc[u.membership_owner] = (acc[u.membership_owner] || 0) + 1;
    }

    // Add legacy if none of the above are present or for transition
    if (u.membership_type && !u.membership_shopper && !u.membership_breeder && !u.membership_owner) {
      acc[u.membership_type] = (acc[u.membership_type] || 0) + 1;
    }

    return acc;
  }, {});

  const pendingLitters = (litterReqsResult.data || []).filter(l => !l.request_email_blast).length;
  const pendingBlasts = (litterReqsResult.data || []).filter(l => l.request_email_blast).length;

  res.json({
    total_users: users.length,
    total_store_items: (storeResult.data || []).length,
    active_store_items: (storeResult.data || []).filter(i => i.is_active).length,
    total_orders: (ordersResult.data || []).length,
    total_listings: (listingsResult.data || []).length,
    active_listings: (listingsResult.data || []).filter(l => l.is_active).length,
    membership_counts: membershipCounts,
    pending_breeders_count: (breederReqsResult.data || []).length,
    pending_litters_count: pendingLitters,
    pending_blasts_count: pendingBlasts
  });
});

// ── Pomsky Listings Management ──

// Get all listings
router.get('/listings', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('pomsky_listings')
    .select(`
      *,
      breeder_profiles (breeder_name, business_name)
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ listings: data });
});

// Approve or feature a listing
router.patch('/listings/:id', adminAuth, async (req, res) => {
  const { is_active, is_featured } = req.body;

  const { error } = await supabase
    .from('pomsky_listings')
    .update({ is_active, is_featured })
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Listing updated!' });
});

// Delete a listing
router.delete('/listings/:id', adminAuth, async (req, res) => {
  const { error } = await supabase
    .from('pomsky_listings')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Listing deleted!' });
});

// ── Breeders Management ──

// Get all breeder profiles
router.get('/breeders', adminAuth, async (req, res) => {
  try {
    const { data: breeders, error } = await supabase
      .from('breeder_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    const userIds = breeders.map(b => b.user_id).filter(Boolean);
    const profilesMap = new Map();

    if (userIds.length > 0) {
      const { data: profiles, error: pError } = await supabase
        .from('profiles')
        .select('id, full_name, email, membership_type, membership_breeder')
        .in('id', userIds);

      if (!pError && profiles) {
        profiles.forEach(p => profilesMap.set(p.id, p));
      }
    }

    const merged = breeders.map(b => ({
      ...b,
      profiles: profilesMap.get(b.user_id) || null
    }));

    res.json({ breeders: merged });
  } catch (err) {
    console.error('GET BREEDERS ERROR:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// Approve or feature a breeder
router.patch('/breeders/:id', adminAuth, async (req, res) => {
  const { is_approved, is_featured } = req.body;

  const { error } = await supabase
    .from('breeder_profiles')
    .update({ is_approved, is_featured })
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Breeder updated!' });
});

// Delete a breeder profile
router.delete('/breeders/:id', adminAuth, async (req, res) => {
  const { error } = await supabase
    .from('breeder_profiles')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Breeder deleted!' });
});

// ── Litter Requests Management ──

// Get all litter requests
router.get('/litter-requests', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('litter_requests')
    .select(`
      id, status, created_at,
      name, kennel, message, url, date,
      availability, puppies_available, state,
      price_min, price_max, next_litter,
      pomsky_type, gender, markings,
      contact_email, contact_phone, images,
      user_id, request_email_blast, email_blast_sent, is_new_litter
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ requests: data });
});

// Approve request
router.patch('/litter-requests/:id/approve', adminAuth, async (req, res) => {
  try {
    // 1. Fetch request
    const { data: request, error: fetchError } = await supabase
      .from('litter_requests')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !request) {
      console.error("FETCH ERROR:", fetchError);
      return res.status(404).json({ error: 'Request not found' });
    }

    // 2. Conditional listing insertion (only if is_new_litter is true or null/undefined)
    if (request.is_new_litter !== false) {
      let breeder = null;
      let isFeatured = false;

      const { data: existingBreeder } = await supabase
        .from('breeder_profiles')
        .select('id, is_featured')
        .eq('user_id', request.user_id)
        .maybeSingle();

      const { data: userProfile } = await supabase
        .from('profiles')
        .select('membership_type, membership_breeder')
        .eq('id', request.user_id)
        .maybeSingle();

      const membership = userProfile?.membership_breeder || userProfile?.membership_type;
      const isGold = membership === 'breeder_gold';
      isFeatured = existingBreeder?.is_featured || isGold;

      if (existingBreeder) {
        breeder = existingBreeder;
      } else {
        const { data: newBreeder, error: createError } = await supabase
          .from('breeder_profiles')
          .insert({
            user_id: request.user_id,
            breeder_name: request.name || 'New Breeder',
            business_name: request.kennel || 'Pending Setup',
            state: request.state || null,
            is_approved: true,
            is_featured: isFeatured
          })
          .select('id')
          .single();

        if (createError) {
          console.error("CREATE BREEDER ERROR:", createError);
          return res.status(400).json({ error: 'Could not create breeder profile: ' + createError.message });
        }

        breeder = newBreeder;
      }

      console.log("BREEDER:", breeder);

      const { data: insertData, error: insertError } = await supabase
        .from('pomsky_listings')
        .insert({
          name: request.kennel || 'Pomsky',
          gender: request.gender || null,
          pomsky_type: request.pomsky_type || null,
          markings: request.markings || null,
          price: request.price_min || null,
          price_min: request.price_min || null,
          price_max: request.price_max || null,
          availability: request.availability || 'available',
          state: request.state || null,
          breeder_id: breeder.id,
          user_id: request.user_id,
          is_active: true,
          is_new_litter: request.is_new_litter !== false,
          is_featured: isFeatured,
          contact_email: request.contact_email || null,
          contact_phone: request.contact_phone || null,
          images: request.images || [],
          description: request.message || null,
          puppies_available: request.puppies_available || null
        });

      if (insertError) {
        console.error("INSERT ERROR:", insertError);
        return res.status(400).json({ error: insertError.message });
      }
    }

    // 3. Update request status to approved and update blast status
    const updatePayload = { status: 'approved' };
    if (request.request_email_blast) {
      updatePayload.email_blast_sent = true;
    }
    const { error: updateError } = await supabase
      .from('litter_requests')
      .update(updatePayload)
      .eq('id', req.params.id);

    if (updateError) {
      console.error("UPDATE ERROR:", updateError);
      return res.status(400).json({ error: updateError.message });
    }

    // Trigger ActiveCampaign automation via tag (only for new listings)
    if (request.is_new_litter !== false && request.contact_email) {
      await triggerEmailByTag(
        request.contact_email,
        request.name,
        '',
        'Litter Listing Approved'
      );
    }

    res.json({ message: request.is_new_litter === false ? 'Blast request approved' : 'Approved + listing created' });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reject request
router.patch('/litter-requests/:id/reject', adminAuth, async (req, res) => {
  try {
    const { data: request } = await supabase
      .from('litter_requests')
      .select('name, kennel, contact_email, user_id, gender, pomsky_type, markings, price_min, state, is_new_litter')
      .eq('id', req.params.id)
      .single();

    const { error } = await supabase
      .from('litter_requests')
      .update({ status: 'rejected' })
      .eq('id', req.params.id);

    if (error) return res.status(400).json({ error: error.message });

    // Also delete the corresponding listing if it was created on approval
    if (request && request.is_new_litter !== false) {
      let query = supabase
        .from('pomsky_listings')
        .delete()
        .eq('name', request.kennel || 'Pomsky');

      // Fallback: Use contact_email if user_id is missing (for legacy listings)
      if (request.user_id) {
        query = query.eq('user_id', request.user_id);
      } else if (request.contact_email) {
        query = query.eq('contact_email', request.contact_email);
      }

      if (request.gender) query = query.eq('gender', request.gender);
      if (request.pomsky_type) query = query.eq('pomsky_type', request.pomsky_type);
      if (request.state) query = query.eq('state', request.state);

      const { error: deleteListingError } = await query;
      if (deleteListingError) {
        console.error("Error deleting corresponding pomsky listing on rejection:", deleteListingError);
      }
    }

    // Trigger ActiveCampaign automation via tag (only for new listings)
    if (request?.is_new_litter !== false && request?.contact_email) {
      await triggerEmailByTag(
        request.contact_email,
        request.name,
        '',
        'Litter Listing Rejected'
      );
    }

    res.json({ message: request?.is_new_litter === false ? 'Blast request rejected' : 'Litter rejected and listing removed from website' });
  } catch (err) {
    console.error('LITTER REJECT ERROR:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/breeder-requests', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('breeder_requests')
    .select(`
      id, status, created_at,
      breeder_name, business_name, email, phone,
      state, city, country, website, bio,
      profile_image,
      social_facebook, social_instagram, social_twitter, social_youtube, social_other,
      apkc_member_status, apkc_proof_url,
      ipa_member_status, ipa_proof_url,
      good_dog_member_status, good_dog_proof_url,
      non_member_action, available_pomskies_info, price_range,
      what_is_included, vet_reference, health_tests,
      testimonial_1, testimonial_2, testimonial_3,
      kennel_logo_url, kennel_photos_urls,
      disclosure, other_comments, agreed_code_of_ethics,
      user_id
    `)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ requests: data });
});

router.patch('/breeder-requests/:id/approve', adminAuth, async (req, res) => {
  try {
    const { data: request, error: fetchError } = await supabase
      .from('breeder_requests')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !request) {
      console.error('BREEDER REQUEST FETCH ERROR:', fetchError);
      return res.status(404).json({ error: 'Breeder request not found' });
    }

    const { data: existingBreeder, error: breederFetchError } = await supabase
      .from('breeder_profiles')
      .select('id, is_featured')   // also fetch is_featured to preserve manual overrides
      .eq('user_id', request.user_id)
      .maybeSingle();

    if (breederFetchError) {
      console.error('BREEDER PROFILE FETCH ERROR:', breederFetchError);
      return res.status(500).json({ error: breederFetchError.message });
    }

    // Fetch user's membership so gold breeders are auto-featured on approval
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('membership_type, membership_breeder')
      .eq('id', request.user_id)
      .maybeSingle();

    const membership = userProfile?.membership_breeder || userProfile?.membership_type;
    const isGold = membership === 'breeder_gold';
    // Preserve existing is_featured if already manually set, otherwise base on membership
    const isFeatured = existingBreeder?.is_featured || isGold;

    // Helper to safely extract single string URL or value from text[] array fields
    const getSingleVal = (val) => {
      if (Array.isArray(val)) {
        return val.length > 0 ? val[0] : null;
      }
      return val || null;
    };

    const breederPayload = {
      user_id: request.user_id,
      breeder_name: request.breeder_name,
      business_name: request.business_name,
      state: request.state,
      city: request.city,
      country: request.country || 'US',
      phone: request.phone,
      email: request.email,
      website: request.website,
      bio: request.bio,

      // Store array fields as arrays, and extract single string for scalar fields
      profile_image: request.profile_image || [],
      kennel_logo_url: getSingleVal(request.kennel_logo_url),
      social_facebook: request.social_facebook || [],
      social_instagram: request.social_instagram || [],
      social_twitter: request.social_twitter || [],
      social_youtube: getSingleVal(request.social_youtube),
      social_other: getSingleVal(request.social_other),

      // Map other missing breeder details
      price_range: request.price_range || null,
      non_member_action: request.non_member_action || null,
      available_pomskies_info: request.available_pomskies_info || null,
      what_is_included: request.what_is_included || null,
      vet_reference: request.vet_reference || null,
      health_tests: request.health_tests || null,
      disclosure: request.disclosure || null,
      other_comments: request.other_comments || null,

      // Testimonials
      testimonial_1: request.testimonial_1 || null,
      testimonial_2: request.testimonial_2 || null,
      testimonial_3: request.testimonial_3 || null,

      // Memberships
      apkc_member_status: request.apkc_member_status || null,
      apkc_proof_url: getSingleVal(request.apkc_proof_url),
      ipa_member_status: request.ipa_member_status || null,
      ipa_proof_url: getSingleVal(request.ipa_proof_url),
      good_dog_member_status: request.good_dog_member_status || null,
      good_dog_proof_url: getSingleVal(request.good_dog_proof_url),

      // Keep arrays intact for array columns
      kennel_photos_urls: request.kennel_photos_urls || [],

      is_approved: true,
      is_onboarded: true,
      is_featured: isFeatured
    };

    if (existingBreeder) {
      const { error: updateError } = await supabase
        .from('breeder_profiles')
        .update(breederPayload)
        .eq('user_id', request.user_id);
      if (updateError) return res.status(500).json({ error: updateError.message });
    } else {
      const { error: insertError } = await supabase
        .from('breeder_profiles')
        .insert(breederPayload);
      if (insertError) return res.status(500).json({ error: insertError.message });
    }

    await supabase
      .from('profiles')
      .update({ account_type: 'breeder', needs_onboarding: false })
      .eq('id', request.user_id);

    await supabase
      .from('breeder_requests')
      .update({ status: 'approved' })
      .eq('id', req.params.id);

    // Trigger ActiveCampaign automation via tag
    if (request.email) {
      await triggerEmailByTag(
        request.email,
        request.breeder_name,
        '',
        'Breeder Application Approved'
      );
    }

    res.json({ message: 'Breeder onboarding approved' });
  } catch (err) {
    console.error('BREEDER APPROVE ERROR:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/breeder-requests/:id/reject', adminAuth, async (req, res) => {
  try {
    const { data: request } = await supabase
      .from('breeder_requests')
      .select('breeder_name, business_name, email, user_id')
      .eq('id', req.params.id)
      .single();

    const { error } = await supabase
      .from('breeder_requests')
      .update({ status: 'rejected' })
      .eq('id', req.params.id);

    if (error) return res.status(400).json({ error: error.message });

    // Also delete the breeder profile so they no longer appear on the website
    if (request && request.user_id) {
      await supabase
        .from('breeder_profiles')
        .delete()
        .eq('user_id', request.user_id);
    }

    // Trigger ActiveCampaign automation via tag
    if (request?.email) {
      await triggerEmailByTag(
        request.email,
        request.breeder_name,
        '',
        'Breeder Application Rejected'
      );
    }

    res.json({ message: 'Breeder onboarding rejected and profile removed from directory' });
  } catch (err) {
    console.error('BREEDER REJECT ERROR:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update breeder request
router.patch('/breeder-requests/:id', adminAuth, async (req, res) => {
  const payload = { ...req.body };

  // Map fields in case frontend/admin UI sends profile_image_url or kennel_logo
  if (payload.profile_image_url && !payload.profile_image) {
    payload.profile_image = payload.profile_image_url;
  }
  if (payload.kennel_logo && !payload.kennel_logo_url) {
    payload.kennel_logo_url = payload.kennel_logo;
  }

  // Helper to ensure values are stored as arrays for Postgres text[] columns
  const toArray = (v) => {
    if (v === undefined || v === null) return v;
    if (Array.isArray(v)) return v;
    if (v === '') return [];
    return [v]; // Wrap single string in an array
  };

  // Comprehensive list of all fields that are defined as arrays (text[]) in your database
  const arrayFields = [
    'social_facebook', 'social_instagram', 'social_twitter',
    'kennel_photos_urls', 'profile_image'
  ];

  arrayFields.forEach(field => {
    if (payload.hasOwnProperty(field)) {
      payload[field] = toArray(payload[field]);
    }
  });

  const { error } = await supabase
    .from('breeder_requests')
    .update(payload)
    .eq('id', req.params.id);

  if (error) {
    console.error('BREEDER UPDATE ERROR:', error);
    return res.status(400).json({ error: error.message });
  }

  // Sync to breeder_profiles if it exists
  try {
    const { data: request } = await supabase
      .from('breeder_requests')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (request) {
      const { data: existingBreeder } = await supabase
        .from('breeder_profiles')
        .select('id')
        .eq('user_id', request.user_id)
        .maybeSingle();

      if (existingBreeder) {
        const getSingleVal = (val) => {
          if (Array.isArray(val)) {
            return val.length > 0 ? val[0] : null;
          }
          return val || null;
        };

        const breederPayload = {
          breeder_name: request.breeder_name,
          business_name: request.business_name,
          state: request.state,
          city: request.city,
          country: request.country || 'US',
          phone: request.phone,
          email: request.email,
          website: request.website,
          bio: request.bio,

          profile_image: request.profile_image || [],
          kennel_logo_url: getSingleVal(request.kennel_logo_url),
          social_facebook: request.social_facebook || [],
          social_instagram: request.social_instagram || [],
          social_twitter: request.social_twitter || [],
          social_youtube: getSingleVal(request.social_youtube),
          social_other: getSingleVal(request.social_other),

          price_range: request.price_range || null,
          non_member_action: request.non_member_action || null,
          available_pomskies_info: request.available_pomskies_info || null,
          what_is_included: request.what_is_included || null,
          vet_reference: request.vet_reference || null,
          health_tests: request.health_tests || null,
          disclosure: request.disclosure || null,
          other_comments: request.other_comments || null,

          testimonial_1: request.testimonial_1 || null,
          testimonial_2: request.testimonial_2 || null,
          testimonial_3: request.testimonial_3 || null,

          apkc_member_status: request.apkc_member_status || null,
          apkc_proof_url: getSingleVal(request.apkc_proof_url),
          ipa_member_status: request.ipa_member_status || null,
          ipa_proof_url: getSingleVal(request.ipa_proof_url),
          good_dog_member_status: request.good_dog_member_status || null,
          good_dog_proof_url: getSingleVal(request.good_dog_proof_url),

          kennel_photos_urls: request.kennel_photos_urls || []
        };

        await supabase
          .from('breeder_profiles')
          .update(breederPayload)
          .eq('user_id', request.user_id);
      }
    }
  } catch (syncErr) {
    console.error('SYNC BREEDER PROFILE ERROR:', syncErr);
  }

  res.json({ message: 'Breeder request updated and synced to profile!' });
});

module.exports = router;
module.exports.adminAuth = adminAuth;
