import { externalText } from '@abhijoshi23/porter-toolkit';
import { easternToEpoch } from './eastern.js';

export type Category = 'goods' | 'services' | 'construction' | 'services_related_to_goods';
export type Status = 'open' | 'expired' | 'cancelled';

export const CATEGORY_LABELS: Record<Category, string> = {
  goods: 'Goods',
  services: 'Services',
  construction: 'Construction',
  services_related_to_goods: 'Services related to goods',
};
const CATEGORY_CODES: Record<string, Category> = {
  GD: 'goods',
  SRV: 'services',
  CNST: 'construction',
  SRVTGD: 'services_related_to_goods',
};

export interface Code {
  code: string;
  description: string;
}

/** One tender notice, latest amendment. Text fields are raw publisher text: sanitize on output. */
export interface Notice {
  /** CanadaBuys reference number, e.g. `cb-586-68219268` or `MX-443841357513`. Unique. */
  id: string;
  /** The buyer's own number. Not unique: amendments and lots can share one. */
  solicitationNumber: string;
  title: string;
  status: Status;
  amendment: number;
  amendedOn: string | null;
  published: string;
  /** Closing time as published (Toronto wall time, see eastern.ts). */
  closesLocal: string;
  closesAt: number | null;
  contractStart: string | null;
  contractEnd: string | null;
  categories: Category[];
  noticeType: string;
  method: string;
  selectionCriteria: string;
  limitedTenderingReason: string;
  tradeAgreements: string[];
  regionsOfOpportunity: string[];
  regionsOfDelivery: string[];
  buyer: string;
  buyerCity: string;
  buyerProvince: string;
  endUsers: string[];
  contact: { name: string; email: string; phone: string };
  url: string | null;
  attachments: string[];
  gsin: Code[];
  unspsc: Code[];
  /** Raw description (may contain HTML entities and markup). */
  description: string;
  /** Sanitized, flattened description, for search. */
  plain: string;
}

/** Header names in the CanadaBuys tender CSVs (bilingual: `<eng>-<fra>`). */
const COL = {
  titleEn: 'title-titre-eng',
  titleFr: 'title-titre-fra',
  ref: 'referenceNumber-numeroReference',
  amendment: 'amendmentNumber-numeroModification',
  solicitation: 'solicitationNumber-numeroSollicitation',
  published: 'publicationDate-datePublication',
  closing: 'tenderClosingDate-appelOffresDateCloture',
  amendedOn: 'amendmentDate-dateModification',
  start: 'expectedContractStartDate-dateDebutContratPrevue',
  end: 'expectedContractEndDate-dateFinContratPrevue',
  status: 'tenderStatus-appelOffresStatut-eng',
  gsin: 'gsin-nibs',
  gsinDesc: 'gsinDescription-nibsDescription-eng',
  unspsc: 'unspsc',
  unspscDesc: 'unspscDescription-eng',
  category: 'procurementCategory-categorieApprovisionnement',
  noticeType: 'noticeType-avisType-eng',
  method: 'procurementMethod-methodeApprovisionnement-eng',
  selection: 'selectionCriteria-criteresSelection-eng',
  limited: 'limitedTenderingReason-raisonAppelOffresLimite-eng',
  trade: 'tradeAgreements-accordsCommerciaux-eng',
  opportunity: 'regionsOfOpportunity-regionAppelOffres-eng',
  delivery: 'regionsOfDelivery-regionsLivraison-eng',
  buyer: 'contractingEntityName-nomEntitContractante-eng',
  buyerFr: 'contractingEntityName-nomEntitContractante-fra',
  buyerCity: 'contractingEntityAddressCity-entiteContractanteAdresseVille-eng',
  buyerProvince: 'contractingEntityAddressProvince-entiteContractanteAdresseProvince-eng',
  endUsers: 'endUserEntitiesName-nomEntitesUtilisateurFinal-eng',
  contactName: 'contactInfoName-informationsContactNom',
  contactEmail: 'contactInfoEmail-informationsContactCourriel',
  contactPhone: 'contactInfoPhone-contactInfoTelephone',
  url: 'noticeURL-URLavis-eng',
  attachments: 'attachment-piecesJointes-eng',
  descEn: 'tenderDescription-descriptionAppelOffres-eng',
  descFr: 'tenderDescription-descriptionAppelOffres-fra',
} as const;

/** The columns a file must have for us to trust it (an HTML error page has none). */
export const REQUIRED_COLUMNS = [COL.ref, COL.titleEn, COL.closing, COL.status];

/** Multi-value cells are newline-separated, each value prefixed with `*`: `*GD\n*SRV`. */
export function multi(cell: string | undefined): string[] {
  if (!cell) return [];
  return cell
    .split('\n')
    .map((v) => v.trim().replace(/^\*/, '').trim())
    .filter(Boolean);
}

function codes(codeCell: string | undefined, descCell: string | undefined): Code[] {
  const cs = multi(codeCell);
  const ds = multi(descCell);
  return cs.map((code, i) => ({ code, description: ds[i] ?? '' }));
}

/** Only absolute http(s) links reach the model; anything else (javascript:, relative) is dropped. */
export function safeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function status(raw: string | undefined): Status {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'open') return 'open';
  if (s.startsWith('cancel')) return 'cancelled';
  return 'expired';
}

/**
 * Notices published on CanadaBuys itself (`cb-…`) have an empty URL column; their page
 * is at a fixed path. Others (MERX, SAP Business Network) always carry their own URL.
 */
function canadaBuysUrl(id: string): string | null {
  return /^cb-\d+-\d+$/i.test(id)
    ? `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${id}`
    : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (s: string | undefined) => (s && DATE.test(s.trim()) ? s.trim() : null);

/** One CSV record → Notice, or null when it has no reference number. */
export function toNotice(r: Record<string, string>): Notice | null {
  const id = r[COL.ref]?.trim();
  if (!id) return null;
  const description = r[COL.descEn] || r[COL.descFr] || '';
  const closesLocal = (r[COL.closing] ?? '').trim();
  return {
    id,
    solicitationNumber: (r[COL.solicitation] ?? '').trim(),
    title: (r[COL.titleEn] || r[COL.titleFr] || '').trim(),
    status: status(r[COL.status]),
    amendment: Number.parseInt(r[COL.amendment] ?? '', 10) || 0,
    amendedOn: date(r[COL.amendedOn]),
    published: date(r[COL.published]) ?? '',
    closesLocal,
    closesAt: easternToEpoch(closesLocal),
    contractStart: date(r[COL.start]),
    contractEnd: date(r[COL.end]),
    categories: [
      ...new Set(
        multi(r[COL.category])
          .map((c) => CATEGORY_CODES[c])
          .filter((c): c is Category => !!c),
      ),
    ],
    noticeType: (r[COL.noticeType] ?? '').trim(),
    method: (r[COL.method] ?? '').trim(),
    selectionCriteria: (r[COL.selection] ?? '').trim(),
    limitedTenderingReason: (r[COL.limited] ?? '').trim(),
    tradeAgreements: multi(r[COL.trade]),
    regionsOfOpportunity: multi(r[COL.opportunity]),
    regionsOfDelivery: multi(r[COL.delivery]),
    buyer: (r[COL.buyer] || r[COL.buyerFr] || '').trim(),
    buyerCity: (r[COL.buyerCity] ?? '').trim(),
    buyerProvince: (r[COL.buyerProvince] ?? '').trim(),
    endUsers: multi(r[COL.endUsers]),
    contact: {
      name: (r[COL.contactName] ?? '').trim(),
      email: (r[COL.contactEmail] ?? '').trim(),
      phone: (r[COL.contactPhone] ?? '').trim(),
    },
    url: safeUrl(r[COL.url]) ?? canadaBuysUrl(id),
    attachments: (r[COL.attachments] ?? '')
      .split(/[,\n]/)
      .map((u) => safeUrl(u))
      .filter((u): u is string => !!u),
    gsin: codes(r[COL.gsin], r[COL.gsinDesc]),
    unspsc: codes(r[COL.unspsc], r[COL.unspscDesc]),
    description,
    plain: externalText(description, 20_000),
  };
}
