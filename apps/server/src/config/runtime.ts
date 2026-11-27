import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: '../../.env' });

export const port = Number(process.env.PORT ?? 3000);
export const isProduction = process.env.NODE_ENV === 'production';
export const sessionSecret = process.env.SESSION_SECRET ?? '';
if (isProduction && sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production');
export const cookieName = 'nri_session';
export const uploadDirectory = resolve(process.cwd(), '../..', process.env.UPLOAD_DIR ?? '.data/uploads');
export const webOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
export const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProduction, maxAge: 60 * 60 * 24 * 14 };
