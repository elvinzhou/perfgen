export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', version: '0.1.0' });
    }

    // All other processing is client-side (Wasm + IndexedDB)
    // This worker mainly serves as the edge entry point for Cloudflare Pages
    return new Response('Not Found', { status: 404 });
  },
};

interface Env {}
