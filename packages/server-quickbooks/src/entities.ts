import * as z from 'zod/v4';

/**
 * The fields we use from QuickBooks entities. Loose objects: QuickBooks sends many more
 * fields, and a new one appearing must not break parsing.
 */

const ref = z.looseObject({ value: z.string(), name: z.string().optional() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const customerSchema = z.looseObject({
  Id: z.string(),
  DisplayName: z.string(),
  CompanyName: z.string().optional(),
  GivenName: z.string().optional(),
  FamilyName: z.string().optional(),
  PrimaryEmailAddr: z.looseObject({ Address: z.string() }).optional(),
  PrimaryPhone: z.looseObject({ FreeFormNumber: z.string() }).optional(),
  /** Open balance across invoices, net of unapplied payments and credits. */
  Balance: z.number().default(0),
  Active: z.boolean().default(true),
  CurrencyRef: ref.optional(),
  Job: z.boolean().optional(),
  ParentRef: ref.optional(),
});
export type Customer = z.infer<typeof customerSchema>;

export const itemSchema = z.looseObject({
  Id: z.string(),
  Name: z.string(),
  FullyQualifiedName: z.string().optional(),
  Description: z.string().optional(),
  Sku: z.string().optional(),
  UnitPrice: z.number().optional(),
  /** Service, Inventory, NonInventory, Category, Group… */
  Type: z.string(),
  Active: z.boolean().default(true),
  Taxable: z.boolean().optional(),
  QtyOnHand: z.number().optional(),
});
export type Item = z.infer<typeof itemSchema>;

const salesLine = z.looseObject({
  Id: z.string().optional(),
  LineNum: z.number().optional(),
  Description: z.string().optional(),
  Amount: z.number(),
  DetailType: z.string(),
  SalesItemLineDetail: z
    .looseObject({
      ItemRef: ref.optional(),
      Qty: z.number().optional(),
      UnitPrice: z.number().optional(),
      TaxCodeRef: ref.optional(),
    })
    .optional(),
});

export const invoiceSchema = z.looseObject({
  Id: z.string(),
  DocNumber: z.string().optional(),
  TxnDate: date,
  DueDate: date.optional(),
  TotalAmt: z.number(),
  Balance: z.number(),
  CustomerRef: ref,
  CurrencyRef: ref.optional(),
  /** NotSet, NeedToSend, EmailSent. */
  EmailStatus: z.string().optional(),
  BillEmail: z.looseObject({ Address: z.string() }).optional(),
  CustomerMemo: z.looseObject({ value: z.string() }).optional(),
  PrivateNote: z.string().optional(),
  Line: z.array(salesLine).default([]),
  TxnTaxDetail: z.looseObject({ TotalTax: z.number().optional() }).optional(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const companyInfoSchema = z.looseObject({
  CompanyName: z.string(),
  /** Two-letter country of the company file: US, CA, GB, AU… */
  Country: z.string().optional(),
  FiscalYearStartMonth: z.string().optional(),
});
export type CompanyInfo = z.infer<typeof companyInfoSchema>;

export const preferencesSchema = z.looseObject({
  CurrencyPrefs: z.looseObject({ HomeCurrency: ref.optional() }).optional(),
});

export const taxCodeSchema = z.looseObject({
  Id: z.string(),
  Name: z.string(),
  Description: z.string().optional(),
  Active: z.boolean().default(true),
});
export type TaxCode = z.infer<typeof taxCodeSchema>;

export const termSchema = z.looseObject({
  Id: z.string(),
  Name: z.string(),
  DueDays: z.number().optional(),
  Active: z.boolean().default(true),
});
