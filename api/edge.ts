import server from "../src/server";

export const config = {
  runtime: "edge",
};

export default async function handler(request: Request): Promise<Response> {
  // TanStack Start server entry uses the standard Fetch API.
  // Vercel Edge Functions don't provide a Cloudflare-style env/ctx.
  return server.fetch(request, {}, {});
}
