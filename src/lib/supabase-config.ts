/**
 * Audit-2 M74: Supabase config-drift detection (pure helpers, no
 * server imports — shared by the server fn and the client).
 *
 * The server reads SUPABASE_URL at request time; the client bakes
 * VITE_SUPABASE_URL / VITE_SUPABASE_PROJECT_ID into its JS at build
 * time. If the two point at different projects, auth tokens minted
 * by one project fail validation on the other — and the failure
 * looks like an auth bug, not config drift. Worse, an AUTHENTICATED
 * health fn cannot report cross-project drift at all: the auth
 * middleware validates the token against the SERVER's project, so
 * the call itself fails. The drift check therefore runs through an
 * UNAUTHENTICATED fn (getServerSupabaseConfig) that returns only
 * public values — the project ref is already baked into the client
 * bundle, so it leaks nothing.
 */

/** Extract the project ref from a Supabase URL (`https://<ref>.supabase.co`). */
export function supabaseProjectRef(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".supabase.co")) {
      const ref = host.slice(0, -".supabase.co".length);
      return ref || null;
    }
    return null;
  } catch {
    return null;
  }
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Compare the client's baked Supabase config against the server's
 * runtime config. Returns a human-readable drift description, or
 * null when there is no provable drift. Fail-OPEN (null) when either
 * side is missing or unparseable — a health check must never cry
 * wolf on a value it cannot read.
 */
export function detectSupabaseDrift(
  client: { url?: string | null; projectId?: string | null },
  server: { urlHost?: string | null; projectRef?: string | null },
): string | null {
  const clientRef = client.projectId?.trim() || supabaseProjectRef(client.url);
  const serverRef = server.projectRef?.trim() || null;
  if (clientRef && serverRef && clientRef !== serverRef) {
    return (
      `Supabase config drift: this app was built for project "${clientRef}" ` +
      `but the server is using project "${serverRef}". Sign-in and server features will fail. ` +
      `Rebuild + redeploy with matching env vars.`
    );
  }
  // No comparable refs (custom-domain / self-hosted URL) — fall back
  // to comparing hosts.
  if (!clientRef || !serverRef) {
    const clientHost = hostOf(client.url);
    const serverHost = server.urlHost?.toLowerCase() || null;
    if (clientHost && serverHost && clientHost !== serverHost) {
      return (
        `Supabase config drift: this app was built for host "${clientHost}" ` +
        `but the server is using host "${serverHost}". Sign-in and server features may fail. ` +
        `Rebuild + redeploy with matching env vars.`
      );
    }
  }
  return null;
}
