export const config = {
  runtime: "nodejs",
};

type NodeRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

type NodeResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: Uint8Array | string) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function getRequestUrl(req: NodeRequest): string {
  const proto =
    (typeof req.headers["x-forwarded-proto"] === "string" && req.headers["x-forwarded-proto"]) ||
    "https";
  const host =
    (typeof req.headers["x-forwarded-host"] === "string" && req.headers["x-forwarded-host"]) ||
    (typeof req.headers["host"] === "string" && req.headers["host"]) ||
    "localhost";
  const path = typeof req.url === "string" ? req.url : "/";
  return `${proto}://${host}${path}`;
}

function toFetchHeaders(headers: NodeRequest["headers"]): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

async function readBody(req: NodeRequest): Promise<Uint8Array | undefined> {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  // Node IncomingMessage is async-iterable.
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const chunk of req as any) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }

  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks);
}

async function getSsrServer(): Promise<{ fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response }> {
  // Generated during `npm run build`.
  const mod = await import("../dist/server/vercel-ssr-entry.mjs");
  return (mod as { default: { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response } }).default;
}

export default async function handler(req: NodeRequest, res: NodeResponse) {
  const server = await getSsrServer();

  const url = getRequestUrl(req);
  const headers = toFetchHeaders(req.headers);
  const body = await readBody(req);

  const request = new Request(url, {
    method: req.method || "GET",
    headers,
    body,
  });

  const response = await server.fetch(request, {}, {});

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}
