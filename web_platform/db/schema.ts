import {sqliteTable,text,integer,real,index,uniqueIndex} from 'drizzle-orm/sqlite-core';

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

export const autoStrategy=sqliteTable('auto_strategy',{
  id:integer('id').primaryKey(),runId:text('run_id'),enabled:integer('enabled').notNull().default(0),revision:integer('revision').notNull().default(0),
  config:text('config'),backtestId:text('backtest_id'),budget:real('budget').notNull().default(1000),actor:text('actor'),
  reason:text('reason').notNull().default('尚未启动'),startedAt:text('started_at'),updatedAt:text('updated_at').notNull(),
  leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),heartbeatAt:text('heartbeat_at'),heartbeatSource:text('heartbeat_source'),
  lastCheckAt:text('last_check_at'),lastOutcome:text('last_outcome')
});
export const autoDecisions=sqliteTable('auto_decisions',{
  id:text('id').primaryKey(),runId:text('run_id').notNull(),barTime:text('bar_time').notNull(),signal:integer('signal').notNull(),
  payload:text('payload').notNull(),clientKey:text('client_key'),status:text('status').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull()
},t=>[index('idx_auto_decisions_run').on(t.runId)]);
export const autoCycles=sqliteTable('auto_cycles',{
  id:integer('id').primaryKey({autoIncrement:true}),runId:text('run_id'),source:text('source').notNull(),outcome:text('outcome').notNull(),
  details:text('details').notNull(),createdAt:text('created_at').notNull()
});

export const longbridgeConnection=sqliteTable('longbridge_connection',{
  id:integer('id').primaryKey(),ciphertext:text('ciphertext').notNull(),updatedAt:text('updated_at').notNull(),actor:text('actor').notNull()
});

export const lbControl=sqliteTable('lb_control',{
 id:integer('id').primaryKey(),enabled:integer('enabled').notNull().default(0),connectionTag:text('connection_tag'),
 maxOrder:real('max_order').notNull().default(2000),maxDaily:real('max_daily').notNull().default(5000),
 leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),updatedAt:text('updated_at').notNull()
});
export const lbOrders=sqliteTable('lb_orders',{
 clientId:text('client_id').primaryKey(),connectionTag:text('connection_tag').notNull(),brokerId:text('broker_id'),
 payload:text('payload').notNull(),requestHash:text('request_hash').notNull(),status:text('status').notNull(),
 notional:real('notional').notNull(),initialQty:real('initial_qty').notNull(),brokerData:text('broker_data'),error:text('error'),
 actor:text('actor').notNull(),runId:text('run_id'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull()
});
export const lbAuto=sqliteTable('lb_auto',{
 id:integer('id').primaryKey(),enabled:integer('enabled').notNull().default(0),runId:text('run_id'),config:text('config'),
 nextAt:integer('next_at').notNull().default(0),sequence:integer('sequence').notNull().default(0),
 heartbeatAt:text('heartbeat_at'),lastAt:text('last_at'),outcome:text('outcome'),reason:text('reason'),updatedAt:text('updated_at').notNull()
});

// One isolated portfolio sleeve per market/account. Pausing retains ownership.
export const portfolioRuns=sqliteTable('portfolio_runs',{
 exitRequested:integer('exit_requested').notNull().default(0),market:text('market').primaryKey(),runId:text('run_id').notNull(),strategyId:text('strategy_id').notNull(),
 version:text('version').notNull(),connectionTag:text('connection_tag').notNull(),budget:real('budget').notNull(),
 enabled:integer('enabled').notNull().default(0),revision:integer('revision').notNull().default(0),
 leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0),
 lastDecision:text('last_decision'),reason:text('reason').notNull(),updatedAt:text('updated_at').notNull()
});
export const portfolioSignals=sqliteTable('portfolio_signals',{
 id:text('id').primaryKey(),strategyId:text('strategy_id').notNull(),signalDate:text('signal_date').notNull(),
 payload:text('payload').notNull(),createdAt:text('created_at').notNull()
},t=>[uniqueIndex('idx_portfolio_signal').on(t.strategyId,t.signalDate)]);
export const portfolioDecisions=sqliteTable('portfolio_decisions',{
 id:text('id').primaryKey(),runId:text('run_id').notNull(),signalId:text('signal_id').notNull(),
 phase:text('phase').notNull(),payload:text('payload').notNull(),createdAt:text('created_at').notNull()
});
export const portfolioQuotes=sqliteTable('portfolio_quotes',{
 market:text('market').primaryKey(),payload:text('payload').notNull(),updatedAt:text('updated_at').notNull()
});

export const brokerLocks=sqliteTable('broker_locks',{
 market:text('market').primaryKey(),leaseId:text('lease_id'),leaseUntil:integer('lease_until').notNull().default(0)
});
