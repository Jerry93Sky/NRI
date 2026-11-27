import { config } from 'dotenv';
config({ path: '../../.env' });
import argon2 from 'argon2';
import { db, pool } from './db/index.js';
import { campaigns, memberships, sceneLayers, scenes, users } from './db/schema.js';
import { defaultLayerRows } from './domain/defaultLayers.js';
import { eq } from 'drizzle-orm';

try {
  const email = 'demo@nri.local';
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword || demoPassword.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters) to seed a local demo account.');
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length) { console.info('Demo user already exists; seed made no changes.'); }
  else {
    const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, displayName: 'Demo Guide', passwordHash }).returning();
      if (!user) throw new Error('Demo user creation failed');
      const [campaign] = await tx.insert(campaigns).values({ ownerId: user.id, title: 'The Amber Crossing', description: 'An original starter scene for exploring the NRI tabletop.' }).returning();
      if (!campaign) throw new Error('Demo campaign creation failed');
      await tx.insert(memberships).values({ campaignId: campaign.id, userId: user.id, role: 'OWNER' });
      const [scene] = await tx.insert(scenes).values({ campaignId: campaign.id, title: 'Roadside Clearing', gridSize: 48, width: 2048, height: 2048, isActive: true, published: true }).returning();
      if (!scene) throw new Error('Demo scene creation failed');
      await tx.insert(sceneLayers).values(defaultLayerRows.map((layer) => ({ ...layer, sceneId: scene.id })));
    });
    console.info('Created demo account and campaign. Use the DEMO_PASSWORD supplied for this local seed.');
  }
} finally { await pool.end(); }
