// UPI helpers. The ID is checked here for a quick message and again by the server, which is the one that decides.
export const UPI_RE = /^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{2,32}$/;
export const cleanUpi = (s: string) => s.trim().toLowerCase();
export const upiValid = (s: string) => UPI_RE.test(cleanUpi(s));

/** Hides the middle of a UPI ID for places where it is only a reminder: ravi.kumar@okhdfcbank → ra•••ar@okhdfcbank */
export function maskUpi(id: string): string {
  const [name, bank] = id.split('@');
  if (!bank) return id;
  return name.length <= 4 ? `${name[0]}•••@${bank}` : `${name.slice(0, 2)}•••${name.slice(-2)}@${bank}`;
}

type PayLink = { vpa: string; name: string; paise: number; note: string };

/** A standard UPI payment link: the payee, the amount and a note are already filled in, the tenant only enters their PIN. */
export function upiLink(base: 'upi://pay' | 'gpay://upi/pay', p: PayLink): string {
  const q = [['pa', p.vpa], ['pn', p.name], ['am', (p.paise / 100).toFixed(2)], ['cu', 'INR'], ['tn', p.note]]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${base}?${q}`;
}
