export interface AnnouncedRoute {
  url: string;
  sourceRoute: string;
  priceDrops: number;
  currency: "XRP";
  network: string;
  label: string;
}

/**
 * Read routes an issuer chose to announce. Does not sign and does not need a wallet seed.
 * The price that binds is the 402 challenge, not this list.
 */
export async function listAnnouncedRoutes(options: {
  baseUrl: string;
  fetchFn?: typeof fetch;
}): Promise<AnnouncedRoute[]> {
  const base = options.baseUrl.replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${base}/api/v1/discovery`);
  if (!response.ok) {
    throw new Error(`Announcement list failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { routes?: unknown };
  if (!Array.isArray(body.routes)) {
    throw new Error("Announcement list missing routes");
  }
  return body.routes as AnnouncedRoute[];
}
