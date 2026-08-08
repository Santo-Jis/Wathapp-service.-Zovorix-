const { createClient } = require('@supabase/supabase-js');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

const TABLE = 'baileys_auth_state';

// Baileys auth state (creds + signal keys) Supabase-এ persist করে —
// server restart/redeploy হলেও session টিকে থাকে, তাই বারবার QR স্ক্যান লাগে না।
async function useSupabaseAuthState(supabaseUrl, supabaseKey, sessionId = 'main') {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL এবং SUPABASE_SERVICE_KEY দুটোই .env এ সেট থাকতে হবে');
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const writeData = async (data, key) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    const { error } = await supabase
      .from(TABLE)
      .upsert({ session_id: sessionId, key, value, updated_at: new Date().toISOString() });
    if (error) console.error(`Supabase-এ ${key} সেভ করতে সমস্যা:`, error.message);
  };

  const readData = async (key) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select('value')
      .eq('session_id', sessionId)
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    try {
      return JSON.parse(data.value, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (key) => {
    const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId).eq('key', key);
    if (error) console.error(`Supabase থেকে ${key} মুছতে সমস্যা:`, error.message);
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
      const { error } = await supabase.from(TABLE).delete().eq('session_id', sessionId);
      if (error) console.error('Session ক্লিয়ার করতে সমস্যা:', error.message);
    },
  };
}

module.exports = { useSupabaseAuthState };
