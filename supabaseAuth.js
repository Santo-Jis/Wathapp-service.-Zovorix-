const { Pool } = require('pg');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

const TABLE = 'baileys_auth_state';

// Baileys auth state (creds + signal keys) সরাসরি Postgres-এ persist করে —
// Supabase-এর REST API (PostgREST) এড়িয়ে সরাসরি ডাটাবেসে কানেক্ট করা হয়, তাই
// PostgREST layer-এ কোনো সমস্যা হলেও এটা প্রভাবিত হবে না।
// server restart/redeploy হলেও session টিকে থাকে, তাই বারবার QR স্ক্যান লাগে না।
async function useSupabaseAuthState(connectionString, sessionId = 'main') {
  if (!connectionString) {
    throw new Error('DATABASE_URL .env এ সেট থাকতে হবে (Supabase Session Pooler connection string)');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    // এই সার্ভিসের কোয়েরি খুবই কম (শুধু session save/load) — Novatech-BD একই
    // ডাটাবেসের connection pool শেয়ার করে (মোট মাত্র ১৫টা), তাই pool ছোট রাখা হলো
    // যাতে Novatech-BD-র জন্য জায়গা কমে না যায়
    max: 2,
    idleTimeoutMillis: 10000,
  });

  // টেবিল না থাকলে বানিয়ে নেয় (idempotent, নিরাপদ — আগে থেকে থাকলে কিছু হয় না)
  await pool.query(`
    create table if not exists ${TABLE} (
      session_id text not null,
      key text not null,
      value text,
      updated_at timestamptz default now(),
      primary key (session_id, key)
    )
  `);

  const writeData = async (data, key) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    try {
      await pool.query(
        `insert into ${TABLE} (session_id, key, value, updated_at)
         values ($1, $2, $3, now())
         on conflict (session_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [sessionId, key, value]
      );
    } catch (err) {
      console.error(`Postgres-এ ${key} সেভ করতে সমস্যা:`, err.message);
    }
  };

  const readData = async (key) => {
    try {
      const { rows } = await pool.query(
        `select value from ${TABLE} where session_id = $1 and key = $2`,
        [sessionId, key]
      );
      if (!rows.length) return null;
      return JSON.parse(rows[0].value, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await pool.query(`delete from ${TABLE} where session_id = $1 and key = $2`, [sessionId, key]);
    } catch (err) {
      console.error(`Postgres থেকে ${key} মুছতে সমস্যা:`, err.message);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
    // WhatsApp-side logout হলে পুরনো session সাফ করতে — নতুন QR তৈরির আগে কল করা হয়
    clearSession: async () => {
      try {
        await pool.query(`delete from ${TABLE} where session_id = $1`, [sessionId]);
      } catch (err) {
        console.error('Session ক্লিয়ার করতে সমস্যা:', err.message);
      }
    },
  };
}

module.exports = { useSupabaseAuthState };
