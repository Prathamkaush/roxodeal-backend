import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const {parse} = require('dotenv');
const {PrismaClient} = require('@prisma/client');
const cfg = parse(await readFile(new URL('../.env', import.meta.url)));
const db = new PrismaClient({datasources:{db:{url:cfg.DATABASE_URL}}});
try {
  const [sellers,leads,payments] = await Promise.all([
    db.seller.findMany({select:{categories:{select:{category:{select:{name:true}}}}}}),
    db.lead.findMany({select:{status:true,category:{select:{name:true}}}}),
    db.payment.groupBy({by:['type','status'],_count:true}),
  ]);
  console.log(JSON.stringify({sellers:sellers.map((s,i)=>({index:i+1,categories:s.categories.map(c=>c.category.name)})),leads:leads.map(l=>({status:l.status,category:l.category.name})),payments,gatewayConfigured:!!cfg.RAZORPAY_KEY_ID && !!cfg.RAZORPAY_KEY_SECRET,webhookConfigured:!!cfg.RAZORPAY_WEBHOOK_SECRET},null,2));
}finally{await db.$disconnect();}
