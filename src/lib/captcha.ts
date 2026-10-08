import type { Config } from "../config";

export type CaptchaFetch = (url: string, init: RequestInit) => Promise<Response>;

/** CAP consumes a proof once; errors and service outages fail closed. */
export async function verifyCaptcha(config: NonNullable<Config["captcha"]>, token: string, fetcher: CaptchaFetch = fetch): Promise<boolean> {
  if (!token.startsWith(`${config.siteKey}:`) || token.length > 2048 || token.split(":").length !== 3) return false;
  try {
    const response = await fetcher(`${config.serverUrl}/${config.siteKey}/siteverify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: config.secretKey, response: token }),
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    return (await response.json() as { success?: unknown }).success === true;
  } catch { return false; }
}
