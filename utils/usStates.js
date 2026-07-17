/*
 * US location allowlist for the public breeder map.
 *
 * SRS 4.1 requires the map to show US breeders only, and requires the filter to
 * live at the data/API layer rather than in the Webflow embed.
 *
 * The `country` column on pomsky_listings cannot be used for this: every row
 * holds 'US', including the England / Germany / Netherlands / Switzerland /
 * Canada / Alberta / British Columbia ones. `state` is the only trustworthy
 * signal, so membership of this map is what decides a pin.
 *
 * Coordinates are the state centroids the Webflow embed used to hardcode. They
 * live here now so the map endpoint can return ready-to-plot points and the
 * frontend never has to geocode.
 */

const US_STATES = {
  'Alabama': [32.8, -86.8],
  'Alaska': [61.3, -152.4],
  'Arizona': [33.7, -111.4],
  'Arkansas': [34.9, -92.3],
  'California': [36.1, -119.6],
  'Colorado': [39.0, -105.3],
  'Connecticut': [41.5, -72.7],
  'Delaware': [39.3, -75.5],
  'District of Columbia': [38.9, -77.0],
  'Florida': [27.7, -81.6],
  'Georgia': [33.0, -83.6],
  'Hawaii': [21.0, -157.4],
  'Idaho': [44.2, -114.4],
  'Illinois': [40.3, -88.9],
  'Indiana': [39.8, -86.2],
  'Iowa': [42.0, -93.2],
  'Kansas': [38.5, -96.7],
  'Kentucky': [37.6, -84.6],
  'Louisiana': [31.1, -91.8],
  'Maine': [44.6, -69.3],
  'Maryland': [39.0, -76.8],
  'Massachusetts': [42.2, -71.5],
  'Michigan': [43.3, -84.5],
  'Minnesota': [45.6, -93.9],
  'Mississippi': [32.7, -89.6],
  'Missouri': [38.4, -92.2],
  'Montana': [46.9, -110.4],
  'Nebraska': [41.1, -98.2],
  'Nevada': [38.3, -117.0],
  'New Hampshire': [43.4, -71.5],
  'New Jersey': [40.2, -74.5],
  'New Mexico': [34.8, -106.2],
  'New York': [42.1, -74.9],
  'North Carolina': [35.6, -79.8],
  'North Dakota': [47.5, -99.7],
  'Ohio': [40.3, -82.7],
  'Oklahoma': [35.5, -96.9],
  'Oregon': [44.5, -122.0],
  'Pennsylvania': [40.5, -77.2],
  'Rhode Island': [41.6, -71.5],
  'South Carolina': [33.8, -80.9],
  'South Dakota': [44.2, -99.4],
  'Tennessee': [35.7, -86.6],
  'Texas': [31.0, -97.5],
  'Utah': [40.1, -111.8],
  'Vermont': [44.0, -72.7],
  'Virginia': [37.7, -78.1],
  'Washington': [47.4, -121.4],
  'West Virginia': [38.4, -80.9],
  'Wisconsin': [44.2, -89.6],
  'Wyoming': [42.7, -107.3]
};

/*
 * SRS 4.1 asks for these: "No pins appear outside the continental United States
 * (and US territories if applicable)". None are in use today; they are listed so
 * a future Puerto Rico breeder gets a pin rather than being silently dropped as
 * though they were foreign.
 */
const US_TERRITORIES = {
  'Puerto Rico': [18.2, -66.5],
  'Guam': [13.44, 144.79],
  'U.S. Virgin Islands': [18.34, -64.9],
  'American Samoa': [-14.27, -170.13],
  'Northern Mariana Islands': [15.1, 145.67]
};

/*
 * On the word "continental" in SRS 4.1.
 *
 * The section contradicts itself. Its Required Behaviour says the map shows
 * "only breeders with a US-based location" — which Hawaii is. Its Acceptance
 * Criteria says no pins outside the "continental" US — which Hawaii is not.
 *
 * Read as written it also fails to do what people assume: "continental" US
 * includes Alaska, since Alaska sits on the continent. The term that excludes
 * Alaska is "contiguous" (the lower 48).
 *
 * The intent is unambiguous everywhere else: 2.4 calls the platform "US-only",
 * 1.2 scopes it "across the United States", and 4.1's own examples are England
 * and the Netherlands. Decisive is the criteria's own "(and US territories if
 * applicable)" — it wants Guam and Puerto Rico shown, and Guam is far less
 * continental than Hawaii. Including Guam while excluding Hawaii is incoherent.
 *
 * So "continental" is loose drafting for "US", and the allowlist is every US
 * location: 50 states + DC + territories. Non-US is what gets dropped, which is
 * the thing 4.1 actually set out to fix.
 */
function buildAllowlist() {
  return Object.assign({}, US_STATES, US_TERRITORIES);
}

const ALLOWED_LOCATIONS = buildAllowlist();

// Nothing validates `state` on the way in — routes/user.js and routes/admin.js
// both write it straight from the request body. Match case-insensitively so a
// row reading 'texas' is not silently dropped from the map as though it were
// a foreign location.
const LOOKUP = {};
Object.keys(ALLOWED_LOCATIONS).forEach(name => {
  LOOKUP[name.toLowerCase()] = name;
});

// Returns the canonical spelling, or null if this is not a US location
function canonicalState(state) {
  if (!state) return null;
  return LOOKUP[String(state).trim().toLowerCase()] || null;
}

function isUsLocation(state) {
  return canonicalState(state) !== null;
}

function getCoords(state) {
  const name = canonicalState(state);
  return name ? ALLOWED_LOCATIONS[name] : null;
}

module.exports = {
  US_STATES,
  US_TERRITORIES,
  ALLOWED_LOCATIONS,
  canonicalState,
  isUsLocation,
  getCoords
};
