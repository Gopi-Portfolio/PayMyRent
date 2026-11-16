// What the screens show right after an entry is saved for later: the saved data is updated at once, so a unit that was just rented no longer
// offers itself as vacant (and cannot be given to a second renter by mistake), and a unit just added can be chosen. Each such change is marked
// `pending` so the screens can say "waiting to send". When the entry is really sent, the screens' data is fetched again and the marks are gone.
import { localId } from './outbox';
import { queryClient } from './queryClient';

type Page = { items?: any[] } & Record<string, unknown>;
const edit = (key: readonly unknown[], fn: (items: any[]) => any[]) =>
  queryClient.setQueryData<Page>(key, (old) => (old && Array.isArray(old.items) ? { ...old, items: fn(old.items) } : old));

/** A unit added offline: it can be chosen at once (with an id that stands for it until the server gives the real one). */
export function addPendingUnit(owner: string | null | undefined, opId: string, unit: { property_id: string; identifier: string; kind: string; floor: number | null }) {
  const row = { id: localId(opId), ...unit, status: 'active', vacant: true, tenancy_id: null, tenant_name: null, pending: true };
  edit(['units', owner, 'active'], (items) => [...items, row]);
  edit(['vacant', owner], (items) => [...items, row]);
}

/** A renter added offline: the unit shows as rented to them (waiting to send), and is no longer offered as vacant. */
export function markUnitRented(owner: string | null | undefined, unitId: string, renterName: string, opId: string) {
  edit(['units', owner, 'active'], (items) => items.map((u) => (u.id === unitId ? { ...u, vacant: false, tenancy_id: localId(opId), tenant_name: renterName, pending: true } : u)));
  edit(['vacant', owner], (items) => items.filter((u) => u.id !== unitId));
}
