import { describe, expect, it } from 'vitest';
import { parseProfitAndLoss } from './report.js';

const col = (value: string, id?: string) => (id ? { value, id } : { value });

describe('parseProfitAndLoss', () => {
  it('reads sections, nested sub-accounts and QuickBooks totals', () => {
    const p = parseProfitAndLoss({
      Header: {
        StartPeriod: '2026-10-01',
        EndPeriod: '2026-10-31',
        ReportBasis: 'Cash',
        Currency: 'CAD',
      },
      Rows: {
        Row: [
          {
            type: 'Section',
            group: 'Income',
            Header: { ColData: [col('Income'), col('')] },
            Rows: { Row: [{ type: 'Data', ColData: [col('Sales', '1'), col('1,000.50')] }] },
            Summary: { ColData: [col('Total Income'), col('1000.50')] },
          },
          {
            type: 'Section',
            group: 'Expenses',
            Header: { ColData: [col('Expenses'), col('')] },
            Rows: {
              Row: [
                {
                  type: 'Section',
                  // A parent with its own amount next to its children.
                  Header: { ColData: [col('Vehicle', '7'), col('10.00')] },
                  Rows: { Row: [{ type: 'Data', ColData: [col('Fuel', '8'), col('40.00')] }] },
                  Summary: { ColData: [col('Total Vehicle'), col('50.00')] },
                },
                { type: 'Data', ColData: [col('Empty', '9'), col('')] },
              ],
            },
            Summary: { ColData: [col('Total Expenses'), col('50.00')] },
          },
          {
            type: 'Section',
            group: 'NetIncome',
            Summary: { ColData: [col('Net Income'), col('950.50')] },
          },
        ],
      },
    });
    expect(p).toMatchObject({
      basis: 'Cash',
      currency: 'CAD',
      netIncome: 950.5,
      noActivity: false,
    });
    expect(p.income).toEqual({
      total: 1000.5,
      lines: [{ account: 'Sales', accountId: '1', amount: 1000.5 }],
    });
    expect(p.expenses.lines).toEqual([
      { account: 'Vehicle', accountId: '7', amount: 10 },
      { account: 'Vehicle › Fuel', accountId: '8', amount: 40 },
    ]);
    // Missing summaries are derived.
    expect(p.grossProfit).toBe(1000.5);
    expect(p.netOperatingIncome).toBe(950.5);
  });

  it('flags an empty report', () => {
    const p = parseProfitAndLoss({
      Header: { Option: [{ Name: 'NoReportData', Value: 'true' }] },
      Rows: {},
    });
    expect(p.noActivity).toBe(true);
    expect(p.netIncome).toBe(0);
  });

  it('fails clearly on a different shape', () => {
    expect(() => parseProfitAndLoss({ nope: 1 })).toThrow(/unexpected format/);
  });
});
