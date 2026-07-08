const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

/* ── Helper to find listing IDs that can show images to visitors ── */
async function getPublicImageListingIds() {
  try {
    const { data: goldBreeders } = await supabase
      .from('profiles')
      .select('id')
      .eq('membership_breeder', 'breeder_gold');
    const goldUserIds = new Set((goldBreeders || []).map(p => p.id));

    const { data: allListings } = await supabase
      .from('pomsky_listings')
      .select('id, is_featured, created_at, breeder_profiles(user_id)')
      .eq('is_active', true);

    if (!allListings) return new Set();

    let listings = allListings.map(l => ({
      id: l.id,
      is_featured: l.is_featured || (l.breeder_profiles && goldUserIds.has(l.breeder_profiles.user_id)),
      created_at: l.created_at
    }));

    listings.sort((a, b) => {
      if (a.is_featured && !b.is_featured) return -1;
      if (!a.is_featured && b.is_featured) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    const freeLimitIds = listings.slice(0, 6).map(l => l.id);

    let latestListings = [...allListings];
    latestListings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const latestIds = latestListings.slice(0, 4).map(l => l.id);

    return new Set([...freeLimitIds, ...latestIds]);
  } catch (err) {
    console.error("Error in getPublicImageListingIds:", err);
    return new Set();
  }
}

/* ================================
   🔹 GET META (MUST BE FIRST)
================================ */
router.get('/meta/states', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pomsky_listings')
      .select('state')
      .eq('is_active', true)
      .not('state', 'is', null);

    if (error) {
      console.error("META ERROR:", error);
      return res.status(400).json({ error: error.message });
    }

    const states = [...new Set(data.map(d => d.state))]
      .filter(Boolean)
      .sort();

    res.json({ states });

  } catch (err) {
    console.error("META CATCH ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   🔹 GET ALL LISTINGS
================================ */
router.get('/', async (req, res) => {
  try {
    const { state, gender, type, availability, min_price, max_price, new_litter } = req.query;

    let query = supabase
      .from('pomsky_listings')
      .select(`
  id, breeder_id, name, gender, pomsky_type, markings, price, price_min, price_max,
  availability, state, city, country,
  images, description, puppies_available,
  contact_email, contact_phone,
  is_featured, is_new_litter, created_at,
  breeder_profiles (
    id, breeder_name, business_name, state, city,
    user_id
  )
`)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (state) query = query.eq('state', state);
    if (gender) query = query.eq('gender', gender);
    if (type) query = query.eq('pomsky_type', type);
    if (availability) query = query.eq('availability', availability);
    if (new_litter === 'true') query = query.eq('is_new_litter', true);
    if (min_price) query = query.gte('price', Number(min_price));
    if (max_price) query = query.lte('price', Number(max_price));

    const { data, error } = await query;

    if (error) {
      console.error("LISTINGS ERROR:", error);
      return res.status(400).json({ error: error.message });
    }

    // ── Fetch gold breeder user IDs so we can auto-feature their listings ──
    const { data: goldBreeders } = await supabase
      .from('profiles')
      .select('id')
      .eq('membership_breeder', 'breeder_gold');

    const goldUserIds = new Set((goldBreeders || []).map(p => p.id));

    let isRegisteredUser = false;
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      if (userData?.user) {
        isRegisteredUser = true;
      }
    }

    const FREE_LIMIT = 6;

    // ── Auto-set is_featured for gold breeder listings, sort featured first ──
    let listings = (data || []).map(l => ({
      ...l,
      is_featured: l.is_featured || goldUserIds.has(l.breeder_profiles?.user_id)
    }));

    // Sort: featured first, then by newest
    listings.sort((a, b) => {
      if (a.is_featured && !b.is_featured) return -1;
      if (!a.is_featured && b.is_featured) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    if (!isRegisteredUser) {
      const allowedIds = await getPublicImageListingIds();

      // Free/visible listings: contact info is hidden on the grid (shown on individual page only)
      const visible = listings.slice(0, FREE_LIMIT).map(l => ({
        ...l,
        contact_email: null,
        contact_phone: null
      }));

      const locked = listings.slice(FREE_LIMIT).map(l => ({
        ...l,
        name: 'Members Only',
        images: allowedIds.has(l.id) ? l.images : [],
        price: null,
        city: '***',
        contact_email: null,
        contact_phone: null,
        is_locked: true
      }));
      listings = [...visible, ...locked];
    }

    res.json({
      listings,
      total: data?.length || 0,
      visible: isRegisteredUser ? data?.length : FREE_LIMIT,
      is_paid_member: isRegisteredUser
    });

  } catch (err) {
    console.error("LISTINGS CATCH ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   🔹 GET LATEST LISTINGS
================================ */
router.get('/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 4;

    const { data, error } = await supabase
      .from('pomsky_listings')
      .select(`
        id, name, gender, pomsky_type, price,
        availability, state, city, images,
        is_featured, is_new_litter, created_at,
        breeder_profiles (
          id, breeder_name, business_name, state, city
        )
      `)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error("LATEST LISTINGS ERROR:", error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ listings: data || [] });

  } catch (err) {
    console.error("LATEST LISTINGS CATCH ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   🔹 GET SINGLE LISTING (LAST!)
================================ */

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id.trim(); 

    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    let isRegisteredUser = false;

    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      if (userData?.user) {
        isRegisteredUser = true;
      }
    }

    const { data, error } = await supabase
      .from('pomsky_listings')
      .select(`
        id, name, gender, pomsky_type, markings, price, price_min, price_max,
        availability, state, city, images, puppies_available,
        contact_email, contact_phone,
        description, birth_date, is_new_litter, created_at,
        breeder_profiles (
          breeder_name, business_name, state, city, phone, website
        )
      `)
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();

    if (!data) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (!isRegisteredUser) {
      const allowedIds = await getPublicImageListingIds();
      const isFree = allowedIds.has(id);

      let breederProfile = null;
      if (data.breeder_profiles) {
        breederProfile = {
          ...data.breeder_profiles,
          // Hide breeder's private phone/website for guests UNLESS the listing is free
          phone: isFree ? data.breeder_profiles.phone : null,
          website: isFree ? data.breeder_profiles.website : null
        };
      }

      // Free listings: guests CAN see contact_email and contact_phone on the detail page
      // Locked listings: contact info is hidden
      return res.json({
        listing: {
          ...data,
          images: isFree ? data.images : [],
          contact_email: isFree ? data.contact_email : null,
          contact_phone: isFree ? data.contact_phone : null,
          breeder_profiles: breederProfile
        },
        locked: !isFree
      });
    }

    res.json({ listing: data });

  } catch (err) {
    console.error("SINGLE LISTING ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;