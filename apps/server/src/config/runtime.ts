import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: '../../.env' });

export const port = Number(process.env.PORT ?? 3000);
export const isProduction = process.env.NODE_ENV === 'production';
export const sessionSecret = process.env.SESSION_SECRET ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535');
if (isProduction && sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production');
export const cookieName = 'nri_session';
export const uploadDirectory = resolve(process.cwd(), '../..', process.env.UPLOAD_DIR ?? '.data/uploads');
export const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
if (isProduction && (!webOrigins.length || webOrigins.some((origin) => {
  const url = URL.parse(origin);
  return !url || url.protocol !== 'https:' || url.origin !== origin;
}))) throw new Error('WEB_ORIGIN must contain the allowed HTTPS origins in production');
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '1') throw new Error('TRUST_PROXY must be 1 or unset');
export const trustProxy = process.env.TRUST_PROXY === '1' ? (_address: string, hop: number) => hop === 0 : false;
export const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProduction, maxAge: 60 * 60 * 24 * 14 };
