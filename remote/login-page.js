/**
 * Server-rendered, accessible consent and error pages for the standards-based
 * MCP OAuth browser sign-in flow (task T6, S1, S5).
 *
 * The consent page is service-owned and identifies, before any explicit user
 * action:
 *   - which MCP client application is requesting access (name/id taken from
 *     the server-side registered client, never from raw request input),
 *   - the exact registered redirect address the authorization code would be
 *     returned to, and
 *   - the exact MCP permission scopes the client requested.
 *
 * Microsoft's own sign-in UI is never imitated: the sign-in button only
 * labels the Microsoft step in plain text, uses no Microsoft branding or
 * images, makes clear that the password entry happens at Microsoft, and never
 * collects credentials here. A browser session that completed the Microsoft
 * step must still give explicit consent to each individual MCP client; this
 * page never infers a browser session into another client's authorization.
 *
 * Security properties carried by every page:
 *   - single reusable form target (`/login/consent`) with the CSRF value of
 *     this exact pending authorization supplied by the server in a hidden
 *     input; the server never accepts the form without it,
 *   - strict frame denial, no content sniffing, no referrer, no caching,
 *   - no JavaScript at all: a static page with a real, keyboard-reachable
 *     submit button and a visible focus indicator,
 *   - a CSP `form-action` allowlist that is exactly `'self'` by default and
 *     — on the consent page and its redirect (T11, S8) — additionally names
 *     only the server-trusted configured Entra authorization origin, never
 *     a client redirect or any unregistered origin: Chromium re-checks the
 *     initiating document's form-action against every hop of a form
 *     navigation, so without this single trusted origin the browser blocks
 *     the consent POST redirect to Microsoft.
 *
 * All dynamic values are HTML-escaped; the renderers are pure functions with
 * no I/O, no storage, and no network access.
 */

const FORM_ACTION_LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  'localhost.localdomain',
  '::1',
]);

/**
 * Validates one strict CSP form-action origin: a single absolute origin
 * (https, or exact loopback http for the explicitly opted-in local topology)
 * with no path, query, or embedded credentials, and returns its canonical
 * origin string.
 */
function validateFormActionOrigin(rawOrigin) {
  let parsed;
  try {
    parsed = new URL(String(rawOrigin));
  } catch {
    throw new TypeError(
      'A CSP form-action origin must be a valid absolute URL origin of the sign-in target'
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = FORM_ACTION_LOOPBACK_HOSTNAMES.has(hostname);
  const schemeAllowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback);
  if (
    !parsed.hostname ||
    !schemeAllowed ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError(
      'A CSP form-action origin must be a bare https:// origin (or exact loopback http:// origin), with no path, query, or credentials'
    );
  }
  return parsed.origin;
}

/**
 * Builds the strict page/redirect security headers for the sign-in flow,
 * optionally extending the CSP `form-action` allowlist. T11 (S8): Chromium
 * re-checks the *initiating document's* `form-action` against every hop of
 * a form navigation, including its redirect, so a consent page whose policy
 * carried only `'self'` could not follow its own POST redirect to the Entra
 * authorization endpoint — real Chrome/Edge blocked the cross-origin
 * redirect and left the user stranded on the consent page (whose repeated
 * click then failed against the already-consumed one-time CSRF token).
 *
 * The allowlist stays restrictive and fail-closed: the default remains
 * exactly `'self'`, and any additional origin must be a single absolute
 * origin (https, or exact loopback http for the explicitly opted-in local
 * development topology), with no path, query, or embedded credentials.
 * All other directives — default-src, style-src, frame-ancestors,
 * base-uri, frame denial, nosniff, the `strict-origin` referrer policy,
 * and no-store — are identical in every variant, and no script/source or
 * other relaxations exist at all.
 *
 * @param {{ formActionOrigins?: string[]; selfOrigin?: string|null }} options
 */
function securityHeaders({ formActionOrigins = [], selfOrigin = null } = {}) {
  const explicitSelfOrigin = selfOrigin ? validateFormActionOrigin(selfOrigin) : null;
  const formActionTargets = [explicitSelfOrigin || "'self'"];
  const extraOrigins = Array.isArray(formActionOrigins) ? formActionOrigins : [];
  if (extraOrigins.length > 0) {
    for (const rawOrigin of extraOrigins) {
      formActionTargets.push(validateFormActionOrigin(rawOrigin));
    }
  }
  return Object.freeze({
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `form-action ${formActionTargets.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    // T10/S7: `no-referrer` made real Chromium/Edge/Chrome browsers submit
    // the same-origin consent form with `Origin: null` (Chromium derives
    // the form-POST Origin from the referrer policy state), which the
    // strict origin gate then rightly refused — the user-reported
    // `{"error":"origin-denied"}`. `strict-origin` sends at most the origin
    // in BOTH directions: the same-origin form submission keeps the
    // browser's true Origin, and even the same-origin Referer is reduced to
    // the bare origin so the page URL — whose query carries the opaque
    // OAuth authorization reference — is never referred anywhere
    // (same-origin, cross-site redirect, or upstream Microsoft redirect).
    // T11 keeps this policy: the form-action allowlist extension only ever
    // names the server-trusted configured Entra authorization origin, and
    // still never refers opaque OAuth material to it.
    'referrer-policy': 'strict-origin',
    'cache-control': 'no-store',
  });
}

/** Default headers: CSP form-action is exactly 'self'. */
const SECURITY_HEADERS = securityHeaders();

/**
 * HTML-escapes one value for safe text or attribute interpolation.
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function styles() {
  return `:root { color-scheme: light dark; font-family: system-ui, 'Segoe UI', sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #faf9f8; color: #201f1e; }
main { max-width: 34rem; margin: 3rem auto; padding: 1rem 1.5rem 2.5rem; background: #ffffff; border: 1px solid #e1dfdd; border-radius: 8px; }
:focus-visible { outline: 3px solid #0f6cbd; outline-offset: 2px; }
h1 { font-size: 1.35rem; margin: 1.2rem 0 0.4rem; }
p.lead { margin: 0 0 1rem; color: #4a4947; }
ul.details { list-style: none; margin: 0 0 1.5rem; padding: 0; border-top: 1px solid #e1dfdd; }
ul.details li { padding: 0.6rem 0.1rem; border-bottom: 1px solid #e1dfdd; }
ul.details li .label { display: block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.02em; color: #5f5c58; margin-bottom: 0.15rem; }
code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; word-break: break-all; }
button[type='submit'] { display: inline-block; min-height: 44px; min-width: 176px; padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; border: 1px solid #8a8886; border-radius: 4px; background: #ffffff; color: #201f1e; }
button[type='submit']:focus-visible { outline: 3px solid #0f6cbd; outline-offset: 2px; }
.note { color: #4a4947; font-size: 0.95rem; margin-top: 1rem; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }`;
}

function pageHead(title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles()}</style>
</head>
<body>`;
}

/**
 * Renders the browser-facing consent page for one pending MCP authorization.
 * Every dynamic field comes from the server-side pending-authorization
 * descriptor (registered client data), never from unvalidated request input.
 */
function renderConsentLoginPage({ ref, csrfToken, clientId, redirectUri, scopes }) {
  const scopeItems = (Array.isArray(scopes) && scopes.length > 0 ? scopes : ['-'])
    .map(
      (scope) =>
        `<li class="permission"><span class="label">Permission</span><code>${escapeHtml(
          scope
        )}</code></li>`
    )
    .join('\n');
  return `${pageHead('Sign-in request')}
<main>
<h1>Connection request</h1>
<p class="lead">An application is requesting permission to connect to this MCP service as you. Review what it will receive before you continue.</p>
<ul class="details">
<li><span class="label">Application</span><strong>${escapeHtml(clientId)}</strong></li>
<li><span class="label">Redirect target</span><code>${escapeHtml(redirectUri)}</code></li>
<li class="permission-group"><span class="label">Permissions requested</span></li>
${scopeItems}
</ul>
<form method="post" action="/login/consent">
<input type="hidden" name="mcp_authorization" value="${escapeHtml(ref)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<button type="submit">Continue to Microsoft sign-in</button>
</form>
<p class="note">Sign-in happens directly at Microsoft; this page never asks for or receives your password. After you sign in at Microsoft, your browser returns here so the authorization code can be sent to <strong>${escapeHtml(clientId)}</strong> at its registered redirect address. Granting this one application does not authorize any other application.</p>
</main>
</body>
</html>`;
}

/**
 * Renders a bounded, generic error page for failed or replayed browser
 * sign-in steps. The page never names the Entra application identity, never
 * echoes request material, and contains no actionable details beyond the
 * short static guidance.
 */
function renderLoginErrorPage({ title, message }) {
  return `${pageHead(escapeHtml(title))}
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="note">Close this page and return to your MCP client to begin the connection again.</p>
</main>
</body>
</html>`;
}

module.exports = {
  SECURITY_HEADERS,
  securityHeaders,
  renderConsentLoginPage,
  renderLoginErrorPage,
};
