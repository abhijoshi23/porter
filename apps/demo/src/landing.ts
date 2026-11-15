/** `/`: what a person sees when they open the demo URL in a browser. */
export function landingPage(req: Request, url: URL, o: { oauth: boolean }): Response | undefined {
  if (url.pathname !== '/') return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const origin = url.origin;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const o2 = esc(origin);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Porter demo</title>
<style>
  :root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #5d5b55; --line: #e3e0d8; --code: #f1efe9; --accent: #2b5d8a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --fg: #ecebe7; --muted: #a3a19a; --line: #34332f; --code: #22221f; --accent: #8cb8e0; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.1rem; margin: 2.2rem 0 .6rem; }
  p, li { color: var(--fg); }
  .lede { color: var(--muted); margin-top: 0; }
  a { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: .95rem; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  code, pre { font: .88rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; }
  code { padding: .1rem .3rem; overflow-wrap: anywhere; }
  pre { padding: .8rem 1rem; overflow-x: auto; }
  .note { color: var(--muted); font-size: .92rem; }
</style>
</head>
<body>
<main>
  <h1>Porter demo</h1>
  <p class="lede">MCP servers for Canadian public data and small-business accounting, hosted free on Cloudflare Workers. Connect an MCP client to one of the URLs below.</p>

  <table>
    <thead><tr><th>Server</th><th>MCP URL</th><th>Try asking</th></tr></thead>
    <tbody>
      <tr><td>QuickBooks (sample company)</td><td><code>${o2}/quickbooks/mcp</code></td><td>"Who owes me money, and who should I chase first?"</td></tr>
      <tr><td>Open data (Ontario, Toronto, Canada, StatCan)</td><td><code>${o2}/opendata/mcp</code></td><td>"Find Toronto datasets about bike lanes."</td></tr>
      ${o.oauth ? `<tr><td>QuickBooks, with sign-in (OAuth 2.1)</td><td><code>${o2}/quickbooks/mcp-auth</code></td><td>Your client asks you to sign in first.</td></tr>` : ''}
    </tbody>
  </table>

  <h2>Claude Code</h2>
  <pre>claude mcp add --transport http porter-quickbooks ${o2}/quickbooks/mcp</pre>

  <h2>Claude (web and desktop)</h2>
  <p>Settings → Connectors → Add custom connector, then paste an MCP URL.</p>

  <h2>What this demo is</h2>
  <ul>
    <li>The QuickBooks server runs against a built-in <strong>sample company</strong> with made-up customers. Nothing is connected to real books, and the sample resets on every request.</li>
    <li>Creating an invoice needs a client that can ask you to approve it. Other clients are refused, and nothing is created.</li>
    <li>The hosted open-data server is reduced: SQL over CSV files and full-text StatCan table search need the local server.</li>
    <li>Requests are rate-limited per IP.</li>
  </ul>
  <p class="note">Source, design notes and eval results: <a href="https://github.com/abhijoshi23/porter">github.com/abhijoshi23/porter</a>.</p>
</main>
</body>
</html>`;
  return new Response(req.method === 'HEAD' ? null : html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}
