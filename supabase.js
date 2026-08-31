const { createClient } = require('@supabase/supabase-js');

// Server-side client: the service key is a STATIC credential, not a user
// session. Disabling session persistence + token auto-refresh stops supabase-js
// from drifting the service_role connection over time — which was silently
// dropping the backend to anon-level after hours/days, so RLS started blocking
// every query (0 rows) until a redeploy reset the client. With these options
// the service key is sent as-is on every request → always service_role →
// always bypasses RLS, permanently.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // use service key on backend
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

module.exports = supabase;