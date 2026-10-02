// How long the site's TLS certificate has left. Checked once a day (cron/daily) so an expiry
// is seen a month ahead rather than by the first customer who cannot pay.

import tls from "tls";

export interface CertStatus { host: string; days_left: number; expires_at: string }

/** The certificate a host serves on 443, as a visitor's browser would see it. */
export function certStatus(host: string, timeoutMs = 8000): Promise<CertStatus> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return reject(new Error(`${host} served no certificate`));
      const expires = new Date(cert.valid_to);
      resolve({ host, days_left: Math.floor((expires.getTime() - Date.now()) / 86_400_000), expires_at: expires.toISOString() });
    });
    socket.on("timeout", () => { socket.destroy(); reject(new Error(`${host}: TLS check timed out`)); });
    socket.on("error", reject);
  });
}

/** The public host from PUBLIC_BASE_URL. */
export function publicHost(): string {
  try { return new URL(process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").hostname; } catch { return "katanapay.co"; }
}
