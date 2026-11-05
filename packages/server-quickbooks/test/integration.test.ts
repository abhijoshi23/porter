import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, serverFactory, silentLogger } from '@abhijoshi23/porter-toolkit';
import {
  connectTestClient,
  ERAS,
  type TestClient,
  type TestClientOptions,
} from '@abhijoshi23/porter-toolkit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, createQuickBooksServer } from '../src/server.js';
import { CLIENT, fakeQuickBooks, NOW, REALM, sampleState, type FakeState } from '../src/demo.js';
import { TokenStore } from '../src/token-store.js';

type Result = { structuredContent?: unknown; content: unknown; isError?: boolean };
const text = (r: Result) => (r.content as { text: string }[])[0]!.text;
const summaryLine = (r: Result) => text(r).split('\n\n')[0]!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = (r: Result) => r.structuredContent as any;
/** Opt in to preview-then-token writes for clients without elicitation (off by default). */
const TOKEN_FALLBACK = { QUICKBOOKS_REQUIRE_ELICITATION: 'false' };

let state: FakeState;
let dir: string;

async function connect(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'porter-qbo-'));
  await new TokenStore(dir, 'sandbox', CLIENT.secret).save({
    realmId: REALM,
    environment: 'sandbox',
    refreshToken: state.refreshToken,
    connectedAt: NOW,
  });
  const config = loadConfig(configSchema, {
    QUICKBOOKS_CLIENT_ID: CLIENT.id,
    QUICKBOOKS_CLIENT_SECRET: CLIENT.secret,
    PORTER_CONFIG_DIR: dir,
    LOG_LEVEL: 'silent',
    ...env,
  });
  return serverFactory(
    createQuickBooksServer({
      config,
      log: silentLogger,
      fetch: fakeQuickBooks(state),
      now: () => NOW,
    }),
    silentLogger,
  );
}

describe.each(ERAS)('porter-quickbooks over the %s protocol', (era) => {
  let t: TestClient | undefined;
  beforeEach(() => {
    state = sampleState();
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });
  const open = async (opts: TestClientOptions = {}, env: Record<string, string> = {}) => {
    t = await connectTestClient(await connect(env), era, opts);
    return t;
  };
  const call = async (
    name: string,
    args: Record<string, unknown>,
    opts?: TestClientOptions,
    env?: Record<string, string>,
  ) => {
    t ??= await open(opts, env);
    return (await t.client.callTool({ name, arguments: args })) as Result;
  };

  it('lists six tools; only create_invoice may write', async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).toEqual([
      'who_owes_me',
      'profit_and_loss',
      'find_invoices',
      'find_customers',
      'find_items',
      'create_invoice',
    ]);
    const writers = tools.filter((x) => x.annotations?.readOnlyHint === false).map((x) => x.name);
    expect(writers).toEqual(['create_invoice']);
  });

  it('says how to connect when it is not configured', async () => {
    const config = loadConfig(configSchema, { LOG_LEVEL: 'silent', PORTER_CONFIG_DIR: tmpdir() });
    t = await connectTestClient(
      serverFactory(
        createQuickBooksServer({ config, log: silentLogger, fetch: fakeQuickBooks(state) }),
        silentLogger,
      ),
      era,
    );
    const r = (await t.client.callTool({ name: 'who_owes_me', arguments: {} })) as Result;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not connected.*QUICKBOOKS_CLIENT_ID/s);
    expect(text(r)).toMatch(/porter-quickbooks auth/);
  });

  describe('who_owes_me', () => {
    it('groups open invoices by customer, most overdue first, with aging in exact cents', async () => {
      const r = await call('who_owes_me', {});
      const d = data(r);
      expect(d.asOf).toBe('2026-11-04');
      expect(d.totals).toEqual([
        {
          currency: 'USD',
          open: 1450.49,
          overdue: 1200.49,
          aging: { current: 250, days1to30: 600.5, days31to60: 0, days61to90: 500, over90: 99.99 },
          invoices: 6,
          customers: 4,
        },
      ]);
      expect(d.customers.map((c: { name: string }) => c.name)).toEqual([
        "Bill's Windsurf Shop",
        "Amy's Bird Sanctuary",
        'Cool Cars',
        'Smith Co',
      ]);
      const [bill, amy, cool, smith] = d.customers;
      expect(bill.note).toMatch(/unapplied payments or credits/);
      expect(amy).toMatchObject({
        email: 'birds@intuit.com',
        open: 750,
        overdue: 500,
        maxDaysOverdue: 65,
      });
      expect(amy.invoices[0]).toMatchObject({ number: '1001', daysOverdue: 65, emailed: true });
      expect(cool.maxDaysOverdue).toBe(126);
      expect(smith.open).toBe(0.3); // 0.1 + 0.2, not 0.30000000000000004
      expect(summaryLine(r)).toContain('$1,450.49 open');
      expect(summaryLine(r)).toContain("Most overdue: Bill's Windsurf Shop");
      expect(state.queries).toContain(
        "SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION 1 MAXRESULTS 1000",
      );
    });

    it('filters to long-overdue invoices', async () => {
      const d = data(await call('who_owes_me', { minDaysOverdue: 60 }));
      expect(d.customers.map((c: { id: string; open: number }) => [c.id, c.open])).toEqual([
        ['1', 500],
        ['3', 99.99],
      ]);
    });

    it('narrows to one customer by name', async () => {
      const d = data(await call('who_owes_me', { customer: 'amy' }));
      expect(d.customers).toHaveLength(1);
      expect(state.queries.at(-1)).toContain("CustomerRef = '1'");
    });
  });

  describe('profit_and_loss', () => {
    it('reads last month, with sub-accounts, and compares with the month before', async () => {
      const r = await call('profit_and_loss', {
        period: 'last_month',
        compareTo: 'previous_period',
      });
      const d = data(r);
      expect(d.period).toEqual({ start: '2026-10-01', end: '2026-10-31', label: 'last month' });
      expect(d.comparedWith).toMatchObject({ start: '2026-09-01', end: '2026-09-30' });
      expect(d.income.total).toBe(3727.5);
      expect(d.costOfGoodsSold.total).toBe(405);
      expect(d.expenses.total).toBe(1163.31);
      expect(d.expenses.lines[0]).toEqual({ account: 'Rent or Lease', amount: 900, previous: 900 });
      expect(d.expenses.lines.map((l: { account: string }) => l.account)).toContain(
        'Utilities › Gas and Electric',
      );
      expect(d.netIncome).toBe(2159.19);
      expect(d.previousNetIncome).toBe(600);
      expect(summaryLine(r)).toContain('net income $2,159.19');
      expect(summaryLine(r)).toMatch(/up 260%/);
    });

    it('reports no activity instead of zeros that look real', async () => {
      const r = await call('profit_and_loss', { period: 'this_month' });
      expect(data(r).noActivity).toBe(true);
      expect(summaryLine(r)).toContain(
        'No transactions recorded for this month to date (2026-11-01 to 2026-11-04)',
      );
    });

    it('rejects half a custom range', async () => {
      const r = await call('profit_and_loss', { start: '2026-01-01' });
      expect(r.isError).toBe(true);
    });
  });

  describe('find_invoices and lookups', () => {
    it('finds one invoice by number, with its lines and a cleaned memo', async () => {
      const d = data(await call('find_invoices', { number: '1002' }));
      expect(d.invoices).toHaveLength(1);
      expect(d.invoices[0]).toMatchObject({ status: 'open', balance: 250, dueDate: '2026-11-19' });
      expect(d.invoices[0].url).toBe('https://app.sandbox.qbo.intuit.com/app/invoice?txnId=102');
      expect(d.detail.lines).toEqual([
        { item: 'Design', description: 'Work', quantity: 1, rate: 250, amount: 250 },
      ]);
      expect(d.detail.memo).not.toContain('##');
    });

    it('filters by status', async () => {
      const overdue = data(await call('find_invoices', { status: 'overdue', limit: 50 }));
      expect(overdue.invoices.map((i: { number: string }) => i.number).sort()).toEqual([
        '1001',
        '1003',
        '1004',
        '1006',
        '1007',
      ]);
      const paid = data(await call('find_invoices', { status: 'paid' }));
      expect(paid.invoices.map((i: { number: string }) => i.number)).toEqual(['1005']);
      expect(
        overdue.invoices.find((i: { number: string }) => i.number === '1003').partiallyPaid,
      ).toBe(true);
    });

    it('rejects invoice numbers that could change the query', async () => {
      const r = await call('find_invoices', { number: "1' OR Balance > '0" });
      expect(r.isError).toBe(true);
      expect(state.calls.query).toBe(0);
    });

    it('matches customers loosely and lists both Smiths', async () => {
      const d = data(await call('find_customers', { query: 'smith' }));
      expect(d.customers.map((c: { name: string }) => c.name).sort()).toEqual([
        'Smith Co',
        'Smith Ltd',
      ]);
      const amy = data(await call('find_customers', { query: 'amy lauterbach' }));
      expect(amy.customers[0].id).toBe('1');
      const owing = data(await call('find_customers', { withBalanceOnly: true }));
      expect(owing.customers[0].name).toBe("Amy's Bird Sanctuary");
      expect(owing.total).toBe(4);
    });

    it('lists items without categories', async () => {
      const d = data(await call('find_items', {}));
      expect(d.items.map((i: { name: string }) => i.name)).toEqual([
        'Design',
        'Hours',
        'Pump',
        'Landscaping:Gardening',
      ]);
    });
  });

  describe('create_invoice', () => {
    const args = {
      customer: "amy's bird sanctuary",
      lines: [
        { item: 'Design', quantity: 3 },
        { item: 'pump', quantity: 2, rate: 20 },
      ],
      memo: 'Thank you for your business.',
    };

    it('without elicitation: previews with a token, creates on the confirmed call, once', async () => {
      const first = await call('create_invoice', args, {}, TOKEN_FALLBACK);
      expect(first.isError).toBeFalsy();
      const p = data(first);
      expect(p.status).toBe('preview');
      expect(p.preview.subtotal).toBe(265);
      expect(p.preview.lines.map((l: { amount: number }) => l.amount)).toEqual([225, 40]);
      expect(p.preview.customer).toEqual({
        id: '1',
        name: "Amy's Bird Sanctuary",
        email: 'birds@intuit.com',
      });
      expect(summaryLine(first)).toMatch(/^Preview only: nothing was created/);
      expect(state.calls.create).toBe(0);

      const second = data(
        await call('create_invoice', { ...args, confirmationToken: p.confirmationToken }),
      );
      expect(second.status).toBe('created');
      expect(second.invoice).toMatchObject({ number: '1101', total: 265, balance: 265 });
      expect(state.calls.create).toBe(1);
      const sent = state.invoices.at(-1)!;
      expect(sent.CustomerMemo).toEqual({ value: 'Thank you for your business.' });
      expect((sent.Line as unknown[]).length).toBe(2);

      // A retry with the same token reaches Intuit with the same requestid: no duplicate.
      const again = data(
        await call('create_invoice', { ...args, confirmationToken: p.confirmationToken }),
      );
      expect(again.invoice.id).toBe(second.invoice.id);
      expect(state.calls.create).toBe(1);
    });

    it('rejects a token used for a different invoice', async () => {
      const p = data(await call('create_invoice', args, {}, TOKEN_FALLBACK));
      const r = await call('create_invoice', {
        ...args,
        lines: [{ item: 'Design', quantity: 30 }],
        confirmationToken: p.confirmationToken,
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/does not match this invoice/);
      const forged = await call('create_invoice', { ...args, confirmationToken: 'confirmed' });
      expect(forged.isError).toBe(true);
      expect(state.calls.create).toBe(0);
    });

    it('asks the user through the client when it can, and creates on yes', async () => {
      const asked: string[] = [];
      const r = await call('create_invoice', args, {
        onElicit: (q) => {
          asked.push(q.message);
          return { action: 'accept', content: { confirm: true } };
        },
      });
      expect(data(r).status).toBe('created');
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("Amy's Bird Sanctuary");
      expect(asked[0]).toContain('Subtotal $265.00');
      expect(state.calls.create).toBe(1);
    });

    it('creates nothing when the user says no, even with a token', async () => {
      const r = await call(
        'create_invoice',
        { ...args, confirmationToken: 'anything' },
        { onElicit: () => ({ action: 'decline' }) },
      );
      expect(data(r).status).toBe('cancelled');
      expect(summaryLine(r)).toMatch(/did not approve/);
      expect(state.calls.create).toBe(0);
    });

    it('does not read a dismissed prompt as a no (headless clients cancel every prompt)', async () => {
      const r = await call('create_invoice', args, { onElicit: () => ({ action: 'cancel' }) });
      expect(data(r).status).toBe('cancelled');
      expect(summaryLine(r)).toMatch(/could not be shown.*do not retry on your own/);
      expect(state.calls.create).toBe(0);
    });

    it('refuses clients that cannot ask the user by default, and says how to opt in', async () => {
      const r = await call('create_invoice', args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Nothing was created: this client cannot ask the user/);
      expect(text(r)).toContain('QUICKBOOKS_REQUIRE_ELICITATION=false');
      expect(text(r)).not.toContain('confirmationToken"');
      expect(state.calls.create).toBe(0);
    });

    it('refuses by default even when the model sends a token', async () => {
      const r = await call('create_invoice', { ...args, confirmationToken: 'v1.x.y.z' });
      expect(r.isError).toBe(true);
      expect(state.calls.create).toBe(0);
    });

    it('describes the token flow only when the fallback is on', async () => {
      const describe = async (env: Record<string, string>) => {
        const c = await connectTestClient(await connect(env), era);
        const tools = await c.client.listTools();
        await c.close();
        return tools.tools.find((x) => x.name === 'create_invoice')!.description!;
      };
      const strict = await describe({});
      expect(strict).not.toMatch(/confirmationToken/);
      expect(strict).not.toMatch(/Amy|Design/);
      expect(await describe(TOKEN_FALLBACK)).toMatch(/confirmationToken/);
    });

    it('asks which customer when a name is ambiguous', async () => {
      const r = await call('create_invoice', { customer: 'Smith', lines: [{ item: 'Design' }] });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Smith Co [id:4]');
      expect(text(r)).toContain('Smith Ltd [id:5]');
    });

    it('needs a rate for an item without a price', async () => {
      const r = await call('create_invoice', {
        customer: '3',
        lines: [{ item: 'Hours', quantity: 2 }],
      });
      expect(text(r)).toMatch(/"Hours" has no default price/);
    });

    it('needs a tax code in a Canadian company, and passes it on every line', async () => {
      state.country = 'CA';
      state.currency = 'CAD';
      const r = await call(
        'create_invoice',
        { customer: '3', lines: [{ item: 'Design' }] },
        {},
        TOKEN_FALLBACK,
      );
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('HST ON [id:3]');
      const p = data(
        await call('create_invoice', {
          customer: '3',
          lines: [{ item: 'Design' }],
          taxCode: 'hst on',
        }),
      );
      expect(p.preview.taxCode).toEqual({ id: '3', name: 'HST ON' });
      const done = data(
        await call('create_invoice', {
          customer: '3',
          lines: [{ item: 'Design' }],
          taxCode: 'hst on',
          confirmationToken: p.confirmationToken,
        }),
      );
      expect(done.invoice).toMatchObject({ total: 84.75, tax: 9.75 });
    });

    it('shows QuickBooks validation errors to the model', async () => {
      state.items.push({ Id: '9', Name: 'Ghost', Type: 'Service', UnitPrice: 1, Active: true });
      const p = data(
        await call(
          'create_invoice',
          { customer: '3', lines: [{ item: 'Ghost' }] },
          {},
          TOKEN_FALLBACK,
        ),
      );
      state.items.pop();
      const r = await call('create_invoice', {
        customer: '3',
        lines: [{ item: '9' }],
        confirmationToken: p.confirmationToken,
      });
      // The item list was cached at preview time, so the request reaches QuickBooks and fails there.
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/QuickBooks rejected the request: Invalid Reference Id/);
    });
  });

  it('refreshes an expired access token and saves the rotated refresh token', async () => {
    await call('find_customers', {});
    expect(state.calls.token).toBe(1);
    state.expireAccessToken = true;
    const r = await call('find_items', {});
    expect(r.isError).toBeFalsy();
    expect(state.calls.token).toBe(2);
    const saved = await new TokenStore(dir, 'sandbox', CLIENT.secret).load();
    expect(saved?.refreshToken).toBe(state.refreshToken);
  });
});

describe('demo mode', () => {
  const demo = async (now: number) => {
    const config = loadConfig(configSchema, {
      QUICKBOOKS_ENVIRONMENT: 'demo',
      LOG_LEVEL: 'silent',
    });
    return connectTestClient(
      serverFactory(
        createQuickBooksServer({ config, log: silentLogger, now: () => now }),
        silentLogger,
      ),
      '2026',
    );
  };

  it('serves the sample company without credentials, and says it is a demo', async () => {
    const t = await demo(NOW);
    expect(t.client.getInstructions()).toContain('DEMO MODE');
    const r = (await t.client.callTool({ name: 'who_owes_me', arguments: {} })) as Result;
    expect(data(r).totals[0].open).toBe(1450.49);
    await t.close();
  });

  it('moves the sample dates to the current month', async () => {
    const t = await demo(Date.parse('2027-01-20T17:00:00Z'));
    const pnl = (await t.client.callTool({
      name: 'profit_and_loss',
      arguments: { period: 'last_month', compareTo: 'previous_period' },
    })) as Result;
    expect(data(pnl).period.start).toBe('2026-12-01');
    expect(data(pnl).netIncome).toBe(2159.19);
    const owed = data((await t.client.callTool({ name: 'who_owes_me', arguments: {} })) as Result);
    const amy = owed.customers.find((c: { id: string }) => c.id === '1');
    expect(amy.invoices[0].dueDate).toBe('2026-10-31'); // 2026-08-31 + 2 months
    await t.close();
  });
});
