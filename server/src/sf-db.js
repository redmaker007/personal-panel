import postgres from 'postgres';

// Supabase 的 transaction 模式 pooler（6543）不支持 prepared statement，必须 prepare:false。
// serverless 下每个实例只需要一条连接；容器保活时会被复用。
const url = process.env.DATABASE_URL;
export const configured = Boolean(url);

export const sql = configured
  ? postgres(url, {
      prepare: false,
      max: Number(process.env.PG_MAX_CONNECTIONS) || 1,
      idle_timeout: 20,
      connect_timeout: 10,
      // Supabase pooler 要求 TLS，但用的是自签链；这与直连 postgres 的默认一致。
      ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
      onnotice: () => {},
    })
  : null;

export function requireSql() {
  if (!sql) {
    throw Object.assign(
      new Error('未配置 DATABASE_URL，强项查找器的后端不可用'),
      { status: 503 }
    );
  }
  return sql;
}
