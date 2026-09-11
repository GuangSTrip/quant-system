import {sqliteTable,text,integer,real,index} from 'drizzle-orm/sqlite-core';

export const control=sqliteTable('control',{
  id:integer('id').primaryKey(),halted:integer('halted').notNull().default(1),
  reason:text('reason').notNull().default('初次启用前请完成对账并恢复'),
  revision:integer('revision').notNull().default(0),ownerId:text('owner_id'),
  leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),
  maxOrder:real('max_order').notNull().default(2500),maxDaily:real('max_daily').notNull().default(10000),
  maxPosition:real('max_position').notNull().default(0.25),maxLoss:real('max_loss').notNull().default(0.05),
  updatedAt:text('updated_at').notNull()
});
export const orders=sqliteTable('orders',{
  clientId:text('client_id').primaryKey(),brokerId:text('broker_id'),requestHash:text('request_hash').notNull(),
  payload:text('payload').notNull(),status:text('status').notNull(),estimatedNotional:real('estimated_notional').notNull(),
  brokerData:text('broker_data'),error:text('error'),actor:text('actor').notNull(),
  createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull()
},t=>[index('idx_orders_created').on(t.createdAt),index('idx_orders_status').on(t.status)]);
export const events=sqliteTable('events',{
  id:integer('id').primaryKey({autoIncrement:true}),timestamp:text('timestamp').notNull(),
  actor:text('actor').notNull(),kind:text('kind').notNull(),subject:text('subject'),details:text('details').notNull(),
  digest:text('digest').notNull()
});
export const artifacts=sqliteTable('artifacts',{
  id:text('id').primaryKey(),kind:text('kind').notNull(),name:text('name').notNull(),
  payload:text('payload').notNull(),actor:text('actor').notNull(),createdAt:text('created_at').notNull()
},t=>[index('idx_artifacts_kind_created').on(t.kind,t.createdAt)]);

export const authSessions=sqliteTable('auth_sessions',{
  tokenHash:text('token_hash').primaryKey(),username:text('username').notNull(),credentialTag:text('credential_tag').notNull(),
  createdAt:text('created_at').notNull(),expiresAt:integer('expires_at').notNull()
},t=>[index('idx_auth_sessions_expiry').on(t.expiresAt)]);
export const authLimits=sqliteTable('auth_limits',{
  bucket:text('bucket').primaryKey(),attempts:integer('attempts').notNull(),expiresAt:integer('expires_at').notNull()
});
