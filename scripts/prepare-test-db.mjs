// Makes the database the DB suites run against (DATABASE_URL) ready: created when missing, schema applied once, so no suite depends on another having run first.
// Additive only: it creates one database and touches no other. Run by scripts/pre-push.sh; never point it at a database someone else uses.
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL), name = decodeURIComponent(url.pathname.slice(1));
url.pathname = '/postgres';
const admin = new pg.Client({connectionString: url.toString()});
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
await admin.end();
const db = await import('../src/db/index.ts');
await db.migrate();
await db.pool.end();
