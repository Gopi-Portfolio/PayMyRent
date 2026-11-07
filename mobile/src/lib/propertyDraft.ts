// The property details an owner typed before paying for its plan (kept in memory only; never stored on the phone's disk).
export type PropertyDraft = {
  name: string; address: string; city: string; state: string; pincode: string; kind: 'commercial' | 'residential' | 'mixed';
  proofType: 'property_tax' | 'sale_deed' | 'electricity_bill' | 'lease_deed'; proofRef: string; declare: boolean;
};
let draft: PropertyDraft | null = null;
export const getPropertyDraft = (): PropertyDraft | null => draft;
export const setPropertyDraft = (d: PropertyDraft | null): void => { draft = d; };
