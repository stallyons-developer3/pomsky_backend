const multer = require('multer');
const upload = multer();
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const approvedBreederMiddleware = require('../middleware/approvedBreeder');
const { canonicalState, getCoords } = require('../utils/usStates');

// const multer = require('multer');
// const upload = multer();
// 🔹 GET ALL BREEDERS (FEATURE PAGE)
router.get('/', async (req, res) => {
  try {
    const { state } = req.query;

    let query = supabase
      .from('breeder_profiles')
      .select(`
        id,
        breeder_name,
        business_name,
        state,
        city,
        bio,
        email,
        phone,
        website,
        profile_image,
        social_facebook,
        social_instagram,
        social_twitter,
        is_featured,
        is_approved
      `)
      .eq('is_approved', true)
      .order('is_featured', { ascending: false });

    if (state) {
      query = query.eq('state', state);
    }

    const { data, error } = await query;

    if (error) {
      console.error("BREEDER FETCH ERROR:", error);
      return res.status(400).json({ error: error.message });
    }

    const featured = data.filter(b => b.is_featured);
    const normal = data.filter(b => !b.is_featured);

    res.json({
      featured,
      normal
    });

  } catch (err) {
    console.error("BREEDER ROUTE ERROR:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/my-requests', async (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: userData } = await supabase.auth.getUser(token);

  const { data } = await supabase
    .from('litter_requests')
    .select('*')
    .eq('user_id', userData.user.id);

  res.json({ requests: data || [] });
});

router.get('/meta/states', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('breeder_profiles')
      .select('state')
      .eq('is_approved', true)
      .not('state', 'is', null);

    if (error) throw error;

    const states = [...new Set(data.map(d => d.state))]
      .filter(Boolean)
      .sort();

    res.json({ states });

  } catch (err) {
    res.status(500).json({ error: 'Failed to load states' });
  }
});

// US-only map points for the breeder directory (SRS 4.1 — the "Breeder Map").
// Same shape and reasoning as GET /listings/meta/map-points: filter to the US
// allowlist here, at the data layer, and return coordinates so the page never
// geocodes. No non-US breeder exists today, but the vulnerable Nominatim path
// did — this closes it so a future England breeder cannot pin the map.
router.get('/meta/map-points', async (req, res) => {
  try {
    // Mirrors the state filter on GET /breeder so the map matches the list
    const { state } = req.query;

    let query = supabase
      .from('breeder_profiles')
      .select('state')
      .eq('is_approved', true)
      .not('state', 'is', null);

    if (state) query = query.eq('state', state);

    const { data, error } = await query;

    if (error) throw error;

    const counts = {};
    let excluded = 0;

    for (const row of data || []) {
      const name = canonicalState(row.state);
      if (!name) { excluded++; continue; }
      counts[name] = (counts[name] || 0) + 1;
    }

    const points = Object.keys(counts).sort().map(s => {
      const coords = getCoords(s);
      return { state: s, count: counts[s], lat: coords[0], lng: coords[1] };
    });

    res.json({
      points,
      total_pins: points.reduce((n, p) => n + p.count, 0),
      excluded_non_us: excluded
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to load map points' });
  }
});

router.get('/email-blast-eligibility', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { data: profile, error: pError } = await supabase
      .from('profiles')
      .select('membership_breeder, membership_type')
      .eq('id', user.id)
      .maybeSingle();

    if (pError) throw pError;
    const membership = profile?.membership_breeder || profile?.membership_type || 'shopper_free';
    const isGold = membership === 'breeder_gold';

    if (!isGold) {
      return res.json({ eligible: false, reason: 'NOT_GOLD', membershipType: membership });
    }

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data: existingBlasts, error: checkError } = await supabase
      .from('litter_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('request_email_blast', true)
      .gte('created_at', startOfMonth);

    if (checkError) throw checkError;

    if (existingBlasts && existingBlasts.length > 0) {
      return res.json({ eligible: false, reason: 'QUOTA_EXCEEDED', membershipType: membership });
    }

    res.json({ eligible: true, membershipType: membership });
  } catch (err) {
    console.error("ELIGIBILITY ERROR:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/listings/:id/request-blast', authMiddleware, approvedBreederMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const listingId = req.params.id;

    // 1. Fetch user's membership and check if gold
    const { data: profile, error: pError } = await supabase
      .from('profiles')
      .select('membership_breeder, membership_type')
      .eq('id', user.id)
      .maybeSingle();

    if (pError) throw pError;
    const membership = profile?.membership_breeder || profile?.membership_type || 'shopper_free';
    if (membership !== 'breeder_gold') {
      return res.status(403).json({ error: 'Only Gold Breeders can request an email blast.' });
    }

    // 2. Calendar month check
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data: existingBlasts, error: checkError } = await supabase
      .from('litter_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('request_email_blast', true)
      .gte('created_at', startOfMonth);

    if (checkError) throw checkError;
    if (existingBlasts && existingBlasts.length > 0) {
      return res.status(400).json({ error: 'You have already requested an email blast this calendar month.' });
    }

    // 3. Fetch listing details to ensure it belongs to the breeder
    const { data: listing, error: listingError } = await supabase
      .from('pomsky_listings')
      .select('*')
      .eq('id', listingId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found or access denied.' });
    }

    // 4. Fetch breeder profile business name for kennel field
    const { data: breederProfile } = await supabase
      .from('breeder_profiles')
      .select('business_name, breeder_name')
      .eq('user_id', user.id)
      .maybeSingle();
    const kennelName = breederProfile?.business_name || breederProfile?.breeder_name || 'Pomsky Breeder';

    // 5. Insert new request into litter_requests
    const { error: insertError } = await supabase
      .from('litter_requests')
      .insert({
        user_id: user.id,
        name: listing.name,
        kennel: kennelName,
        message: listing.description || '',
        url: '',
        date: new Date().toISOString().split('T')[0],
        status: 'pending',
        availability: listing.availability || 'available',
        puppies_available: 1,
        state: listing.state || '',
        price_min: listing.price ? parseInt(listing.price, 10) : 0,
        price_max: listing.price ? parseInt(listing.price, 10) : 0,
        next_litter: '',
        pomsky_type: listing.pomsky_type || '',
        gender: listing.gender || '',
        markings: listing.markings || '',
        contact_email: listing.contact_email || '',
        contact_phone: listing.contact_phone || '',
        images: listing.images || [],
        request_email_blast: true,
        is_new_litter: false,
      });

    if (insertError) {
      console.error("Blast request insert error:", insertError);
      return res.status(400).json({ error: insertError.message });
    }

    res.json({ message: 'Email blast request submitted successfully to admin.' });
  } catch (err) {
    console.error("REQUEST BLAST ERROR:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/schedule-litter', authMiddleware, approvedBreederMiddleware, upload.array('photos'), async (req, res) => {
  try {
    const user = req.user;
    const files = req.files;

    let imageUrls = [];

    if (files && files.length > 0) {
      for (let file of files) {
        const fileName = `${Date.now()}-${Math.random()}-${file.originalname}`;

        const { data, error } = await supabase.storage
          .from('pomsky-images')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype
          });

        if (error) {
          console.error("❌ IMAGE UPLOAD ERROR:", error);
        } else {
          const { data: publicUrl } = supabase
            .storage
            .from('pomsky-images')
            .getPublicUrl(fileName);

          imageUrls.push(publicUrl.publicUrl);
        }
      }
    }

    const { name, kennel, message, url, date, availability, puppies_available, state, price_min, price_max, next_litter, pomsky_type, gender, markings, contact_email, contact_phone, request_email_blast } = req.body;
    const isEmailBlastRequested = request_email_blast === 'true' || request_email_blast === true;

    if (isEmailBlastRequested) {
      // 1. Fetch user's membership and check if gold
      const { data: profile, error: pError } = await supabase
        .from('profiles')
        .select('membership_breeder, membership_type')
        .eq('id', user.id)
        .maybeSingle();

      if (pError) throw pError;
      const membership = profile?.membership_breeder || profile?.membership_type || 'shopper_free';
      if (membership !== 'breeder_gold') {
        return res.status(403).json({ error: 'Only Gold Breeders can request an email blast.' });
      }

      // 2. Calendar month check
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const { data: existingBlasts, error: checkError } = await supabase
        .from('litter_requests')
        .select('id')
        .eq('user_id', user.id)
        .eq('request_email_blast', true)
        .gte('created_at', startOfMonth);

      if (checkError) throw checkError;
      if (existingBlasts && existingBlasts.length > 0) {
        return res.status(400).json({ error: 'You have already requested an email blast this calendar month.' });
      }
    }

    const { error: insertError } = await supabase
      .from('litter_requests')
      .insert({
        user_id: user.id,
        name,
        kennel,
        message,
        url,
        date,
        status: 'pending',
        availability,
        puppies_available,
        state,
        price_min,
        price_max,
        next_litter,
        pomsky_type,
        gender,
        markings,
        contact_email,
        contact_phone,
        images: imageUrls,
        request_email_blast: isEmailBlastRequested,
        is_new_litter: true,
      });

    if (insertError) {
      console.error("❌ INSERT ERROR:", insertError);
      return res.status(400).json({ error: insertError.message });
    }

    res.json({ message: 'Submitted successfully' });
    console.log("FILES:", req.files);
    console.log("UPLOAD URLS:", imageUrls);

  } catch (err) {
    console.error("FULL ERROR:", err);
    console.error("STACK:", err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});


router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // Fetch breeder profile
    const { data: profile, error: profileError } = await supabase
      .from('breeder_profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) return res.status(404).json({ error: 'Breeder not found' });

    // Fetch breeder's listings
    const { data: listings, error: listingsError } = await supabase
      .from('pomsky_listings')
      .select('*')
      .eq('breeder_id', id)
      .eq('is_active', true);

    if (listingsError) throw listingsError;

    res.json({
      profile,
      listings: listings || []
    });

  } catch (err) {
    console.error("SINGLE BREEDER FETCH ERROR:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;