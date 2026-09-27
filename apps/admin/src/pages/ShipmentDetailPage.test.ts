import { describe, expect, it } from 'vitest';
import { availableActions } from './ShipmentDetailPage';

describe('availableActions', () => {
  it('offers "plan" only for a DRAFT shipment (plus cancel)', () => {
    expect(availableActions('DRAFT', [])).toEqual(['plan', 'cancel']);
  });

  it('offers "dispatch" only for a PLANNED shipment (plus cancel)', () => {
    expect(availableActions('PLANNED', [])).toEqual(['dispatch', 'cancel']);
  });

  it('offers cancel for DISPATCHED and ACCEPTED too', () => {
    expect(availableActions('DISPATCHED', [])).toEqual(['cancel']);
    expect(availableActions('ACCEPTED', [])).toEqual(['cancel']);
  });

  it('offers no actions for IN_TRANSIT', () => {
    expect(availableActions('IN_TRANSIT', [])).toEqual([]);
  });

  it('offers no close action for COMPLETED without admin or planner role', () => {
    expect(availableActions('COMPLETED', [])).toEqual([]);
    expect(availableActions('COMPLETED', ['viewer'])).toEqual([]);
  });

  it('offers close for COMPLETED with the admin role', () => {
    expect(availableActions('COMPLETED', ['admin'])).toEqual(['close']);
  });

  it('offers close for COMPLETED with the planner role too (PO decision, not admin-only)', () => {
    expect(availableActions('COMPLETED', ['planner'])).toEqual(['close']);
  });

  it('offers the PDF action for CLOSED regardless of role', () => {
    expect(availableActions('CLOSED', [])).toEqual(['pdf']);
  });

  it('offers no actions for CANCELLED', () => {
    expect(availableActions('CANCELLED', ['admin'])).toEqual([]);
  });
});
